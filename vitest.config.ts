/**
 * vitest config — two deviations from the defaults, both measured.
 *
 * 1. `exclude`: `/ask-init` (the `init` feature) keeps its runtime state in
 *    `.agents/framework/`, which `.agents/framework/.gitignore` excludes from
 *    version control. Its snapshots are byte copies of the working tree, so
 *    every `*.test.ts` under `src/` is copied there as well. Vitest does not
 *    read `.gitignore`, so without this exclude the copies are collected and
 *    fail at import time (their sibling modules stay in `src/`).
 *
 *    Measured 2026-10-26 on the adoption run: 36 test files collected, 6 failed
 *    (all of them snapshot copies, 0 tests inside), 588 tests passed.
 *
 * 2. `maxWorkers` / timeouts: the host-compat matrix (`pnpm check:compat`)
 *    runs four sandboxes at once, each with its own `node_modules` and module
 *    graph, next to `tsc`. Vitest's default worker count is cores - 1 (21 on
 *    this 22-core machine), so peak memory — not correctness — was the limit:
 *    single-version runs were green while a matrix run failed a *different*
 *    test each time (2026-11-04: 1.0.2's git fixture test, then 1.0.1's
 *    dynamic-import test), which silently dragged the public floor down to
 *    the noise. Bounding the pool and giving subprocess/dynamic-import tests
 *    room keeps the gate measuring the host instead of the machine.
 *
 * 3. `env.TZ`: the zone is pinned to UTC so "green here" means "green in CI".
 *    A record header carries the machine's numeric offset (`+08:00` locally,
 *    `+00:00` on the runner), so a hand-written offset in an assertion passed
 *    here and failed the v0.13.0 publish (run 43093038001). Assertions derive
 *    such stamps from the code under test; the pinned zone makes any future
 *    one fail identically on both machines instead of only in CI.
 *    `scripts/check-compat.mjs` runs its sandboxes without this file, so it
 *    pins the same zone on the `vitest run` it spawns.
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, "**/.agents/framework/**"],
		env: { TZ: "UTC" },
		maxWorkers: 4,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
