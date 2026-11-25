/**
 * The review page entry point.
 *
 * One bundle serves two modes (`/ask-spec` and `/ask-talk`): the state payload
 * says which, and the matching view renders. Blocks, note cards, the outline and
 * back-to-top are shared components, so the two modes cannot drift apart.
 *
 * The probe below is the only fetch this file does; each view keeps its own
 * state and subscriptions from there.
 */
import { Show, createSignal, onMount } from "solid-js";
import * as api from "./api";
import { SpecView } from "./SpecView";
import { TalkPage } from "./TalkPage";

export function App() {
	const [state, setState] = createSignal<api.PageState>();
	const [error, setError] = createSignal<string>();

	onMount(() => {
		api
			.fetchState()
			.then((next) => setState(next))
			.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	});

	return (
		<Show
			when={state()}
			fallback={
				<div class="page">
					<p class="empty">{error() ?? "Loading…"}</p>
				</div>
			}
		>
			{(loaded) => (
				<Show
					when={loaded().mode === "talk"}
					fallback={<SpecView initial={loaded() as api.SpecState} />}
				>
					<TalkPage initial={loaded() as api.TalkState} />
				</Show>
			)}
		</Show>
	);
}
