/**
 * Q&A Extension
 *
 * Provides tools for the agent to ask the user questions and receive responses.
 *
 * - `ask` — Single question with options + free-text fallback
 * - `ask_multi` — Multiple questions with tab navigation
 * - `ask_free` — Free-text question (no options, just a prompt)
 *
 * All tools render custom TUI dialogs with keyboard navigation.
 * In non-TUI modes, the tool returns an error asking the user to interact.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/* ── shared types ────────────────────────────────────────────────────────── */

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface AskDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
	index?: number;
}

/* ── ask (single question) ───────────────────────────────────────────────── */

const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const AskParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Optional(
		Type.Array(AskOptionSchema, {
			description: "Options for the user to choose from (optional — omit for free-text only)",
		}),
	),
});

function buildAskResult(
	question: string,
	options: OptionWithDesc[],
	result: { answer: string; wasCustom: boolean; index?: number } | null,
): { content: { type: "text"; text: string }[]; details: AskDetails } {
	const simpleOptions = options.map((o) => o.label);

	if (!result) {
		return {
			content: [{ type: "text", text: "User cancelled the selection" }],
			details: { question, options: simpleOptions, answer: null, wasCustom: false },
		};
	}

	if (result.wasCustom) {
		return {
			content: [{ type: "text", text: `User wrote: ${result.answer}` }],
			details: { question, options: simpleOptions, answer: result.answer, wasCustom: true },
		};
	}

	return {
		content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
		details: {
			question,
			options: simpleOptions,
			answer: result.answer,
			wasCustom: false,
			index: result.index,
		},
	};
}

function renderAskCall(args: { question: string; options?: OptionWithDesc[] }, theme: any) {
	const opts = args.options ?? [];
	let text = theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", args.question);
	if (opts.length) {
		const numbered = [...opts.map((o) => o.label), "Type something."].map((o, i) => `${i + 1}. ${o}`);
		text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
	}
	return new Text(text, 0, 0);
}

function renderAskResult(result: any, _options: any, theme: any) {
	const details = result.details as AskDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}

	if (details.answer === null) {
		return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	}

	if (details.wasCustom) {
		return new Text(
			theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
			0,
			0,
		);
	}

	const idx = details.options.indexOf(details.answer) + 1;
	const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
	return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
}

/* ── ask_multi (multiple questions) ──────────────────────────────────────── */

interface MultiQuestion {
	id: string;
	label: string;
	prompt: string;
	options: OptionWithDesc[];
	allowOther: boolean;
}

interface MultiAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface MultiResult {
	questions: MultiQuestion[];
	answers: MultiAnswer[];
	cancelled: boolean;
}

const MultiQuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({ description: "Short label for tab bar (defaults to Q1, Q2, …)" }),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Optional(
		Type.Array(AskOptionSchema, { description: "Available options (omit for free-text)" }),
	),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const AskMultiParams = Type.Object({
	questions: Type.Array(MultiQuestionSchema, {
		description: "Questions to ask the user. Each can have options or be free-text.",
	}),
});

function renderMultiCall(args: { questions: MultiQuestion[] }, theme: any) {
	const qs = args.questions || [];
	const count = qs.length;
	const labels = qs.map((q) => q.label || q.id).join(", ");
	let text = theme.fg("toolTitle", theme.bold("ask_multi ")) + theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
	if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
	return new Text(text, 0, 0);
}

function renderMultiResult(result: any, _options: any, theme: any) {
	const details = result.details as MultiResult | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}
	if (details.cancelled) {
		return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	}
	const lines = details.answers.map((a) => {
		if (a.wasCustom) {
			return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
		}
		const display = a.index ? `${a.index}. ${a.label}` : a.label;
		return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
	});
	return new Text(lines.join("\n"), 0, 0);
}

/* ── ask_free (free-text only) ───────────────────────────────────────────── */

const AskFreeParams = Type.Object({
	prompt: Type.String({ description: "The question or prompt to ask the user" }),
});

interface AskFreeDetails {
	prompt: string;
	answer: string | null;
	cancelled: boolean;
}

function renderFreeCall(args: { prompt: string }, theme: any) {
	return new Text(theme.fg("toolTitle", theme.bold("ask_free ")) + theme.fg("muted", args.prompt), 0, 0);
}

function renderFreeResult(result: any, _options: any, theme: any) {
	const details = result.details as AskFreeDetails | undefined;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}
	if (details.cancelled) {
		return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	}
	return new Text(theme.fg("success", "✓ ") + theme.fg("accent", details.answer), 0, 0);
}

/* ── extension ───────────────────────────────────────────────────────────── */

export default function qa(pi: ExtensionAPI) {
	/* In headless modes (-p/json) these tools can only return errors, so
	   deactivate them to keep them out of the model's tool list. */
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui") return;
		const mine = ["ask", "ask_multi", "ask_free"];
		pi.setActiveTools(pi.getActiveTools().filter((t) => !mine.includes(t)));
	});

	/* ── ask ─────────────────────────────────────────────────────────────── */
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the user a single question with options. The user can pick an option or type a custom answer. Use when you need clarification or a decision.",
		parameters: AskParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { question: params.question, options: [], answer: null, wasCustom: false },
				};
			}

			const options: OptionWithDesc[] = params.options ?? [];
			const allOptions: DisplayOption[] = [...options, { label: "Type something.", isOther: true }];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));

						add(theme.fg("accent", "─".repeat(width)));
						add(theme.fg("text", ` ${params.question}`));
						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";

							if (isOther && editMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else if (selected) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`));
							} else {
								add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
							}

							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}

						if (editMode) {
							lines.push("");
							add(theme.fg("muted", " Your answer:"));
							for (const line of editor.render(width - 2)) {
								add(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							add(theme.fg("dim", " Enter to submit • Esc to go back"));
						} else {
							add(theme.fg("dim", " ↑↓ navigate • Enter to select • Esc to cancel"));
						}
						add(theme.fg("accent", "─".repeat(width)));

						cachedLines = lines;
						return lines;
					}

					return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
				},
			);

			return buildAskResult(params.question, options, result);
		},

		renderCall: renderAskCall,
		renderResult: renderAskResult,
	});

	/* ── ask_multi ───────────────────────────────────────────────────────── */
	pi.registerTool({
		name: "ask_multi",
		label: "Ask Multi",
		description:
			"Ask the user multiple questions with tab navigation. Each question can have options or be free-text. Use for surveys, requirement gathering, or multi-part decisions.",
		parameters: AskMultiParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { questions: [], answers: [], cancelled: true },
				};
			}

			if (params.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided" }],
					details: { questions: [], answers: [], cancelled: true },
				};
			}

			const questions: MultiQuestion[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1;

			const result = await ctx.ui.custom<MultiResult>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, MultiAnswer>();

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): MultiQuestion | undefined {
					return questions[currentTab];
				}

				function currentOptions(): DisplayOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: DisplayOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length;
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.label, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));

					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive
								? theme.bg("selectedBg", theme.fg("text", text))
								: theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : "text";
							if (isOther && inputMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else {
								add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
							}
							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}
					}

					if (inputMode && q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						add(theme.fg("accent", theme.bold(" Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`);
							}
						}
						lines.push("");
						if (allAnswered()) {
							add(theme.fg("success", " Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							add(theme.fg("warning", ` Unanswered: ${missing}`));
						}
					} else if (q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
							: " ↑↓ navigate • Enter select • Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				}

				return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall: renderMultiCall,
		renderResult: renderMultiResult,
	});

	/* ── ask_free ────────────────────────────────────────────────────────── */
	pi.registerTool({
		name: "ask_free",
		label: "Ask Free",
		description:
			"Ask the user an open-ended question with no options. The user types their answer freely. Use for free-form input, explanations, or when you don't know what options to offer.",
		parameters: AskFreeParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { prompt: params.prompt, answer: null, cancelled: true },
				};
			}

			const result = await ctx.ui.input(params.prompt, {
				placeholder: "Type your answer…",
			});

			if (result === null) {
				return {
					content: [{ type: "text", text: "User cancelled" }],
					details: { prompt: params.prompt, answer: null, cancelled: true },
				};
			}

			return {
				content: [{ type: "text", text: `User wrote: ${result}` }],
				details: { prompt: params.prompt, answer: result, cancelled: false },
			};
		},

		renderCall: renderFreeCall,
		renderResult: renderFreeResult,
	});
}
