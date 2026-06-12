/**
 * Tokens/sec extension - shows average tokens/sec in the status bar.
 * Computes from total output tokens ÷ elapsed time since session start.
 * Updates in real-time during streaming via message_update events.
 */

import type { ExtensionAPI, MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let sessionStartMs = 0;

	pi.on("session_start", (_event, ctx) => {
		sessionStartMs = Date.now();
		ctx.ui.setStatus("tok/s", undefined);
	});

	pi.on("session_shutdown", () => {
		sessionStartMs = 0;
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
		if (event.message.role !== "assistant") return;

		const elapsedSec = (Date.now() - sessionStartMs) / 1000;
		if (elapsedSec < 0.5) return; // Wait for meaningful data

		const avgTps = event.message.usage.output / elapsedSec;
		ctx.ui.setStatus(
			"tok/s",
			ctx.ui.theme.fg("accent", `${avgTps.toFixed(1)} tok/s`)
		);
	});
}
