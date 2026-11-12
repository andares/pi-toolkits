/**
 * whats-new feature — release notes on the first start after an upgrade.
 *
 * Behavior:
 *  - `session_start(reason="startup")` in the TUI is the only trigger. A
 *    `reload` / `resume` / `new` / `fork` is an in-process transition and must
 *    not replay notes the operator already saw. print/json/rpc sessions have no
 *    transcript to append to, so they leave the notice for the first interactive
 *    start instead of silently consuming it.
 *  - The store records the highest version already handled. A missing record
 *    means a fresh install: the running version is recorded silently, because
 *    there is no "previous version" to report from. A version at or below the
 *    record (downgrade, reinstall) is not an upgrade and shows nothing.
 *  - Notes come from the bundled `CHANGELOG.md`, filtered to
 *    `lastSeen < version <= running`. A version with no section reports the
 *    version change and says that no notes are bundled.
 *  - The notice is a custom session entry — own text, immune to
 *    `ui.invalidate()` and out of the model context (same reason as the
 *    permission feature's autostart notice; see that module's header).
 *  - Deliberately no global slash command: this package is a plugin, and the
 *    automatic notice must not claim command namespace from the host.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	readChangelog,
	readPackageVersion,
	releasesForUpgrade,
} from "./changelog.js";
import { NOTICE_ENTRY } from "./constants.js";
import { buildUpgradeNotice, type NoticeData } from "./notice.js";
import { defaultChangelogFile, defaultPackageFile } from "./paths.js";
import { WhatsNewStore } from "./store.js";
import { compareVersions } from "./version.js";

export interface WhatsNewOptions {
	/** State file; defaults to `<agent-dir>/pi-toolkits-whats-new.json`. */
	readonly storeFile?: string;
	/** Release notes file; defaults to the packaged `CHANGELOG.md`. */
	readonly changelogFile?: string;
	/** Package manifest to read the running version from. */
	readonly packageFile?: string;
	/** Explicit running version (tests); overrides `packageFile`. */
	readonly version?: string;
}

interface WhatsNewRuntime {
	readonly store: WhatsNewStore;
	readonly changelogFile: string;
	readonly packageFile: string;
	readonly version?: string;
	/** Versions already handled in this process (a store write may fail). */
	readonly announced: Set<string>;
	present(ctx: ExtensionContext, data: NoticeData): void;
}

function runningVersion(runtime: WhatsNewRuntime): string | undefined {
	return runtime.version ?? readPackageVersion(runtime.packageFile);
}

/** Show the notes for a genuine upgrade, then record the running version. */
function announceUpgrade(runtime: WhatsNewRuntime, ctx: ExtensionContext): void {
	const version = runningVersion(runtime);
	if (version === undefined || runtime.announced.has(version)) return;

	const { store } = runtime;
	const from = store.get().lastSeenVersion;
	if (from !== undefined && compareVersions(version, from) <= 0) return;

	// A fresh install has no previous version to report from.
	if (from !== undefined) {
		try {
			const releases = releasesForUpgrade(
				readChangelog(runtime.changelogFile),
				from,
				version,
			);
			runtime.present(ctx, buildUpgradeNotice(from, version, releases));
		} catch (error) {
			// pi-lens-ignore: no-console-except-error,console-statement, — deliberate degradation log
			console.warn(
				"[pi-toolkits/whats-new] Failed to render release notes:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	// Marked even if rendering failed: a broken notice must not repeat on every
	// start (the notes remain in the package's CHANGELOG.md).
	store.markSeen(version);
	runtime.announced.add(version);
}

export function registerWhatsNew(
	pi: ExtensionAPI,
	options: WhatsNewOptions = {},
): void {
	const supportsEntryRenderer =
		typeof pi.registerEntryRenderer === "function";
	if (supportsEntryRenderer) {
		pi.registerEntryRenderer<NoticeData>(NOTICE_ENTRY, (entry, _options, theme) => {
			const data = entry.data;
			if (!data || !Array.isArray(data.lines)) return undefined;
			return new Text(
				[
					theme.bold(data.title),
					...data.lines.map((line) => theme.fg("dim", line)),
				].join("\n"),
				1,
				0,
			);
		});
	}

	const runtime: WhatsNewRuntime = {
		store: new WhatsNewStore(options.storeFile),
		changelogFile: options.changelogFile ?? defaultChangelogFile(),
		packageFile: options.packageFile ?? defaultPackageFile(),
		version: options.version,
		announced: new Set<string>(),
		/** Entry when the host can render one, one status notice otherwise. */
		present(ctx, data) {
			if (supportsEntryRenderer) {
				pi.appendEntry<NoticeData>(NOTICE_ENTRY, data);
				return;
			}
			ctx.ui.notify([data.title, ...data.lines].join("\n"), "info");
		},
	};

	let currentSessionId: string | undefined;

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;
		// No transcript to append to (print/json/rpc): keep the notice for the
		// first interactive start rather than burning it here.
		if (ctx.mode !== "tui") return;

		// A runtime rebind can emit session_start again for the same session.
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== undefined && sessionId === currentSessionId) return;
		currentSessionId = sessionId;

		announceUpgrade(runtime, ctx);
	});
}
