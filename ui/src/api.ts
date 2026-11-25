/**
 * Typed access to the review server.
 *
 * The token comes from the URL the extension opened; it is echoed back on every
 * API call. Nothing here caches or persists state: the server owns it, and SSE
 * is the only way the page learns about a new revision.
 */
export type Verdict = "change" | "suggest" | "question";
export type BlockStatus = "unchanged" | "moved" | "modified" | "added" | "removed";
export type Decision = "approve" | "deny";
export type Mode = "spec" | "talk";

/** One outline row; the anchor is a block, not a line. */
export interface Heading {
	blockId: string;
	/** 1–6. */
	level: number;
	text: string;
}

export interface Annotation {
	verdict: Verdict;
	comment: string;
}

export interface BlockAnnotations {
	blockId: string;
	annotations: Annotation[];
}

export interface Annotations {
	global: Annotation[];
	blocks: BlockAnnotations[];
}

export interface SpecItem {
	/** Absent in talk mode: a snapshot has no diff against anything. */
	status?: BlockStatus;
	/** Talk mode uses this to keep headings navigable but not annotatable. */
	kind?: "heading" | "text" | "list" | "code" | "table" | "quote";
	id: string;
	prevId?: string;
	html: string;
	label: string;
}

export interface SpecState {
	mode: "spec";
	slug: string;
	version: number;
	totalVersions: number;
	at: string;
	source?: string;
	items: SpecItem[];
	annotations: Annotations;
	decision?: { action: Decision; at: string };
	decided: boolean;
	history: Array<{ n: number; at: string; changed: number }>;
	headings: Heading[];
}

/** `/ask-talk`: one reply, one note per block, one composer, no versions. */
export interface TalkState {
	mode: "talk";
	reply: { model?: string; at: string; chars: number };
	items: SpecItem[];
	headings: Heading[];
	notes: Record<string, string>;
	draft: string;
	sent: boolean;
}

export type PageState = SpecState | TalkState;

const token = new URLSearchParams(window.location.search).get("t") ?? "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			"x-plan-token": token,
			...(init.headers ?? {}),
		},
	});
	if (!response.ok) {
		throw new Error(`${init.method ?? "GET"} ${path} → HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

export function fetchState(version?: number): Promise<PageState> {
	return request<PageState>(version === undefined ? "/api/state" : `/api/state?version=${version}`);
}

export function postTalkNotes(notes: Record<string, string>, draft: string): Promise<{ ok: true }> {
	return request<{ ok: true }>("/api/notes", {
		method: "POST",
		body: JSON.stringify({ notes, draft }),
	});
}

export function postContinue(notes: Record<string, string>, message: string): Promise<{ ok: true }> {
	return request<{ ok: true }>("/api/continue", {
		method: "POST",
		body: JSON.stringify({ notes, message }),
	});
}

export function postAnnotations(version: number, annotations: Annotations): Promise<{ ok: true }> {
	return request<{ ok: true }>("/api/annotate", {
		method: "POST",
		body: JSON.stringify({ version, annotations }),
	});
}

export function postDecision(action: Decision, version: number): Promise<{ ok: true }> {
	return request<{ ok: true }>("/api/decide", {
		method: "POST",
		body: JSON.stringify({ action, version }),
	});
}

export interface EventHandlers {
	onRevision: (version: number) => void;
	onAnnotations: () => void;
	onDecided: (decision: { action: Decision; version: number }) => void;
	/** talk mode: the snapshot was replaced (or is being re-shown). */
	onRefresh?: () => void;
	/** talk mode: Continue was accepted; the port closes right after. */
	onSent?: () => void;
}

/** SSE payloads are ours, but a malformed frame must not break the page. */
function parseEvent<T>(event: Event): T | undefined {
	try {
		return JSON.parse((event as MessageEvent<string>).data) as T;
	} catch {
		return undefined;
	}
}

/** Subscribe to server pushes; returns the unsubscribe function. */
export function subscribe(handlers: EventHandlers): () => void {
	const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
	source.addEventListener("revision", (event) => {
		const data = parseEvent<{ version: number }>(event);
		if (data) handlers.onRevision(data.version);
	});
	source.addEventListener("annotations", () => handlers.onAnnotations());
	source.addEventListener("decided", (event) => {
		const data = parseEvent<{ action: Decision; version: number }>(event);
		if (data) handlers.onDecided(data);
	});
	source.addEventListener("refresh", () => handlers.onRefresh?.());
	source.addEventListener("sent", () => handlers.onSent?.());
	return () => source.close();
}
