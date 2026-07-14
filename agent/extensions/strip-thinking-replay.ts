/**
 * Strip Thinking Replay
 *
 * Removes historical `thinking` content from the context before it is sent to
 * a local llama.cpp provider, so prior-turn reasoning is never replayed back
 * into the prompt.
 *
 * Why: the Qwen3.6 chat template re-injects every assistant turn's thinking
 * that follows the last user message (its preservation clause is
 * `... or (loop.index0 > ns.last_query_index)`, which is unconditional and
 * cannot be disabled via `preserve_thinking` or llama.cpp's
 * `--no-reasoning-preserve`). Fed its own prior chain-of-thought, Qwen3.6-27B
 * (Q5 + MTP draft) parrots the same reasoning preamble verbatim each turn and
 * stalls mid tool-chain instead of progressing — observed as the PR-creation
 * loop on `leftoverburrito` (2026-07-14). Stripping the replayed thinking makes
 * the model reason freshly and progress-aware each turn; live thinking is
 * unaffected because the current turn's `<think>` is generated, not replayed.
 *
 * Scoped to local providers only. Cloud models (e.g. Anthropic) require their
 * signed thinking blocks to be echoed back for multi-turn tool continuity, so
 * their history must never be stripped.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOCAL_PROVIDERS = new Set(["leftoverburrito", "windtunnel"]);

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event, ctx) => {
		if (!ctx.model || !LOCAL_PROVIDERS.has(ctx.model.provider)) return;

		let changed = false;
		const messages = event.messages.map((m): AgentMessage => {
			if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
			const content = m.content.filter((c) => c.type !== "thinking");
			if (content.length === m.content.length) return m;
			changed = true;
			return { ...m, content };
		});

		if (!changed) return;
		return { messages };
	});
}
