/**
 * permission feature — the mode panel.
 *
 * A `SettingsList` (the same component the built-in settings dialogs use)
 * supplies rendering, ↑↓ navigation, space-cycle and Esc-cancel. A thin
 * wrapper adds the one behaviour this dialog needs on top: **Enter anywhere
 * applies the current values**, so typing `/ask-perm` then Enter enables the
 * defaults without navigating.
 *
 * TUI only: `SettingsList` is a custom component, and rpc/print modes cannot
 * host one. Callers fall back to the argument form there.
 */
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import {
	IN_VALUES,
	OUT_VALUES,
	type PermissionModes,
} from "./constants.js";

/** Intercepts Enter globally; everything else belongs to the list. */
class ApplyOnEnter implements Component {
	constructor(
		private readonly list: SettingsList,
		private readonly snapshot: () => PermissionModes,
		private readonly done: (value: PermissionModes | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			this.done(this.snapshot());
			return;
		}
		this.list.handleInput(data);
	}

	render(width: number): string[] {
		return this.list.render(width);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}

/** Build the settings rows for one mode set. */
function buildItems(modes: PermissionModes): SettingItem[] {
	return [
		{
			id: "apply",
			label: "Enable with these modes",
			description: "Press Enter to enable permission checks",
			currentValue: "enter",
		},
		{
			id: "inRead",
			label: "In-project read",
			description: "Reads inside the working directory and added directories",
			currentValue: modes.inRead,
			values: [...IN_VALUES],
		},
		{
			id: "inWrite",
			label: "In-project write / exec",
			description: "Writes and command execution inside the project",
			currentValue: modes.inWrite,
			values: [...IN_VALUES],
		},
		{
			id: "outRead",
			label: "Outside read",
			description: "Reads outside the project boundary",
			currentValue: modes.outRead,
			values: [...OUT_VALUES],
		},
		{
			id: "outWrite",
			label: "Outside write / exec",
			description: "Writes and execution outside the project boundary",
			currentValue: modes.outWrite,
			values: [...OUT_VALUES],
		},
	];
}

/**
 * Open the mode panel. Resolves with the chosen modes, or `undefined` when the
 * operator cancels (Esc) or the host cannot render a custom component.
 */
export function openPermissionPanel(
	ctx: ExtensionContext,
	modes: PermissionModes,
): Promise<PermissionModes | undefined> {
	if (!ctx.hasUI || ctx.mode !== "tui") return Promise.resolve(undefined);

	return ctx.ui.custom<PermissionModes | undefined>(
		(_tui, _theme, _keybindings, done) => {
			let current: PermissionModes = { ...modes };
			const items = buildItems(current);
			const list = new SettingsList(
				items,
				8,
				getSettingsListTheme(),
				(id, value) => {
					current = { ...current, [id]: value } as PermissionModes;
				},
				() => done(undefined),
			);
			return new ApplyOnEnter(list, () => current, done);
		},
	);
}
