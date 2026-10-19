/**
 * ask feature — the `scratchpad` tool.
 *
 * The tool the model writes planning notes with while ask mode is on. It is
 * registered once with `defaultActive: false` and activated by `/ask`, so the
 * tool declaration is part of the request only in that mode — the mode-scoped
 * surface is the cheapest place to keep the rules: `promptGuidelines` rides in
 * the system prompt only while the tool is active, and the declaration itself
 * tells the model that the only writable place is throwaway.
 *
 * Deliberately *not* a path-taking tool: `name` is a relative note name and the
 * store validates it, so the model never juggles absolute paths and the host
 * never has to parse one. Nothing written here can reach the project.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_SCRATCH_TOOL } from "./constants.js";
import type { ScratchStore } from "./scratch.js";
import { SCRATCH_MAX_BYTES } from "./scratch.js";

const SCRATCH_PARAMS = Type.Object({
	op: Type.Union(
		[
			Type.Literal("write"),
			Type.Literal("append"),
			Type.Literal("read"),
			Type.Literal("list"),
			Type.Literal("delete"),
		],
		{
			description:
				"write replaces a note, append adds to it, read returns it, list shows the notes that exist, delete removes one.",
		},
	),
	name: Type.Optional(
		Type.String({
			description:
				'Relative note name, for example "plan.md" or "notes/api.md". Required for every op except list. Absolute paths are rejected.',
		}),
	),
	content: Type.Optional(
		Type.String({
			description: 'Full note text for op "write", the added text for op "append".',
		}),
	),
});

const SCRATCH_DESCRIPTION = `Throwaway scratch notes for this consult session.

Ask mode is read-only for the project, so this is the one place to keep
intermediate planning output that would clutter the reply: an outline, a
checklist, a comparison table, draft analysis. Notes live in a temp directory
that is separate from the repository and cleaned up by the system later.

These notes are NOT deliverables and NOT changes: nothing written here shows up
in the project, and the operator never asked for it. If the answer requires
changing a real file, describe the change and tell the operator to exit ask mode
with /ask instead of writing the change here.

Ops: write (create or replace), append, read, list, delete. Names are relative
("plan.md", "notes/api.md"); absolute paths are rejected. Each note is capped at
${Math.floor(SCRATCH_MAX_BYTES / 1024)} KiB.`;

const SCRATCH_GUIDELINES = [
	"While in ask mode, use `scratchpad` for intermediate notes (outlines, checklists, draft analysis) instead of pasting them into the reply; it writes only to a throwaway temp directory, never to the project.",
	"Scratch notes are not deliverables: when the answer needs a real file change, describe the change and tell the operator to exit ask mode with /ask.",
];

/** Bytes as `1.2 KiB` / `320 B`, for tool results. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Model-facing text of an operation on a note. */
function describe(
	op: "write" | "append" | "delete",
	name: string,
	bytes: number,
	lines: number,
): string {
	if (op === "delete") return `Deleted ${name} from the scratch directory.`;
	const size = formatBytes(bytes);
	if (op === "append") {
		return `Appended to ${name} (now ${size}). Scratch notes are not part of the project.`;
	}
	return `Wrote ${name} (${size}, ${lines} line${lines === 1 ? "" : "s"}). Scratch notes are not part of the project.`;
}

/** Result details of a `scratchpad` call (shown by renderers, not the model). */
export interface ScratchDetails {
	readonly op: string;
	readonly name?: string;
	readonly bytes?: number;
}

/**
 * Register the tool. `store` is read on every call: ask mode sets it on entry
 * and clears it on exit, so an unexpected call after exit fails with an
 * explanation instead of writing anywhere.
 */
export function registerScratchTool(
	pi: ExtensionAPI,
	store: () => ScratchStore | undefined,
): void {
	pi.registerTool<typeof SCRATCH_PARAMS, ScratchDetails>({
		name: ASK_SCRATCH_TOOL,
		label: "Scratch note",
		description: SCRATCH_DESCRIPTION,
		promptSnippet:
			"Write throwaway planning notes to a temp scratch directory (ask mode only)",
		promptGuidelines: SCRATCH_GUIDELINES,
		parameters: SCRATCH_PARAMS,
		defaultActive: false,
		async execute(_toolCallId, params) {
			const scratch = store();
			if (!scratch) {
				return {
					content: [
						{
							type: "text" as const,
							text: "The scratch directory is not available in this session, so nothing can be written. Answer with the information you can gather from reading.",
						},
					],
					details: { op: params.op },
					isError: true,
				};
			}

			const name = params.name?.trim();
			try {
				switch (params.op) {
					case "list": {
						const files = await scratch.list();
						const text =
							files.length === 0
								? "The scratch directory is empty."
								: [
										`Scratch notes (${files.length}):`,
										...files.map((file) => `- ${file.name} — ${formatBytes(file.bytes)}`),
									].join("\n");
						return { content: [{ type: "text" as const, text }], details: { op: params.op } };
					}
					case "read": {
						if (name === undefined) throw new Error('op "read" needs a note name.');
						const text = await scratch.read(name);
						return {
							content: [{ type: "text" as const, text }],
							details: { op: params.op, name, bytes: Buffer.byteLength(text, "utf8") },
						};
					}
					case "delete": {
						if (name === undefined) throw new Error('op "delete" needs a note name.');
						await scratch.remove(name);
						return {
							content: [
								{ type: "text" as const, text: describe("delete", name, 0, 0) },
							],
							details: { op: params.op, name },
						};
					}
					case "write":
					case "append": {
						if (name === undefined) throw new Error(`op "${params.op}" needs a note name.`);
						const content = params.content ?? "";
						const result =
							params.op === "write"
								? await scratch.write(name, content)
								: await scratch.append(name, content);
						return {
							content: [
								{
									type: "text" as const,
									text: describe(params.op, result.name, result.bytes, result.lines),
								},
							],
							details: { op: params.op, name, bytes: result.bytes },
						};
					}
					default: {
						const unknown: never = params.op;
						throw new Error(`Unknown scratchpad op: ${String(unknown)}`);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `scratchpad: ${message}` }],
					details: { op: params.op, name },
					isError: true,
				};
			}
		},
	});
}
