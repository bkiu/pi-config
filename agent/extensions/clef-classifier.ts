/**
 * Clef-Flash classifier provider
 *
 * Registers the local `clef-flash` decision model (llama.cpp server on
 * chorizoburrito) as a pi classifier model.
 *
 * clef-flash is NOT a chat model: the server runs in embedding mode with
 * logits disabled, so /v1/chat/completions, /v1/completions, and /completion
 * all fail with "the current context does not support logits computation".
 * Its only endpoint is POST /v1/systemone — the TypeSafe System One decision
 * protocol — which takes `state` (any JSON value) plus typed `questions`
 * (noul/choice/score) and returns `{ model, answers, usage }`.
 *
 * That wire protocol is exactly what pi's built-in `typesafe-system-one`
 * classifier API implements, so this provider reuses it verbatim: baseUrl
 * `http://…:8080/v1` + the transport's `systemone` path = `/v1/systemone`,
 * and the payload `{ model: "clef-flash", state, questions }` matches.
 * No auth, no streaming, no sampling params (temperature/max_tokens are not
 * part of the protocol).
 *
 * Constraints honored by callers (see auto-permission.ts):
 *   - state must be bounded client-side: over-context (16,384 tokens) is a
 *     hard 500 in ~90 ms, the server does not truncate
 *   - latency scales super-linearly (~200 ms at 307 tokens, ~7 s at 4.5k,
 *     ~35 s at 14.5k), so callers keep states tight and set timeouts
 *   - ask all questions about one state in a single request: the model
 *     scores them jointly in one forward pass
 *   - the response `confidence` field is computed differently from the model
 *     card (and can be 0.0 while an option has p > 0.5) — use `probabilities`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

// pi's extension loader compiles extensions to CJS, but pi-ai's exports map
// only defines the "import" condition for ./api/* subpaths, so
// `@earendil-works/pi-ai/api/typesafe-system-one` cannot be required.
// The built-in `typesafe` provider (reachable via the aliased
// `providers/all` entrypoint) carries the very same typesafe-system-one
// `classify` implementation, so reuse it from there.
const classify = builtinProviders().find((p) => p.id === "typesafe")?.classify;

export const CLEF_PROVIDER = "chorizoburrito";
export const CLEF_MODEL_ID = "clef-flash";
const BASE_URL = "http://chorizoburrito.stargazer-darter.ts.net:8080/v1";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(CLEF_PROVIDER, {
		baseUrl: BASE_URL,
		// Server requires no auth; a dummy key marks the provider as
		// authenticated so the model is listed as available.
		apiKey: "no-key-needed",
		models: [
			{
				type: "classifier",
				id: CLEF_MODEL_ID,
				name: "Clef Flash (decision model)",
				api: "typesafe-system-one",
				input: ["text"],
				contextWindow: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		classifiers: classify ? { "typesafe-system-one": { classify } } : undefined,
	});
}
