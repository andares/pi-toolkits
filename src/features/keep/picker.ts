/**
 * keep feature — the picker and the switch-before dialog.
 *
 * Two blocks in one list: not-loaded rows first, loaded rows after them,
 * dimmed. Both are selectable on purpose — the loaded flag is a record, not a
 * lock, so a session whose process was killed must stay reachable without
 * hand-editing the ledger.
 *
 * Why a dedicated component instead of `SelectList`:
 *   - `SelectItem` is `{value,label,description}` and the list applies one
 *     style to every unselected row, so "this row is dim, that row is red"
 *     cannot be expressed;
 *   - there is no group header item (a header would be a selectable row);
 *   - `ctrl+r` drops a row, and `SelectList` has no `setItems` — the removal
 *     would mean rebuilding the component on every keystroke.
 * The rendering itself follows the repo's existing per-row precedent
 * (`src/features/favorites/patch-selector.ts` re-renders the host selector's
 * rows the same way). The three-way dialog below the picker *does* reuse
 * `SelectList`: it needs no per-row styling.
 */
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	SelectList,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { KEEP_DROP_KEY, KEEP_MAX_ROWS } from "./constants.js";
import { pickerTitle, rowText } from "./format.js";
import type { KeepEntryView } from "./ledger.js";

export type KeepPick =
	| { readonly action: "load"; readonly entry: KeepEntryView }
	| { readonly action: "cancel" };

export interface KeepPickerOptions {
	readonly now: Date;
	/** Add the project column (`--all`). */
	readonly showProject: boolean;
	readonly maxRows?: number;
	/** Persist the drop; called before the row disappears. */
	readonly drop: (entry: KeepEntryView) => void;
}

const HINT = "↑↓ move · enter load · ctrl+r drop · esc cancel";

export class KeepPicker implements Component {
	private readonly rows: KeepEntryView[];
	private cursor = 0;
	private offset = 0;
	private settled = false;

	constructor(
		entries: readonly KeepEntryView[],
		private readonly options: KeepPickerOptions,
		private readonly theme: Theme,
		private readonly done: (result: KeepPick) => void,
		private readonly requestRender: () => void,
	) {
		this.rows = [...entries];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(1);
			return;
		}
		if (matchesKey(data, "enter")) {
			const entry = this.rows[this.cursor];
			if (entry) this.finish({ action: "load", entry });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.finish({ action: "cancel" });
			return;
		}
		if (matchesKey(data, KEEP_DROP_KEY)) {
			this.dropSelected();
		}
	}

	render(width: number): string[] {
		const notLoaded = this.rows.filter((entry) => !entry.loaded).length;
		const lines = [
			truncateToWidth(this.theme.bold(pickerTitle(notLoaded, this.rows.length - notLoaded)), width, ""),
			truncateToWidth(this.theme.fg("dim", HINT), width, ""),
			"",
		];

		const maxRows = Math.max(1, this.options.maxRows ?? KEEP_MAX_ROWS);
		if (this.cursor < this.offset) this.offset = this.cursor;
		if (this.cursor >= this.offset + maxRows) this.offset = this.cursor - maxRows + 1;

		for (let index = this.offset; index < Math.min(this.rows.length, this.offset + maxRows); index += 1) {
			const entry = this.rows[index];
			const selected = index === this.cursor;
			const text = `${selected ? "→ " : "  "}${rowText(entry, this.options)}`;
			const fitted = truncateToWidth(text, width, "…");
			// One colour per row keeps the SGR sequences flat: no nesting between
			// the selected style and the dim style.
			if (selected) lines.push(this.theme.fg("accent", fitted));
			else if (entry.missing) lines.push(this.theme.fg("error", fitted));
			else if (entry.loaded) lines.push(this.theme.fg("dim", fitted));
			else lines.push(fitted);
		}

		if (this.rows.length > maxRows) {
			lines.push(
				truncateToWidth(
					this.theme.fg("dim", `  ${this.cursor + 1}/${this.rows.length}`),
					width,
					"",
				),
			);
		}
		return lines;
	}

	invalidate(): void {
		// Rows are rebuilt from the field state on every render.
	}

	private move(delta: number): void {
		const next = Math.max(0, Math.min(this.rows.length - 1, this.cursor + delta));
		if (next === this.cursor) return;
		this.cursor = next;
		this.requestRender();
	}

	private dropSelected(): void {
		const entry = this.rows[this.cursor];
		if (!entry) return;
		this.options.drop(entry);
		this.rows.splice(this.cursor, 1);
		if (this.rows.length === 0) {
			this.finish({ action: "cancel" });
			return;
		}
		if (this.cursor >= this.rows.length) this.cursor = this.rows.length - 1;
		this.requestRender();
	}

	private finish(result: KeepPick): void {
		if (this.settled) return;
		this.settled = true;
		this.done(result);
	}
}

/** Ask for one entry. `undefined` means "no UI, or cancelled". */
export async function pickKeepEntry(
	ctx: ExtensionContext,
	entries: readonly KeepEntryView[],
	options: KeepPickerOptions,
): Promise<KeepPick | undefined> {
	if (!ctx.hasUI || entries.length === 0) return undefined;

	const notLoaded = entries.filter((entry) => !entry.loaded).length;
	const title = pickerTitle(notLoaded, entries.length - notLoaded);

	if (ctx.mode !== "tui") {
		const labels = entries.map((entry) => rowText(entry, options));
		const choice = await ctx.ui.select(`${title} — ${HINT}`, labels);
		if (choice === undefined) return undefined;
		const index = labels.indexOf(choice);
		const entry = entries[index];
		return entry ? { action: "load", entry } : undefined;
	}

	return ctx.ui.custom<KeepPick>((tui, theme, _keybindings, done) =>
		new KeepPicker(entries, options, theme, done, () => tui.requestRender()),
	);
}

export type SwitchChoice = "keep" | "load" | "cancel";

interface ChoiceOption {
	readonly value: SwitchChoice;
	readonly label: string;
	readonly description: string;
}

function switchOptions(): ChoiceOption[] {
	return [
		{
			value: "keep",
			label: "Keep it & load",
			description: "Mark this session unfinished, then load the other one",
		},
		{
			value: "load",
			label: "Load anyway",
			description: "Leave this session out of the keep list",
		},
		{
			value: "cancel",
			label: "Cancel",
			description: "Stay where you are",
		},
	];
}

/**
 * The current session has work in it and is not kept: switching away would
 * leave it out of the backlog. Three answers, no typing.
 */
export async function askSwitchChoice(
	ctx: ExtensionContext,
	entry: KeepEntryView,
): Promise<SwitchChoice | undefined> {
	if (!ctx.hasUI) return "load";
	const options = switchOptions();
	const title = `This session is not kept — ${entry.note}`;

	if (ctx.mode !== "tui") {
		const labels = options.map((option) => option.label);
		const choice = await ctx.ui.select(title, labels);
		if (choice === undefined) return undefined;
		return options[labels.indexOf(choice)]?.value;
	}

	return ctx.ui.custom<SwitchChoice | undefined>((_tui, theme, _keybindings, done) => {
		const header = new Text(
			[
				theme.fg("accent", "This session is not kept"),
				theme.fg("muted", `Loading: ${entry.note}`),
			].join("\n"),
			1,
			0,
		);
		const list = new SelectList(
			options.map((option) => ({
				value: option.value,
				label: option.label,
				description: option.description,
			})),
			options.length,
			getSelectListTheme(),
		);
		list.onSelect = (item) => done(item.value as SwitchChoice);
		list.onCancel = () => done(undefined);
		return {
			handleInput: (data: string) => list.handleInput(data),
			render: (width: number) => [...header.render(width), ...list.render(width)],
			invalidate: () => {
				header.invalidate();
				list.invalidate();
			},
		};
	});
}
