import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import * as api from "./api";

/**
 * The acceptance page.
 *
 * One job: show what was shipped but not yet verified, and let the operator
 * tick it off. Everything else is deliberately absent — no editing, no submit,
 * no ordering, no comments. Clustering quality is the agent's problem and is
 * fixed by asking in chat, not by a form.
 */
export function App() {
	const [state, setState] = createSignal<api.UatPayload>();
	const [error, setError] = createSignal<string>();
	const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
	const [report, setReport] = createSignal<{ id: string; text: string }>();
	const [busy, setBusy] = createSignal<string>();

	async function load(): Promise<void> {
		try {
			setState(await api.fetchState());
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	onMount(() => {
		void load();
		const stop = api.subscribe(
			() => void load(),
			(message) => setError(message),
		);
		onCleanup(stop);
	});

	const open = createMemo(() => state()?.open ?? []);
	const checked = createMemo(() => state()?.checked ?? []);
	const pending = createMemo(() => state()?.pending ?? []);

	function toggleExpanded(id: string): void {
		const next = new Set(expanded());
		if (next.has(id)) next.delete(id);
		else next.add(id);
		setExpanded(next);
	}

	async function setChecked(id: string, value: boolean): Promise<void> {
		setBusy(id);
		try {
			const next = await api.toggle(id, value);
			setState(next);
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(undefined);
		}
	}

	async function showReport(id: string): Promise<void> {
		try {
			setReport(await api.fetchReport(id));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	return (
		<div class="shell">
			<header class="head">
				<div>
					<h1>Acceptance</h1>
					<p class="sub">
						<Show when={state()} fallback="loading…">
							{(current) => (
								<>
									<span>{current().counts.open} open</span>
									<span class="dot">·</span>
									<span>{current().counts.checked} accepted</span>
									<span class="dot">·</span>
									<span>{current().counts.pending} records not clustered</span>
								</>
							)}
						</Show>
					</p>
				</div>
				<button class="ghost" onClick={() => void load()}>
					refresh
				</button>
			</header>

			<Show when={error()}>
				<p class="banner error">{error()}</p>
			</Show>

			<Show when={state()?.skipped}>
				{(count) => (
					<p class="banner error">
						{count()} malformed ledger line(s) were skipped — check .agents/uat/ledger.jsonl.
					</p>
				)}
			</Show>

			<Show when={pending().length > 0}>
				<p class="banner warn">
					{pending().length} change record{pending().length === 1 ? "" : "s"} not clustered yet —
					run <code>/ask-uat</code> to turn them into acceptance items.
				</p>
			</Show>

			<Show when={state() && open().length === 0}>
				<p class="empty">
					Nothing to verify. Run <code>/ask-uat</code> after the next round of changes lands.
				</p>
			</Show>

			<ul class="items">
				<For each={open()}>
					{(item) => (
						<li class="item">
							<label class="check">
								<input
									type="checkbox"
									checked={false}
									disabled={busy() === item.id}
									onChange={() => void setChecked(item.id, true)}
								/>
							</label>
							<div class="body">
								<div class="row">
									<h2>{item.title}</h2>
									<span class="badges">
										<Show when={item.reopened}>
											<span class="badge reopened">reopened</span>
										</Show>
										<span class="badge">
											{item.reports.length} record{item.reports.length === 1 ? "" : "s"}
										</span>
										<span class="badge">
											{new Date(item.createdAt).toLocaleDateString()}
										</span>
										<Show when={item.area}>
											<span class="badge area">{item.area}</span>
										</Show>
									</span>
								</div>
								<p class="summary">{item.summary}</p>
								<button class="more" onClick={() => toggleExpanded(item.id)}>
									{expanded().has(item.id) ? "hide test plan" : "show test plan"}
								</button>

								<Show when={expanded().has(item.id)}>
									<div class="details">
										<Show when={item.steps.length > 0}>
											<ol class="steps">
												<For each={item.steps}>{(step) => <li>{step}</li>}</For>
											</ol>
										</Show>
										<Show when={item.edge.length > 0}>
											<p class="label">Edge cases</p>
											<ul class="edge">
												<For each={item.edge}>{(edge) => <li>{edge}</li>}</For>
											</ul>
										</Show>
										<Show when={item.skip}>
											<p class="skip">Not under test: {item.skip}</p>
										</Show>
										<Show when={item.spec}>
											<p class="skip">Spec: {item.spec}</p>
										</Show>
										<p class="label">Evidence</p>
										<div class="evidence">
											<For each={item.reports}>
												{(id) => (
													<button class="chip" onClick={() => void showReport(id)}>
														{id}
													</button>
												)}
											</For>
										</div>
									</div>
								</Show>
							</div>
						</li>
					)}
				</For>
			</ul>

			<Show when={checked().length > 0}>
				<details class="accepted">
					<summary>{checked().length} accepted — expand to undo a tick</summary>
					<ul class="items compact">
						<For each={checked()}>
							{(item) => (
								<li class="item done">
									<label class="check">
										<input
											type="checkbox"
											checked={true}
											disabled={busy() === item.id}
											onChange={() => void setChecked(item.id, false)}
										/>
									</label>
									<div class="body">
										<div class="row">
											<h2>{item.title}</h2>
											<span class="badges">
												<span class="badge">
													accepted {new Date(item.checkedAt ?? item.createdAt).toLocaleString()}
												</span>
											</span>
										</div>
										<p class="summary">{item.summary}</p>
										<button class="more" onClick={() => toggleExpanded(item.id)}>
											{expanded().has(item.id) ? "hide test plan" : "show test plan"}
										</button>
										<Show when={expanded().has(item.id)}>
											<div class="details">
												<ol class="steps">
													<For each={item.steps}>{(step) => <li>{step}</li>}</For>
												</ol>
												<div class="evidence">
													<For each={item.reports}>
														{(id) => (
															<button class="chip" onClick={() => void showReport(id)}>
																{id}
															</button>
														)}
													</For>
												</div>
											</div>
										</Show>
									</div>
								</li>
							)}
						</For>
					</ul>
				</details>
			</Show>

			<Show when={report()}>
				{(current) => (
					<div class="drawer">
						<div class="drawer-head">
							<strong>{current().id}</strong>
							<button class="ghost" onClick={() => setReport(undefined)}>
								close
							</button>
						</div>
						<pre>{current().text}</pre>
					</div>
				)}
			</Show>

			<footer class="foot">
				<Show when={state()?.root}>
					<span>{state()!.root}</span>
				</Show>
			</footer>
		</div>
	);
}
