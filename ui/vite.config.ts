import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * The review UI is a single page with no router and no SSR: our own node:http
 * server (src/features/plan/server.ts) serves `index.html` plus hashed assets
 * from `src/features/plan/assets/`, so the build output IS the shipped asset.
 *
 * `assetsDir: "."` keeps the hashed files next to index.html, which is what the
 * server's `/assets/<file>` route maps onto `assetsDir/<file>`.
 */
export default defineConfig({
	plugins: [solid()],
	base: "/",
	build: {
		outDir: "../src/features/plan/assets",
		assetsDir: ".",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: false,
	},
	server: {
		// `pnpm ui:dev`: the page talks to a live review server on 3401.
		proxy: { "/api": "http://127.0.0.1:3401" },
	},
});
