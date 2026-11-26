/**
 * The port pool is a shared one: `/ask-spec`, `/ask-uat` and `/ask-talk` all
 * walk from 7600, and a walk that left the hundred block would silently give
 * the next feature's pool away. These tests pin the range, not the feature.
 */
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { portWalk, startWebServer, type WebServerHandle } from "./web-review.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("portWalk", () => {
	it("walks the whole hundred block by default", () => {
		const ports = portWalk(7600);
		expect(ports[0]).toBe(7600);
		expect(ports.at(-1)).toBe(7699);
		expect(ports).toHaveLength(100);
	});

	it("honours an explicit attempt count", () => {
		expect(portWalk(7600, 20)).toEqual(
			Array.from({ length: 20 }, (_, index) => 7600 + index),
		);
	});

	it("stops at the end of the block instead of spilling into the next one", () => {
		expect(portWalk(7695, 20)).toEqual([7695, 7696, 7697, 7698, 7699]);
	});

	it("keeps a start on a boundary inside its own block", () => {
		expect(portWalk(7700, 3)).toEqual([7700, 7701, 7702]);
	});
});

describe("startWebServer", () => {
	it("reports an exhausted pool as a range, and does not start", async () => {
		const blocker = createNetServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(0, "127.0.0.1", resolve);
		});
		const port = (blocker.address() as AddressInfo).port;
		cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

		await expect(
			startWebServer({
				assetsDir: "/nonexistent-assets",
				routes: () => false,
				portStart: port,
				portAttempts: 1,
				bindHost: "127.0.0.1",
			}),
		).rejects.toThrow(`cannot bind a review server on ports ${port}–${port}`);
	});

	it("takes the next port in the same block for a second page", async () => {
		const start = 63_100 + Math.floor(Math.random() * 60);
		const first: WebServerHandle = await startWebServer({
			assetsDir: "/nonexistent-assets",
			routes: () => false,
			portStart: start,
			bindHost: "127.0.0.1",
		});
		cleanups.push(() => first.close());
		const second: WebServerHandle = await startWebServer({
			assetsDir: "/nonexistent-assets",
			routes: () => false,
			portStart: start,
			bindHost: "127.0.0.1",
		});
		cleanups.push(() => second.close());

		expect(second.port).toBe(first.port + 1);
		expect(Math.floor(second.port / 100)).toBe(Math.floor(start / 100));
	});
});
