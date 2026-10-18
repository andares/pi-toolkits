/**
 * permission feature — the confirmation dialog.
 *
 * Four answers, hotkey-first because this dialog appears mid-run and should be
 * answerable with one keystroke:
 *
 *   a — allow once
 *   s — allow this directory for the session
 *   d — deny once
 *   f — deny this directory for the session
 *
 * `SelectList` provides rendering, ↑↓ and Enter; the wrapper maps the four
 * letters. Non-TUI dialog modes get the host's plain selector; with no UI at
 * all the caller's `present` resolves `undefined` (fail closed).
 */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeyId,
	matchesKey,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import type { AskDecision } from "../../lib/gates.js";

export interface PermissionPromptInput {
	readonly title: string;
	readonly details: readonly string[];
}

interface Option {
	readonly value: AskDecision;
	readonly key: KeyId;
	readonly label: string;
	readonly description: string;
}

function optionsFor(): Option[] {
	return [
		{
			value: "allow",
			key: "a",
			label: "Allow once (a)",
			description: "Run this call only",
		},
		{
			value: "allow-session",
			key: "s",
			label: "Allow for this session (s)",
			description: "Stop asking for this operation until the session ends",
		},
		{
			value: "deny",
			key: "d",
			label: "Deny (d)",
			description: "Block this call",
		},
		{
			value: "deny-session",
			key: "f",
			label: "Deny for this session (f)",
			description: "Block this operation until the session ends",
		},
	];
}

/** Header plus a hotkey-aware `SelectList`. */
class PromptComponent implements Component {
	constructor(
		private readonly header: Text,
		private readonly list: SelectList,
		private readonly options: readonly Option[],
		private readonly choose: (value: AskDecision) => void,
	) {}

	handleInput(data: string): void {
		const hit = this.options.find((option) => matchesKey(data, option.key));
		if (hit) {
			this.choose(hit.value);
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return [...this.header.render(width), ...this.list.render(width)];
	}

	invalidate(): void {
		this.header.invalidate();
		this.list.invalidate();
	}
}

/**
 * Ask the operator. Resolves `undefined` when there is no way to ask or the
 * dialog was cancelled.
 */
export async function askPermission(
	ctx: ExtensionContext,
	input: PermissionPromptInput,
): Promise<AskDecision | undefined> {
	if (!ctx.hasUI) return undefined;
	const options = optionsFor();

	if (ctx.mode !== "tui") {
		const labels = options.map((option) => option.label);
		const choice = await ctx.ui.select(input.title, labels);
		if (choice === undefined) return undefined;
		return options[labels.indexOf(choice)]?.value;
	}

	return ctx.ui.custom<AskDecision | undefined>(
		(_tui, theme, _keybindings, done) => {
			let settled = false;
			const finish = (value: AskDecision | undefined): void => {
				if (settled) return;
				settled = true;
				done(value);
			};
			const header = new Text(
				[
					theme.fg("accent", input.title),
					...input.details.map((line) => theme.fg("muted", line)),
					theme.fg(
						"dim",
						"a allow · s allow session · d deny · f deny session · esc cancel",
					),
				].join("\n"),
			);
			const list = new SelectList(
				options.map((option) => ({
					value: option.value,
					label: option.label,
					description: option.description,
				})),
				6,
				getSelectListTheme(),
			);
			list.onSelect = (item) => finish(item.value as AskDecision);
			list.onCancel = () => finish(undefined);
			return new PromptComponent(header, list, options, finish);
		},
	);
}
