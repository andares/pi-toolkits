/**
 * vitest config — exactly one deviation from the defaults.
 *
 * `/ask-init` (the `init` feature) keeps its runtime state in
 * `.agents/framework/`, which `.agents/framework/.gitignore` excludes from
 * version control. Its snapshots are byte copies of the working tree, so every
 * `*.test.ts` under `src/` is copied there as well. Vitest does not read
 * `.gitignore`, so without this exclude the copies are collected and fail at
 * import time (their sibling modules stay in `src/`).
 *
 * Measured 2026-10-26 on the adoption run: 36 test files collected, 6 failed
 * (all of them snapshot copies, 0 tests inside), 588 tests passed.
 */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, "**/.agents/framework/**"],
	},
});
