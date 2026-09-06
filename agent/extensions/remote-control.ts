/**
 * Remote Control Extension
 *
 * Mirrors this pi session to a pi-server instance (web monitoring UI) and
 * accepts remote input — similar to Claude Code's remote control.
 *
 * Configuration — <config dir>/remote-control.json (config dir is
 * $PI_CODING_AGENT_DIR or ~/.pi/agent, so the file syncs with pi-config):
 *   { "url": "ws://omv:7737", "name": "optional-host-label" }
 * Environment overrides:
 *   PI_REMOTE_URL   overrides "url" (e.g. "ws://omv:7737" or http://…);
 *                   "/ws/agent" is appended automatically.
 *   PI_REMOTE_NAME  overrides "name" (defaults to os.hostname()).
 * With no url configured anywhere, the extension is inert.
 *
 * Behavior:
 * - Registers the session (host, cwd, name, model) and uploads a transcript
 *   backlog so the web UI can show history when it connects mid-session.
 * - Streams live events: user/assistant messages, streaming deltas (throttled),
 *   tool calls with results, and working/idle status.
 * - Remote input is injected with pi.sendUserMessage() ("steer" while the
 *   agent is streaming); remote abort calls ctx.abort().
 * - UI dialogs (ctx.ui.select/confirm/input — including permission prompts
 *   from auto-permission.ts) are mirrored to the server as "prompt" events.
 *   The remote answer races the local dialog; whichever side answers first
 *   wins and the other is dismissed via the dialog AbortSignal.
 * - The available model list is published in session meta; a remote
 *   "set_model" switches the active model via pi.setModel().
 * - Fails soft: if the server is unreachable it retries with backoff and never
 *   affects the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

// ── config / caps ──────────────────────────────────────────────────────────

function fileConfig(): { url?: string; name?: string; tokenFile?: string } {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "remote-control.json"), "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {}; // missing or malformed config file — stay inert
	}
}

/** Connection token authenticating this machine to pi-server. Never stored in
 *  pi-config (the repo is public): PI_REMOTE_TOKEN env, or the file named by
 *  config "tokenFile", or ~/.config/pi-remote/token. */
function connectionToken(): string | undefined {
	const env = process.env.PI_REMOTE_TOKEN?.trim();
	if (env) return env;
	const file =
		(typeof CONFIG.tokenFile === "string" && CONFIG.tokenFile.trim().replace(/^~(?=\/)/, homedir())) ||
		join(homedir(), ".config", "pi-remote", "token");
	try {
		return readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined; // server may not require one (dev mode)
	}
}

const CONFIG = fileConfig();
const RAW_URL = process.env.PI_REMOTE_URL?.trim() || (typeof CONFIG.url === "string" ? CONFIG.url.trim() : undefined);
const HOST_LABEL =
	process.env.PI_REMOTE_NAME?.trim() ||
	(typeof CONFIG.name === "string" && CONFIG.name.trim()) ||
	hostname();

const PARTIAL_THROTTLE_MS = 150;
const BACKLOG_MAX_ENTRIES = 400;
const MAX_TEXT = 32_000;
const MAX_THINKING = 8_000;
const MAX_TOOL_OUTPUT = 8_000;
const MAX_ARG_STRING = 2_000;
const MAX_PROMPT_TITLE = 4_000;
const MAX_MODELS = 200;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function serverUrl(): string | undefined {
	if (!RAW_URL) return undefined;
	let url = RAW_URL.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
	if (!/^wss?:\/\//.test(url)) url = `ws://${url}`;
	url = url.replace(/\/+$/, "");
	if (!url.endsWith("/ws/agent")) url += "/ws/agent";
	return url;
}

// ── truncation helpers ─────────────────────────────────────────────────────

function trunc(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.8);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[${text.length - max} chars truncated]…\n${text.slice(-tail)}`;
}

function truncArgs(args: unknown): unknown {
	if (typeof args === "string") return trunc(args, MAX_ARG_STRING);
	if (Array.isArray(args)) return args.map(truncArgs);
	if (args && typeof args === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = truncArgs(v);
		return out;
	}
	return args;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			const block = c as { type?: string; text?: string };
			if (block?.type === "text" && typeof block.text === "string") return block.text;
			if (block?.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function thinkingOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => {
			const block = c as { type?: string; thinking?: string };
			return block?.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "";
		})
		.filter(Boolean)
		.join("\n");
}

// ── event construction ─────────────────────────────────────────────────────

type RemoteEvent = Record<string, unknown> & { kind: string };

function assistantEvent(message: {
	content: unknown;
	timestamp?: number;
	stopReason?: string;
	errorMessage?: string;
}): RemoteEvent {
	return {
		kind: "assistant",
		text: trunc(textOf(message.content), MAX_TEXT),
		thinking: trunc(thinkingOf(message.content), MAX_THINKING),
		error:
			message.stopReason === "error" || message.stopReason === "aborted"
				? message.errorMessage || `[${message.stopReason}]`
				: undefined,
		ts: message.timestamp ?? Date.now(),
	};
}

function toolResultText(result: unknown): string {
	const r = result as { content?: unknown; output?: unknown } | string | undefined;
	if (typeof r === "string") return r;
	if (r && typeof r === "object") {
		const fromContent = textOf(r.content);
		if (fromContent) return fromContent;
		if (typeof r.output === "string") return r.output;
	}
	return "";
}

/** Convert persisted session entries into remote transcript events. */
function buildBacklog(ctx: ExtensionContext): RemoteEvent[] {
	const sm = ctx.sessionManager as unknown as {
		getBranch?: () => unknown[];
		getEntries: () => unknown[];
	};
	let entries: unknown[] = [];
	try {
		entries = sm.getBranch?.() ?? sm.getEntries();
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];
	entries = entries.slice(-BACKLOG_MAX_ENTRIES);

	const events: RemoteEvent[] = [];
	for (const raw of entries) {
		const entry = raw as { type?: string; message?: Record<string, unknown> };
		if (entry?.type !== "message" || !entry.message) continue;
		const m = entry.message;
		const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();

		switch (m.role) {
			case "user":
				events.push({ kind: "user", text: trunc(textOf(m.content), MAX_TEXT), ts });
				break;
			case "assistant": {
				const ev = assistantEvent(m as { content: unknown; timestamp?: number; stopReason?: string; errorMessage?: string });
				if (ev.text || ev.thinking || ev.error) events.push(ev);
				if (Array.isArray(m.content)) {
					for (const block of m.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
						if (block?.type === "toolCall") {
							events.push({
								kind: "tool_start",
								callId: block.id,
								name: block.name,
								args: truncArgs(block.arguments),
								ts,
							});
						}
					}
				}
				break;
			}
			case "toolResult":
				events.push({
					kind: "tool_end",
					callId: m.toolCallId,
					name: m.toolName,
					output: trunc(textOf(m.content), MAX_TOOL_OUTPUT),
					isError: m.isError === true,
					ts,
				});
				break;
			case "bashExecution":
				events.push({
					kind: "bash",
					command: trunc(String(m.command ?? ""), MAX_ARG_STRING),
					output: trunc(String(m.output ?? ""), MAX_TOOL_OUTPUT),
					exitCode: m.exitCode,
					ts,
				});
				break;
			case "custom":
				if (m.display === true) {
					const text = textOf(m.content);
					if (text) events.push({ kind: "custom", text: trunc(text, MAX_TEXT), ts });
				}
				break;
			case "compactionSummary":
				events.push({ kind: "custom", text: "[session compacted]", ts });
				break;
		}
	}
	return events;
}

// ── extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	const url = serverUrl();
	if (!url) return; // PI_REMOTE_URL not set — stay inert

	let ctx: ExtensionContext | undefined;
	let ws: WebSocket | undefined;
	let connected = false;
	let enabled = true; // /rc on|off (session-scoped)
	let shuttingDown = false;
	let backoff = RECONNECT_MIN_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	let pendingPartial: RemoteEvent | undefined;
	let partialTimer: ReturnType<typeof setTimeout> | undefined;
	/** Messages sent from the web UI, already echoed to it, awaiting delivery
	 *  into the session (a steered message is only consumed when the current
	 *  turn takes its next step — that can be minutes on a long tool call). */
	const remoteSent: { id: string; text: string }[] = [];
	let remoteSeq = 0;

	// qa.ts's `ask` tool builds a bespoke TUI component (ctx.ui.custom), which
	// the select/confirm/input wrappers below cannot see, so it publishes its
	// question here instead. Same race: whoever answers first wins.
	pi.events.on("rc:ask", (data) => {
		const d = data as
			| { id?: string; question?: string; options?: { label?: string; description?: string }[] }
			| undefined;
		if (!d || typeof d.id !== "string" || !d.id) return;
		const options = (d.options ?? [])
			.map((o) => (typeof o?.label === "string" ? o.label : ""))
			.filter(Boolean);
		const event: RemoteEvent = {
			kind: "prompt",
			promptId: d.id,
			promptType: "ask", // options plus a free-text answer
			title: trunc(String(d.question ?? "Question"), MAX_PROMPT_TITLE),
			options,
			descriptions: (d.options ?? []).map((o) => (typeof o?.description === "string" ? o.description : "")),
			ts: Date.now(),
		};
		openPrompts.set(d.id, {
			event,
			kind: "ask",
			options,
			settle: (value) => {
				// no mirrorDialog wrapper here, so close the card ourselves
				openPrompts.delete(d.id!);
				sendEvent({
					kind: "prompt_resolved",
					promptId: d.id,
					answer: value ?? null,
					source: "remote",
					ts: Date.now(),
				});
				pi.events.emit("rc:ask:answer", { id: d.id, answer: value ?? null });
			},
		});
		sendEvent(event);
	});

	// answered in the terminal (or cancelled) — close the card in the browser
	pi.events.on("rc:ask:close", (data) => {
		const d = data as { id?: string; answer?: unknown } | undefined;
		if (!d || typeof d.id !== "string" || !openPrompts.has(d.id)) return;
		openPrompts.delete(d.id);
		sendEvent({
			kind: "prompt_resolved",
			promptId: d.id,
			answer: d.answer ?? null,
			source: "local",
			ts: Date.now(),
		});
	});

	// permission mode published by auto-permission.ts (see its "autoperm:mode")
	let permMode: string | undefined;
	pi.events.on("autoperm:mode", (data) => {
		const next = (data as { mode?: string } | undefined)?.mode;
		if (typeof next !== "string" || next === permMode) return;
		permMode = next;
		wsSend({ type: "meta", meta: { permMode } });
	});

	// ── dialog mirroring state ───────────────────────────────────────────────

	type DialogKind = "select" | "confirm" | "input" | "ask";
	interface OpenPrompt {
		event: RemoteEvent; // re-sent on reconnect so a fresh UI sees open prompts
		kind: DialogKind;
		options?: string[];
		settle: (value: string | boolean | undefined) => void;
	}
	const openPrompts = new Map<string, OpenPrompt>();
	let promptSeq = 0;
	const UI_PATCHED = Symbol.for("pi-remote-control.uiPatched");

	function sessionKey(): string {
		let id = "unknown";
		try {
			id = ctx?.sessionManager.getSessionId() ?? "unknown";
		} catch {
			/* session id unavailable */
		}
		return `${HOST_LABEL}:${id}`;
	}

	function wsSend(obj: unknown): void {
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify(obj));
			} catch {
				/* drop — backlog resync covers gaps */
			}
		}
	}

	function sendEvent(event: RemoteEvent): void {
		wsSend({ type: "event", event });
	}

	/** Broadcast connection state on the extension event bus; the custom footer
	 *  in auto-permission.ts renders it inline as "rc" on the model line. */
	function updateStatusIndicator(): void {
		try {
			pi.events.emit("rc:status", { connected });
		} catch {
			// the pi ctx goes stale during shutdown/reload/session replacement and
			// emit then throws; a ws close landing in that window must not crash pi
		}
	}

	/** Session-usable models for the web UI's model picker. */
	function modelsMeta(c: ExtensionContext): { provider: string; id: string; name?: string }[] {
		try {
			const scoped = c.scopedModels;
			const models = scoped && scoped.length ? scoped.map((s) => s.model) : c.modelRegistry.getAvailable();
			return models.slice(0, MAX_MODELS).map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
		} catch {
			return [];
		}
	}

	function register(): void {
		if (!ctx) return;
		wsSend({
			type: "register",
			key: sessionKey(),
			meta: {
				sessionId: (() => {
					try {
						return ctx?.sessionManager.getSessionId();
					} catch {
						return undefined;
					}
				})(),
				host: HOST_LABEL,
				cwd: ctx.cwd,
				name: pi.getSessionName(),
				model: ctx.model?.id,
				modelProvider: ctx.model?.provider,
				models: modelsMeta(ctx),
				permMode,
				startedAt: Date.now(),
				pid: process.pid,
			},
		});
		wsSend({ type: "backlog", events: buildBacklog(ctx) });
		// backlog replaces the server-side buffer, so re-announce dialogs that
		// are still waiting for an answer
		for (const p of openPrompts.values()) sendEvent(p.event);
		sendEvent({ kind: "status", state: ctx.isIdle() ? "idle" : "working" });
	}

	function connect(): void {
		if (shuttingDown || !enabled || (ws && ws.readyState <= WebSocket.OPEN)) return;
		try {
			// token goes only on the wire — `url` stays clean for display/notify
			const token = connectionToken();
			ws = new WebSocket(token ? `${url}?token=${encodeURIComponent(token)}` : url!);
		} catch {
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			connected = true;
			backoff = RECONNECT_MIN_MS;
			register();
			updateStatusIndicator();
		};

		ws.onmessage = (event: MessageEvent) => {
			handleServerMessage(String(event.data));
		};

		ws.onclose = () => {
			connected = false;
			ws = undefined;
			updateStatusIndicator();
			scheduleReconnect();
		};

		ws.onerror = () => {
			/* onclose follows and handles reconnect */
		};
	}

	function scheduleReconnect(): void {
		if (shuttingDown || !enabled || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, backoff);
		backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
	}

	// ── dialog mirroring ─────────────────────────────────────────────────────
	// ctx.ui resolves to one shared UI context object for all extensions, so
	// wrapping select/confirm/input here also mirrors dialogs opened by other
	// extensions (e.g. auto-permission's permission prompt).

	function patchUi(ui: ExtensionContext["ui"]): void {
		const u = ui as unknown as Record<PropertyKey, unknown>;
		if (!u || u[UI_PATCHED]) return;
		u[UI_PATCHED] = true;
		for (const kind of ["select", "confirm", "input"] as const) {
			const original = (u[kind] as (...a: unknown[]) => Promise<unknown>).bind(ui);
			u[kind] = (...args: unknown[]) => mirrorDialog(kind, original, args);
		}
	}

	async function mirrorDialog(
		kind: DialogKind,
		original: (...a: unknown[]) => Promise<unknown>,
		args: unknown[],
	): Promise<unknown> {
		if (!enabled) return original(...args);

		const title = typeof args[0] === "string" ? args[0] : "";
		const options = kind === "select" && Array.isArray(args[1]) ? (args[1] as string[]) : undefined;
		// second arg is the message (confirm) / placeholder (input); third is opts
		const extra = kind !== "select" && typeof args[1] === "string" ? (args[1] as string) : undefined;
		const callerOpts = (args[2] ?? {}) as { signal?: AbortSignal };

		const promptId = `p${Date.now().toString(36)}-${++promptSeq}`;
		const controller = new AbortController();
		if (callerOpts.signal) {
			if (callerOpts.signal.aborted) controller.abort();
			else callerOpts.signal.addEventListener("abort", () => controller.abort(), { once: true });
		}

		const promptEvent: RemoteEvent = {
			kind: "prompt",
			promptId,
			promptType: kind,
			title: trunc(title, MAX_PROMPT_TITLE),
			detail: extra ? trunc(extra, MAX_ARG_STRING) : undefined,
			options,
			ts: Date.now(),
		};

		let remoteSettle!: (value: string | boolean | undefined) => void;
		const remoteAnswer = new Promise<{ source: "remote"; value: unknown }>((resolve) => {
			remoteSettle = (value) => resolve({ source: "remote", value });
		});
		openPrompts.set(promptId, { event: promptEvent, kind, options, settle: remoteSettle });
		sendEvent(promptEvent);

		const localArgs = [...args];
		localArgs[2] = { ...callerOpts, signal: controller.signal };

		try {
			const winner = await Promise.race([
				original(...localArgs).then((value) => ({ source: "local" as const, value })),
				remoteAnswer,
			]);
			if (winner.source === "remote") {
				controller.abort(); // dismiss the local dialog
				try {
					ctx?.ui.notify(`Answered remotely: ${String(winner.value)}`, "info");
				} catch {
					/* no UI */
				}
			}
			sendEvent({
				kind: "prompt_resolved",
				promptId,
				answer: winner.value === undefined ? null : winner.value,
				source: winner.source,
				ts: Date.now(),
			});
			return winner.value;
		} finally {
			openPrompts.delete(promptId);
		}
	}

	/**
	 * Deliver a message from the web UI into the session.
	 *
	 * pi's prompt() throws "Agent is already processing" if a message arrives
	 * while the agent is streaming without a delivery mode, and sendUserMessage
	 * is fire-and-forget (void return, async body), so that rejection cannot be
	 * caught by the caller — the message just vanishes. Passing deliverAs is
	 * ignored when the agent is idle, so always pass it: that removes the race
	 * between checking idleness and sending, which is exactly the window a
	 * thinking agent sits in.
	 */
	function deliverRemoteInput(text: string): void {
		const id = `r${Date.now().toString(36)}-${++remoteSeq}`;
		remoteSent.push({ id, text });
		if (remoteSent.length > 10) remoteSent.shift();

		let busy = false;
		try {
			busy = ctx ? !ctx.isIdle() : false;
		} catch {
			// stale ctx — assume busy; "steer" is delivered either way
			busy = true;
		}

		// Echo straight back so the sender sees the message land immediately.
		// Without this it stays invisible until the agent consumes it, which
		// looks exactly like the message having been dropped.
		sendEvent({ kind: "user", text: trunc(text, MAX_TEXT), via: "remote", msgId: id, queued: busy, ts: Date.now() });

		const fail = (why: string) => {
			const idx = remoteSent.findIndex((r) => r.id === id);
			if (idx >= 0) remoteSent.splice(idx, 1);
			sendEvent({ kind: "custom", text: `[remote] message not delivered: ${why}`, ts: Date.now() });
		};

		// "steer" reaches the agent at the next step of the current turn;
		// "followUp" would wait for the whole turn to finish.
		try {
			const result = pi.sendUserMessage(text, { deliverAs: "steer" }) as unknown;
			// typed void, but reject asynchronously in practice — catch either way
			if (result && typeof (result as Promise<unknown>).catch === "function") {
				(result as Promise<unknown>).catch((err: unknown) => {
					fail(err instanceof Error ? err.message : String(err));
				});
			}
		} catch (err) {
			fail(err instanceof Error ? err.message : String(err));
		}
	}

	function handleRespond(promptId: string, value: unknown): void {
		const p = openPrompts.get(promptId);
		if (!p) return;
		if (value === null || value === undefined) {
			// dismissed from the web UI
			p.settle(p.kind === "confirm" ? false : undefined);
			return;
		}
		if (p.kind === "ask") {
			// the ask tool accepts a listed option or a typed answer
			if (typeof value === "string" && value.trim()) p.settle(value.trim());
		} else if (p.kind === "select") {
			if (typeof value === "string" && p.options?.includes(value)) p.settle(value);
			else if (typeof value === "number" && p.options && typeof p.options[value] === "string") p.settle(p.options[value]);
		} else if (p.kind === "confirm") {
			if (typeof value === "boolean") p.settle(value);
		} else if (typeof value === "string") {
			p.settle(value);
		}
	}

	function handleSetModel(provider: string, modelId: string): void {
		const model = ctx?.modelRegistry.find(provider, modelId);
		if (!model) {
			sendEvent({ kind: "custom", text: `[remote] model not found: ${provider}/${modelId}`, ts: Date.now() });
			return;
		}
		pi.setModel(model)
			.then((ok) => {
				if (ok) {
					// model_select also fires, but make sure the picker reflects reality
					wsSend({ type: "meta", meta: { model: model.id, modelProvider: model.provider } });
				} else {
					sendEvent({ kind: "custom", text: `[remote] cannot switch to ${model.id}: no API key`, ts: Date.now() });
				}
			})
			.catch(() => {
				sendEvent({ kind: "custom", text: `[remote] model switch to ${model.id} failed`, ts: Date.now() });
			});
	}

	function handleServerMessage(raw: string): void {
		let msg: {
			type?: string;
			text?: string;
			promptId?: string;
			value?: unknown;
			provider?: string;
			modelId?: string;
			mode?: string;
		};
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.type === "respond" && typeof msg.promptId === "string") {
			handleRespond(msg.promptId, msg.value);
			return;
		}

		if (msg.type === "set_model" && typeof msg.provider === "string" && typeof msg.modelId === "string") {
			handleSetModel(msg.provider, msg.modelId);
			return;
		}

		if (msg.type === "set_mode" && typeof msg.mode === "string") {
			// auto-permission.ts owns the mode; it answers on "autoperm:mode"
			try {
				pi.events.emit("autoperm:set", { mode: msg.mode });
			} catch {
				/* stale ctx */
			}
			return;
		}

		if (msg.type === "input" && typeof msg.text === "string" && msg.text.trim()) {
			deliverRemoteInput(msg.text.trim());
			return;
		}

		if (msg.type === "abort") {
			try {
				ctx?.abort();
			} catch {
				/* nothing running */
			}
		}
	}

	function flushPartial(): void {
		if (pendingPartial) {
			sendEvent(pendingPartial);
			pendingPartial = undefined;
		}
	}

	// ── pi event wiring ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, eventCtx) => {
		ctx = eventCtx;
		patchUi(eventCtx.ui);
		if (ws && ws.readyState === WebSocket.OPEN) {
			// same process, new/resumed/forked session: re-register under new key
			register();
		} else {
			connect();
		}
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (partialTimer) clearTimeout(partialTimer);
		try {
			ws?.close();
		} catch {
			/* already closed */
		}
	});

	pi.on("agent_start", async (_event, eventCtx) => {
		ctx = eventCtx;
		patchUi(eventCtx.ui); // ui context can be swapped after startup — re-check
		sendEvent({ kind: "status", state: "working" });
	});

	pi.on("agent_settled", async (_event, eventCtx) => {
		ctx = eventCtx;
		sendEvent({ kind: "status", state: "idle" });
	});

	pi.on("message_end", async (event, eventCtx) => {
		ctx = eventCtx;
		const message = event.message as {
			role?: string;
			content?: unknown;
			timestamp?: number;
			stopReason?: string;
			errorMessage?: string;
		};

		if (message.role === "user") {
			const text = textOf(message.content);
			const remoteIdx = remoteSent.findIndex((r) => r.text === text);
			if (remoteIdx >= 0) {
				// already echoed when it was accepted — just clear the "queued"
				// marker now that the agent has actually taken it
				const [entry] = remoteSent.splice(remoteIdx, 1);
				sendEvent({ kind: "user_delivered", msgId: entry.id, ts: message.timestamp ?? Date.now() });
			} else {
				sendEvent({ kind: "user", text: trunc(text, MAX_TEXT), ts: message.timestamp ?? Date.now() });
			}
		} else if (message.role === "assistant") {
			if (partialTimer) {
				clearTimeout(partialTimer);
				partialTimer = undefined;
			}
			pendingPartial = undefined;
			sendEvent(assistantEvent(message as { content: unknown; timestamp?: number; stopReason?: string; errorMessage?: string }));
		}
	});

	pi.on("message_update", async (event, eventCtx) => {
		ctx = eventCtx;
		const message = event.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") return;
		pendingPartial = {
			kind: "partial",
			text: trunc(textOf(message.content), MAX_TEXT),
			thinking: trunc(thinkingOf(message.content), MAX_THINKING),
		};
		if (!partialTimer) {
			partialTimer = setTimeout(() => {
				partialTimer = undefined;
				flushPartial();
			}, PARTIAL_THROTTLE_MS);
		}
	});

	pi.on("tool_execution_start", async (event, eventCtx) => {
		ctx = eventCtx;
		sendEvent({
			kind: "tool_start",
			callId: event.toolCallId,
			name: event.toolName,
			args: truncArgs(event.args),
			ts: Date.now(),
		});
	});

	pi.on("tool_execution_end", async (event, eventCtx) => {
		ctx = eventCtx;
		sendEvent({
			kind: "tool_end",
			callId: event.toolCallId,
			name: event.toolName,
			output: trunc(toolResultText(event.result), MAX_TOOL_OUTPUT),
			isError: event.isError === true,
			ts: Date.now(),
		});
	});

	pi.on("session_info_changed", async (_event, eventCtx) => {
		ctx = eventCtx;
		wsSend({ type: "meta", meta: { name: pi.getSessionName() } });
	});

	pi.on("model_select", async (_event, eventCtx) => {
		ctx = eventCtx;
		wsSend({ type: "meta", meta: { model: eventCtx.model?.id, modelProvider: eventCtx.model?.provider } });
	});

	// ── /rc command ──────────────────────────────────────────────────────────

	function setEnabled(next: boolean, cmdCtx: ExtensionContext): void {
		if (enabled === next) return;
		enabled = next;
		if (enabled) {
			backoff = RECONNECT_MIN_MS;
			connect();
			cmdCtx.ui.notify(`Remote control on — connecting to ${url}`, "info");
		} else {
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			try {
				ws?.close();
			} catch {
				/* already closed */
			}
			ws = undefined;
			connected = false;
			updateStatusIndicator();
			cmdCtx.ui.notify("Remote control off for this session", "info");
		}
	}

	pi.registerCommand("rc", {
		description: "Remote control: /rc (status) | /rc on | /rc off",
		handler: async (args, cmdCtx) => {
			const a = (args ?? "").trim().toLowerCase();
			if (a === "on" || a === "1") {
				setEnabled(true, cmdCtx);
			} else if (a === "off" || a === "0") {
				setEnabled(false, cmdCtx);
			} else {
				const state = !enabled
					? "off (/rc on to enable)"
					: connected
						? `connected to ${url}`
						: `disconnected (retrying ${url})`;
				cmdCtx.ui.notify(`Remote control: ${state}`, connected || !enabled ? "info" : "warning");
			}
		},
	});
}
