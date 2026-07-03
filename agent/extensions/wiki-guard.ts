/**
 * Wiki Guard — deterministic retrieval for the sysadmin wiki (~/.pi/wiki).
 *
 * Prompt rules alone proved unreliable (the model answers sysadmin questions
 * from memory and hallucinates commands), so this enforces lookup:
 *
 * 1. before_agent_start: if the user prompt matches a wiki topic, the matching
 *    page(s) are injected into context automatically — no model cooperation
 *    needed.
 * 2. tool_call: if a bash command or file path touches wiki territory whose
 *    page is not yet in context (topic surfaced mid-task), the call is blocked
 *    once with a pointer to the exact page. Same deterministic-nudge pattern
 *    as write-guard.
 *
 * Reading a page (read tool or bash on ~/.pi/wiki) or having it injected marks
 * it provided for the rest of the session. Max 2 blocks per page, then give up
 * so a stubborn loop can never wedge.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WIKI_DIR = path.join(os.homedir(), ".pi", "wiki");

const TOPICS: { page: string; pattern: RegExp }[] = [
	{
		page: "fedora-atomic.md",
		pattern:
			/\b(rpm-ostree|ostree|kinoite|silverblue|fedora atomic|toolbox|flatpak|layered|apply-live)\b/i,
	},
	{
		page: "nixos.md",
		pattern:
			/\b(nixos|nixos-rebuild|configuration\.nix|nix-collect-garbage|nix-env|nix profile|nix-shell)\b|\/nix\/store/i,
	},
	{
		page: "systemd.md",
		pattern:
			/\b(systemd|systemctl|journalctl|coredumpctl|systemd-analyze|systemd-escape|oncalendar)\b|\S+\.(service|timer|mount|device|socket)\b|\/etc\/systemd/i,
	},
	{
		page: "kde.md",
		pattern:
			/\b(kde|plasma\w*|kwin\w*|kwriteconfig\d?|kreadconfig\d?|sddm|kscreenlocker\w*|kglobalshortcuts\w*|kdeglobals|dolphinrc|konsolerc|powerdevil)\b|\.config\/k\w+rc/i,
	},
	{
		page: "leftoverburrito.md",
		pattern:
			/\b(llama-server|llama\.cpp|ollama|prometheus|grafana|gpu[-_ ]exporter|podman|tailscale|leftoverburrito|nvidia|qwen)\b|localhost:(8080|9090|3000|9836)/i,
	},
];

function matchedPages(text: string): string[] {
	return TOPICS.filter((t) => t.pattern.test(text)).map((t) => t.page);
}

function readPage(page: string): string | null {
	try {
		return fs.readFileSync(path.join(WIKI_DIR, page), "utf-8");
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	const provided = new Set<string>();
	const blockCount = new Map<string, number>();

	pi.on("session_start", async () => {
		provided.clear();
		blockCount.clear();
	});

	// 1. Auto-inject pages matching the user prompt.
	pi.on("before_agent_start", async (event) => {
		const pages = matchedPages(event.prompt).filter(
			(p) => !provided.has(p) && readPage(p) !== null,
		);
		if (pages.length === 0) return undefined;

		const sections = pages.map(
			(p) => `=== ~/.pi/wiki/${p} ===\n${readPage(p)}`,
		);
		for (const p of pages) provided.add(p);

		return {
			message: {
				customType: "wiki-guard",
				display: false,
				content:
					"[wiki-guard] Auto-retrieved sysadmin wiki pages relevant to this request. " +
					"They are authoritative for this machine — prefer them over memory.\n\n" +
					sections.join("\n\n") +
					"\n\n(More pages: ~/.pi/wiki/index.md)",
			},
		};
	});

	// 2. Guard tool calls whose topic surfaced mid-task.
	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as { command?: string; path?: string };
		let text: string | undefined;
		if (event.toolName === "bash") text = input.command;
		else if (["read", "edit", "write"].includes(event.toolName)) text = input.path;
		if (!text) return undefined;

		// Anything referencing the wiki itself is a lookup: mark pages provided, never block.
		if (text.includes(".pi/wiki")) {
			for (const t of TOPICS) if (text.includes(t.page)) provided.add(t.page);
			if (/index\.md|wiki\/?$/.test(text)) {
				// reading the index counts as knowing where everything is
				for (const t of TOPICS) provided.add(t.page);
			}
			return undefined;
		}

		const pending = matchedPages(text).filter(
			(p) => !provided.has(p) && readPage(p) !== null,
		);
		if (pending.length === 0) return undefined;

		const blockable = pending.filter((p) => (blockCount.get(p) ?? 0) < 2);
		if (blockable.length === 0) {
			for (const p of pending) provided.add(p); // give up, don't wedge
			return undefined;
		}
		for (const p of blockable) blockCount.set(p, (blockCount.get(p) ?? 0) + 1);

		const list = blockable.map((p) => `~/.pi/wiki/${p}`).join(" and ");
		return {
			block: true,
			reason:
				`Blocked (wiki-guard): this touches a topic covered by the sysadmin wiki. ` +
				`Read ${list} first — it holds the authoritative, machine-specific facts ` +
				`(commands, paths, unit names) — then retry this call.`,
		};
	});
}
