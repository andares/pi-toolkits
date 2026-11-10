/**
 * Wiring between the built UI and the review server.
 *
 * The UI is a separate Vite app whose output is committed to
 * `src/features/plan/assets/` (see `pnpm ui:check`). These assertions catch the
 * failure that would otherwise only show up in a browser: the page shipping a
 * bundle path the server cannot resolve (Vite's `assetsDir` and the server's
 * `/assets/<file>` route have to agree).
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPlanServer } from "./server.js";
import { createPlanSession } from "./store.js";

const assetsDir = new URL("./assets/", import.meta.url).pathname;
const built = existsSync(join(assetsDir, "index.html"));
let agentDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-plan-assets-"));
});

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe.skipIf(!built)("built UI assets", () => {
	it("serves the built page and the bundle it references", async () => {
		const session = createPlanSession({ agentDir, slug: "assets", text: "## Plan\n\nbody" });
		const server = await startPlanServer({
			session,
			portStart: 44_000 + Math.floor(Math.random() * 1000),
			portAttempts: 20,
			bindHost: "127.0.0.1",
			urlHost: "127.0.0.1",
			closeDelayMs: 0,
		});
		try {
			const page = await fetch(`http://127.0.0.1:${server.port}/?t=${server.token}`);
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain('<div id="root">');

			const assetPath = /src="([^"]+\.js)"/.exec(html)?.[1];
			expect(assetPath, "the built page must reference its bundle").toBeTruthy();
			const bundle = await fetch(`http://127.0.0.1:${server.port}${assetPath}`);
			expect(bundle.status).toBe(200);
			expect(bundle.headers.get("content-type")).toContain("javascript");
			expect((await bundle.text()).length).toBeGreaterThan(1000);

			const stylePath = /href="([^"]+\.css)"/.exec(html)?.[1];
			if (stylePath) {
				const style = await fetch(`http://127.0.0.1:${server.port}${stylePath}`);
				expect(style.status).toBe(200);
				expect(style.headers.get("content-type")).toContain("text/css");
			}
		} finally {
			await server.close();
		}
	});
});
