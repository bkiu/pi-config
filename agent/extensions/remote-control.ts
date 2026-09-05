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
 * - Fails soft: if the server is unreachable it retries with backoff and never
 *   affects the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

// ── config / caps ──────────────────────────────────────────────────────────

function fileConfig(): { url?: string; name?: string } {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "remote-control.json"), "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {}; // missing or malformed config file — stay inert
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
	let shuttingDown = false;
	let backoff = RECONNECT_MIN_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	let pendingPartial: RemoteEvent | undefined;
	let partialTimer: ReturnType<typeof setTimeout> | undefined;
	const remoteSentTexts: string[] = [];

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

	function updateStatusIndicator(): void {
		try {
			if (ctx?.hasUI) {
				ctx.ui.setStatus("remote", connected ? ctx.ui.theme.fg("success", "🛰 remote") : undefined);
			}
		} catch {
			/* ui not available */
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
				startedAt: Date.now(),
				pid: process.pid,
			},
		});
		wsSend({ type: "backlog", events: buildBacklog(ctx) });
		sendEvent({ kind: "status", state: ctx.isIdle() ? "idle" : "working" });
	}

	function connect(): void {
		if (shuttingDown || (ws && ws.readyState <= WebSocket.OPEN)) return;
		try {
			ws = new WebSocket(url!);
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
		if (shuttingDown || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, backoff);
		backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
	}

	function handleServerMessage(raw: string): void {
		let msg: { type?: string; text?: string };
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.type === "input" && typeof msg.text === "string" && msg.text.trim()) {
			const text = msg.text.trim();
			remoteSentTexts.push(text);
			if (remoteSentTexts.length > 10) remoteSentTexts.shift();
			try {
				if (ctx && !ctx.isIdle()) {
					pi.sendUserMessage(text, { deliverAs: "steer" });
				} else {
					pi.sendUserMessage(text);
				}
			} catch {
				/* agent state changed between check and send */
			}
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
			const remoteIdx = remoteSentTexts.indexOf(text);
			if (remoteIdx >= 0) remoteSentTexts.splice(remoteIdx, 1);
			sendEvent({
				kind: "user",
				text: trunc(text, MAX_TEXT),
				via: remoteIdx >= 0 ? "remote" : undefined,
				ts: message.timestamp ?? Date.now(),
			});
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
		wsSend({ type: "meta", meta: { model: eventCtx.model?.id } });
	});

	// ── /remote command ──────────────────────────────────────────────────────

	pi.registerCommand("remote", {
		description: "Show remote-control connection status",
		handler: async (_args, cmdCtx) => {
			const state = connected ? `connected to ${url}` : `disconnected (retrying ${url})`;
			cmdCtx.ui.notify(`Remote control: ${state}`, connected ? "info" : "warning");
		},
	});
}
