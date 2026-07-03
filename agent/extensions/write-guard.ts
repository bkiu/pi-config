/**
 * Write Guard
 *
 * Blocks the `write` tool from overwriting an existing file that the agent
 * has not read (or itself written) this session. Local models tend to treat
 * existing fixtures/configs as scratch space and clobber them with invented
 * content; the block message redirects the model to read the file first.
 *
 * New files are unaffected. `edit` is unaffected (its oldText requirement is
 * a natural guard). Reads/edits/successful writes mark a path as known.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const known = new Set<string>();

	pi.on("session_start", async () => {
		known.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		const p = (event.input as { path?: string } | undefined)?.path;
		if (typeof p !== "string" || p.length === 0) return undefined;
		const abs = path.resolve(ctx.cwd ?? process.cwd(), p);

		if (event.toolName === "read" || event.toolName === "edit") {
			known.add(abs);
			return undefined;
		}

		if (event.toolName !== "write") return undefined;

		if (fs.existsSync(abs) && !known.has(abs)) {
			return {
				block: true,
				reason:
					`Blocked: ${p} already exists and you have not read it this session. ` +
					`Read it first. Existing files are not scratch space — keep their contents ` +
					`unless the task explicitly requires replacing them. If you need test data, ` +
					`create a new file with a different name.`,
			};
		}
		known.add(abs);
		return undefined;
	});
}
