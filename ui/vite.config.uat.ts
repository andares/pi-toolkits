import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

/**
 * The acceptance page is a second, independent single page. It lives under
 * `ui/uat/` so Vite emits `index.html` (the server always serves index.html)
 * and its hashed assets into the feature's own assets directory.
 *
 * Two configs instead of one multi-page build: each feature owns its output
 * directory, and `pnpm ui:check` can diff them separately.
 */
export default defineConfig({
	plugins: [solid()],
	root: "uat",
	base: "/",
	build: {
		outDir: "../../src/features/uat/assets",
		assetsDir: ".",
		emptyOutDir: true,
		target: "es2022",
		sourcemap: false,
	},
	server: {
		// `pnpm --filter @andares/pi-toolkits-ui dev:uat`: talks to a live /ask-uat server.
		proxy: { "/api": "http://127.0.0.1:3401" },
	},
});
