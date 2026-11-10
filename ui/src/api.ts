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

export interface PlanItem {
	status: BlockStatus;
	id: string;
	prevId?: string;
	html: string;
	label: string;
}

export interface PlanState {
	slug: string;
	version: number;
	totalVersions: number;
	at: string;
	source?: string;
	items: PlanItem[];
	annotations: Annotations;
	decision?: { action: Decision; at: string };
	decided: boolean;
	history: Array<{ n: number; at: string; changed: number }>;
}

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

export function fetchState(version?: number): Promise<PlanState> {
	return request<PlanState>(version === undefined ? "/api/state" : `/api/state?version=${version}`);
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
	return () => source.close();
}
