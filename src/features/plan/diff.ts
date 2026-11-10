/**
 * plan block diff — round-over-round change detection at block granularity.
 *
 * A plan revision is compared against the previous one to answer one question
 * per block: unchanged, moved, modified, added, or removed. That answer drives
 * the badges in the review UI and the "(modified)" tag in the feedback text the
 * agent reads, so it has to be honest: a block with three swapped words is
 * "modified", not "one deleted + one added", and a paragraph that only changed
 * position is "moved", not an edit — otherwise every small revision looks like
 * a rewrite and the operator stops trusting the badges.
 *
 * How, in order:
 *   1. Blocks with the same id (identical normalized text) are matched. The
 *      longest increasing subsequence of those matches is the set of anchors
 *      ("unchanged") — the largest subset that keeps its order.
 *   2. Matched blocks outside that subsequence changed position → "moved".
 *   3. Id-less blocks are paired by text similarity (character-bigram Jaccard
 *      ≥ 0.5) → "modified"; the leftovers are "added" / "removed".
 *
 * No dependency: the LIS is patience-style on tens of blocks, and similarity is
 * bigrams because plans mix English and CJK (word splitting would collapse a
 * Chinese sentence into one token).
 */
import type { Block } from "./blocks.js";

export type BlockStatus = "unchanged" | "moved" | "modified" | "added" | "removed";

export interface DiffEntry {
	status: BlockStatus;
	/** Block id in the new version; for `removed` this is the old id. */
	id: string;
	/** Previous id, set for `moved`, `modified` and `removed`. */
	prevId?: string;
}

/** Jaccard threshold for calling two unmatched blocks "the same block, edited". */
const SIMILARITY_THRESHOLD = 0.5;

/** Character bigrams of a block's normalized text. */
function bigrams(text: string): Set<string> {
	const flat = text.replace(/\s+/g, " ").trim();
	const set = new Set<string>();
	for (let i = 0; i < flat.length - 1; i += 1) set.add(flat.slice(i, i + 2));
	if (flat.length === 1) set.add(flat);
	return set;
}

/** Jaccard similarity of two blocks, 0…1. */
export function blockSimilarity(a: Pick<Block, "text">, b: Pick<Block, "text">): number {
	const left = bigrams(a.text);
	const right = bigrams(b.text);
	if (left.size === 0 && right.size === 0) return 1;
	let shared = 0;
	for (const gram of left) if (right.has(gram)) shared += 1;
	return shared / (left.size + right.size - shared);
}

/**
 * Longest increasing subsequence of `values` (patience sorting), returned as
 * the indices into `values` that survive. Ties keep the earliest possible set,
 * which makes the "unchanged" choice deterministic.
 */
function longestIncreasing(values: readonly number[]): Set<number> {
	const tails: number[] = []; // tails[k] = index in `values` of the smallest tail of a run of length k+1
	const previous: number[] = new Array<number>(values.length).fill(-1);
	for (let i = 0; i < values.length; i += 1) {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (values[tails[mid]] < values[i]) low = mid + 1;
			else high = mid;
		}
		if (low > 0) previous[i] = tails[low - 1];
		tails[low] = i;
	}
	const keep = new Set<number>();
	let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
	while (cursor !== -1) {
		keep.add(cursor);
		cursor = previous[cursor];
	}
	return keep;
}

/** Greedy best-first pairing of unmatched old/new blocks inside one gap. */
function pairBySimilarity(
	prevIndices: readonly number[],
	nextIndices: readonly number[],
	prev: readonly Block[],
	next: readonly Block[],
): Map<number, number> {
	const candidates: Array<{ nextIndex: number; prevIndex: number; score: number }> = [];
	for (const nextIndex of nextIndices) {
		for (const prevIndex of prevIndices) {
			const score = blockSimilarity(prev[prevIndex], next[nextIndex]);
			if (score >= SIMILARITY_THRESHOLD) {
				candidates.push({ nextIndex, prevIndex, score });
			}
		}
	}
	candidates.sort((a, b) => b.score - a.score);
	const pairing = new Map<number, number>(); // next index -> prev index
	const usedPrev = new Set<number>();
	for (const candidate of candidates) {
		if (pairing.has(candidate.nextIndex) || usedPrev.has(candidate.prevIndex)) continue;
		pairing.set(candidate.nextIndex, candidate.prevIndex);
		usedPrev.add(candidate.prevIndex);
	}
	return pairing;
}

/**
 * Diff two revisions. Entries are in reading order of the new revision, with
 * removed blocks surfacing where they vanished — which is how a reviewer reads
 * a change.
 */
export function diffBlocks(prev: readonly Block[], next: readonly Block[]): DiffEntry[] {
	const prevIndexById = new Map<string, number>();
	prev.forEach((block, index) => prevIndexById.set(block.id, index));

	// Same id ⇒ same normalized text, wherever it sits now.
	const matches: Array<{ nextIndex: number; prevIndex: number }> = [];
	next.forEach((block, nextIndex) => {
		const prevIndex = prevIndexById.get(block.id);
		if (prevIndex !== undefined) matches.push({ nextIndex, prevIndex });
	});

	const anchors = longestIncreasing(matches.map((match) => match.prevIndex));
	const anchorOf = new Map<number, number>(); // next index -> prev index, unchanged
	const movedOf = new Map<number, number>(); // next index -> prev index, moved
	matches.forEach((match, position) => {
		if (anchors.has(position)) anchorOf.set(match.nextIndex, match.prevIndex);
		else movedOf.set(match.nextIndex, match.prevIndex);
	});
	const consumedPrev = new Set(matches.map((match) => match.prevIndex));

	const entries: DiffEntry[] = [];
	let prevCursor = 0;
	let gap: number[] = []; // next indices that belong to the current gap

	const emitGap = (prevEnd: number): void => {
		const removable: number[] = [];
		for (let index = prevCursor; index < prevEnd; index += 1) {
			if (!consumedPrev.has(index)) removable.push(index);
		}
		const movable = gap.filter((nextIndex) => movedOf.has(nextIndex));
		const plain = gap.filter((nextIndex) => !movedOf.has(nextIndex));
		const pairing = pairBySimilarity(removable, plain, prev, next);
		const pairedPrev = new Set(pairing.values());

		for (const prevIndex of removable) {
			if (pairedPrev.has(prevIndex)) continue;
			entries.push({ status: "removed", id: prev[prevIndex].id, prevId: prev[prevIndex].id });
		}
		void movable;
		for (const nextIndex of gap) {
			const movedFrom = movedOf.get(nextIndex);
			if (movedFrom !== undefined) {
				entries.push({
					status: "moved",
					id: next[nextIndex].id,
					prevId: prev[movedFrom].id,
				});
				continue;
			}
			const pairedWith = pairing.get(nextIndex);
			if (pairedWith !== undefined) {
				entries.push({
					status: "modified",
					id: next[nextIndex].id,
					prevId: prev[pairedWith].id,
				});
				continue;
			}
			entries.push({ status: "added", id: next[nextIndex].id });
		}
		gap = [];
		prevCursor = prevEnd;
	};

	for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
		const anchor = anchorOf.get(nextIndex);
		const moved = movedOf.get(nextIndex);
		// Anchors are increasing by construction (LIS), so the cursor can move
		// forward on them. A moved block only flushes the gap up to its old
		// position: its own old index is taken out of the removable pool, but
		// the cursor must NOT jump past anchors that come later in the new
		// document (that would turn them into "added").
		if (anchor !== undefined) {
			if (anchor >= prevCursor) emitGap(anchor);
			entries.push({ status: "unchanged", id: next[nextIndex].id });
			prevCursor = Math.max(prevCursor, anchor + 1);
			continue;
		}
		if (moved !== undefined) {
			if (moved >= prevCursor) emitGap(moved);
			entries.push({ status: "moved", id: next[nextIndex].id, prevId: prev[moved].id });
			continue;
		}
		gap.push(nextIndex);
	}
	emitGap(prev.length);
	return entries;
}

/** Count of blocks whose status is not `unchanged` (what the UI calls "changed"). */
export function countChanged(entries: readonly DiffEntry[]): number {
	return entries.filter((entry) => entry.status !== "unchanged").length;
}
