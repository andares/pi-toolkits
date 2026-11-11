/**
 * Typed access to the UAT server.
 *
 * Same contract as the plan page: the token comes from the URL the extension
 * opened, every API call echoes it, and SSE is how the page learns that
 * something changed (including changes written by another pi session).
 */
export interface UatItem {
	id: string;
	title: string;
	summary: string;
	steps: string[];
	edge: string[];
	skip?: string;
	spec?: string;
	area?: string;
	batch?: string;
	reports: string[];
	createdAt: string;
	checkedAt?: string;
	reopened: boolean;
	missingReports: string[];
}

export interface PendingRecord {
	id: string;
	title: string;
	at?: string;
	behavior?: string;
	hint?: string;
	area?: string;
}

export interface UatPayload {
	root: string;
	skipped: number;
	items: UatItem[];
	open: UatItem[];
	checked: UatItem[];
	pending: PendingRecord[];
	batches: Array<{ id: string; at: string; candidates: number }>;
	lastEventTs?: string;
	counts: {
		items: number;
		open: number;
		checked: number;
		pending: number;
		totalRecords: number;
	};
	records: Array<{ id: string; title: string; at?: string }>;
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

export function fetchState(): Promise<UatPayload> {
	return request<UatPayload>("/api/state");
}

export async function toggle(item: string, checked: boolean): Promise<UatPayload> {
	const response = await request<{ ok: boolean; state: UatPayload }>("/api/toggle", {
		method: "POST",
		body: JSON.stringify({ item, checked }),
	});
	return response.state;
}

export function fetchReport(id: string): Promise<{ id: string; text: string }> {
	return request<{ id: string; text: string }>(`/api/report?id=${encodeURIComponent(id)}`);
}

export function subscribe(onState: () => void, onError: (message: string) => void): () => void {
	const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
	source.addEventListener("state", () => onState());
	source.onerror = () => onError("connection lost — reopen the page from the extension");
	return () => source.close();
}
