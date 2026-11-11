/**
 * UAT feature — the `uat_item` tool (clustering writes).
 *
 * Only active while `/ask-uat` is open. It is the single writer of acceptance
 * item identity: implementation sessions append *candidates* and never create
 * items, because ten parallel sessions cannot see each other and would each
 * invent a near-duplicate. Clustering happens here, once, with the full set in
 * view.
 *
 * Every operation appends to the ledger; nothing is rewritten. `merge` and
 * `drop` exist because acceptance debt must be reducible: duplicates happen and
 * abandoned work must be retirable without deleting history.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UAT_ITEM_TOOL } from "./constants.js";
import {
	appendEvent,
	deriveState,
	ledgerPath,
	newEventId,
	readEvents,
	type UatItemView,
} from "./ledger.js";
import { isoMinute, listRecords, slugify } from "./records.js";
import { resolveProjectRoot } from "./state.js";

const PARAMS = Type.Object({
	op: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("link"),
			Type.Literal("amend"),
			Type.Literal("merge"),
			Type.Literal("drop"),
		],
		{
			description:
				"create = new acceptance item from one or more change records; link = attach new records to an existing item; amend = revise an item's text; merge = fold duplicate items into one; drop = retire abandoned work.",
		},
	),
	item: Type.Optional(
		Type.String({
			description: "Target item id (link/amend/merge/drop). Omit for create — the id is generated.",
		}),
	),
	title: Type.Optional(Type.String({ description: "Short user-facing title (create/amend)." })),
	summary: Type.Optional(
		Type.String({
			description: "2-3 user-facing sentences: what the operator can now do or see (create/amend).",
		}),
	),
	steps: Type.Optional(
		Type.Array(Type.String({ description: "One test step and its expected result." }), {
			description: "How to verify by hand, 3-6 entries (create/amend).",
		}),
	),
	edge: Type.Optional(
		Type.Array(Type.String({ description: "One corner case worth a quick try." }), {
			description: "Optional edge cases (create/amend).",
		}),
	),
	skip: Type.Optional(
		Type.String({
			description: 'What NOT to test this round, e.g. "internal refactor, no user-visible change".',
		}),
	),
	spec: Type.Optional(Type.String({ description: "Spec this item implements, e.g. specs/ask-uat.md." })),
	area: Type.Optional(Type.String({ description: "Short area label used for grouping." })),
	reports: Type.Optional(
		Type.Array(Type.String({ description: "Change-record id, e.g. 2026-11-13_2107_ask-uat." }), {
			description: "Change records that are evidence for this item (create/link).",
		}),
	),
	sources: Type.Optional(
		Type.Array(Type.String({ description: "Item id to fold into `item`." }), {
			description: "Items absorbed into the target on merge.",
		}),
	),
	reason: Type.Optional(Type.String({ description: "Why the item is dropped (drop)." })),
});

const DESCRIPTION = `Create or maintain acceptance items for the UAT page.

An acceptance item is one user-visible behaviour the operator verifies by hand; a change
record is evidence, not an item. Prefer linking new records to an existing open item over
creating a near-duplicate. Every call appends to .agents/uat/ledger.jsonl; nothing is
rewritten, and no call edits code.`;

const GUIDELINES = [
	"Cluster change records into acceptance items: one item per behaviour a person can verify by hand, not one item per record.",
	"Write `summary` in 2-3 sentences from the operator's point of view; never mention file names or functions there.",
	"Use op=\"link\" when the new evidence belongs to an already-open item; create a new item only for a distinct behaviour.",
	"Use op=\"drop\" with a reason for work that shipped but never became user-visible, or that was abandoned.",
];

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

function summarize(item: UatItemView): string {
	return `${item.id} — ${item.title} (${item.reports.length} record${item.reports.length === 1 ? "" : "s"})`;
}

export interface UatItemToolOptions {
	/** Whether `/ask-uat` currently holds the phase open. */
	isActive: () => boolean;
	/** Batch id assigned to items created in this run. */
	currentBatch: () => string | undefined;
	now?: () => Date;
	root?: (cwd: string) => string;
}

export function registerUatItemTool(pi: ExtensionAPI, options: UatItemToolOptions): void {
	const now = options.now ?? (() => new Date());
	const rootOf = options.root ?? resolveProjectRoot;

	pi.registerTool<typeof PARAMS, { item?: string }>({
		name: UAT_ITEM_TOOL,
		label: "Acceptance item",
		description: DESCRIPTION,
		promptSnippet: "Create or maintain acceptance items (ask-uat only)",
		promptGuidelines: GUIDELINES,
		parameters: PARAMS,
		defaultActive: false,
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			if (!options.isActive()) {
				return errorResult("uat_item: no UAT run is open — use /ask-uat first.");
			}
			const root = rootOf(ctx.cwd || process.cwd());
			const records = listRecords(root);
			const recordIds = new Set(records.map((record) => record.id));
			const events = readEvents(ledgerPath(root)).events;
			const state = deriveState(records, events);
			const findItem = (id: string): UatItemView | undefined =>
				state.items.find((item) => item.id === id);
			const at = now();
			const itemStamp = isoMinute(at);
			const ts = at.toISOString();
			const append = (event: Parameters<typeof appendEvent>[1]): void =>
				appendEvent(ledgerPath(root), event);
			const base = { v: 1, id: newEventId(at), ts } as const;

			const checkReports = (reports: string[] | undefined): string[] | string => {
				const list = [...new Set((reports ?? []).map((value) => value.trim()).filter(Boolean))];
				if (list.length === 0) return "`reports` is required: at least one change-record id.";
				const unknown = list.filter((report) => !recordIds.has(report));
				if (unknown.length > 0) {
					return `Unknown change record(s): ${unknown.join(", ")}. Pass ids exactly as listed by /ask-uat.`;
				}
				return list;
			};

			switch (params.op) {
				case "create": {
					const title = (params.title ?? "").trim();
					const summary = (params.summary ?? "").trim();
					if (title === "") return errorResult("uat_item: `title` is required for create.");
					if (summary === "") return errorResult("uat_item: `summary` is required for create.");
					const reports = checkReports(params.reports);
					if (typeof reports === "string") return errorResult(`uat_item: ${reports}`);
					const suffix = base.id.slice(-6);
					const id = `U-${itemStamp.slice(0, 10).replace(/-/g, "")}-${itemStamp.slice(11, 13)}${itemStamp.slice(14, 16)}-${slugify(title)}-${suffix}`;
					append({
						...base,
						type: "item",
						item: id,
						batch: options.currentBatch(),
						title,
						summary,
						steps: (params.steps ?? []).map((step) => step.trim()).filter(Boolean),
						edge: (params.edge ?? []).map((edge) => edge.trim()).filter(Boolean),
						skip: params.skip?.trim() || undefined,
						reports,
						spec: params.spec?.trim() || undefined,
						area: params.area?.trim() || undefined,
					});
					return {
						content: [
							{
								type: "text" as const,
								text: `Created ${id} — ${title} (${reports.length} record${reports.length === 1 ? "" : "s"}). The page updates immediately.`,
							},
						],
						details: { item: id },
					};
				}
				case "link": {
					const item = findItem((params.item ?? "").trim());
					if (!item) return errorResult("uat_item: `item` must be an existing open item id.");
					const reports = checkReports(params.reports);
					if (typeof reports === "string") return errorResult(`uat_item: ${reports}`);
					const fresh = reports.filter((report) => !item.reports.includes(report));
					if (fresh.length === 0) {
						return {
							content: [
								{ type: "text" as const, text: `${item.id} already carries every listed record; nothing appended.` },
							],
							details: { item: item.id },
						};
					}
					append({ ...base, type: "link", item: item.id, reports: fresh });
					return {
						content: [
							{
								type: "text" as const,
								text: `Linked ${fresh.length} record${fresh.length === 1 ? "" : "s"} to ${summarize(item)}. If it was accepted, the page now shows it as reopened.`,
							},
						],
						details: { item: item.id },
					};
				}
				case "amend": {
					const item = findItem((params.item ?? "").trim());
					if (!item) return errorResult("uat_item: `item` must be an existing open item id.");
					const patch = {
						title: params.title?.trim() || undefined,
						summary: params.summary?.trim() || undefined,
						steps: params.steps?.map((step) => step.trim()).filter(Boolean),
						edge: params.edge?.map((edge) => edge.trim()).filter(Boolean),
						skip: params.skip?.trim() || undefined,
						spec: params.spec?.trim() || undefined,
					};
					if (Object.values(patch).every((value) => value === undefined)) {
						return errorResult("uat_item: amend needs at least one of title/summary/steps/edge/skip/spec.");
					}
					append({ ...base, type: "amend", item: item.id, ...patch });
					return {
						content: [{ type: "text" as const, text: `Amended ${item.id}.` }],
						details: { item: item.id },
					};
				}
				case "merge": {
					const item = findItem((params.item ?? "").trim());
					if (!item) return errorResult("uat_item: `item` must be the surviving item id.");
					const sources = [...new Set((params.sources ?? []).map((value) => value.trim()).filter(Boolean))];
					if (sources.length === 0) return errorResult("uat_item: `sources` is required for merge.");
					const unknown = sources.filter((source) => source !== item.id && !findItem(source));
					if (unknown.length > 0) {
						return errorResult(`uat_item: unknown source item(s): ${unknown.join(", ")}.`);
					}
					const real = sources.filter((source) => source !== item.id);
					if (real.length === 0) return errorResult("uat_item: merge needs at least one source besides the target.");
					append({ ...base, type: "merge", item: item.id, sources: real });
					return {
						content: [
							{
								type: "text" as const,
								text: `Merged ${real.length} item${real.length === 1 ? "" : "s"} into ${item.id}; their records now count as evidence for it.`,
							},
						],
						details: { item: item.id },
					};
				}
				case "drop": {
					const item = findItem((params.item ?? "").trim());
					if (!item) return errorResult("uat_item: `item` must be an existing open item id.");
					append({
						...base,
						type: "drop",
						item: item.id,
						reason: params.reason?.trim() || undefined,
					});
					return {
						content: [{ type: "text" as const, text: `Dropped ${item.id}.` }],
						details: { item: item.id },
					};
				}
				default:
					return errorResult("uat_item: unknown op.");
			}
		},
	});
}
