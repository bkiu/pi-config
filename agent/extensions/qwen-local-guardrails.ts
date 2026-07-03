/**
 * Qwen Local Guardrails
 *
 * Appends a short block of execution rules to the system prompt when the
 * active model is served by a local llama.cpp provider. Tuned for
 * Qwen3.6-27B failure modes observed in benchmarking: spec drift on exact
 * strings/counts, skipped verification, and retyping (rather than copying)
 * long literals in edits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOCAL_PROVIDERS = new Set(["leftoverburrito", "windtunnel"]);

const GUARDRAILS = `# Local execution rules

- Before finishing, re-read the task's exact requirements: counts, exact strings, exit codes, file names, output formats. Match them literally, character for character.
- Read a file before editing it. When using the edit tool, copy oldText exactly from the file content you just read — never retype long strings (paths, URLs) from memory.
- Verify every deliverable by executing it: run the tests, run the script, read the output file back, and compare against the requirement. If verification fails, fix it and verify again. Never claim success without a passing check.
- Work in small increments: make one change, verify it, then move on.
- If a tool call returns an error, diagnose the message and change your approach; never repeat the identical call.
- When the task is done, reply with a 1-3 sentence summary.`;

const HEADLESS_EXTRA = `
- Never ask the user questions or wait for confirmation. Proceed autonomously and make reasonable assumptions.`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.model || !LOCAL_PROVIDERS.has(ctx.model.provider)) return;
		const rules = ctx.mode === "tui" ? GUARDRAILS : GUARDRAILS + HEADLESS_EXTRA;
		return { systemPrompt: `${event.systemPrompt}\n\n${rules}` };
	});
}
