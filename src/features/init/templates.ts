/**
 * init feature — template loading and substitution.
 *
 * Templates fall into two groups:
 *  - files under `templates/` (shipped with the package, path-resolved from
 *    `import.meta.url` so a global install works);
 *  - seeds that live in code because they are localized (`SEEDS`, `PLAN_SEED`).
 *
 * A rendered template must never leak `{{token}}` syntax into a project, so the
 * loader fails loudly on an unresolved placeholder instead of writing it.
 */
import { readFileSync } from "node:fs";
import {
	PLAN_SEED,
	SEEDS,
	type ProjectLanguage,
} from "./spec.js";

const FILE_TEMPLATES = new Set([
	"agents-skeleton",
	"memory-readme",
	"signpost",
	"state-gitignore",
]);

/** Templates whose content is not Markdown (written verbatim). */
const RAW_TEMPLATES = new Set(["state-gitignore"]);

const SEED_TEMPLATES = new Set([
	"seed-finished",
	"seed-future",
	"seed-architecture",
]);

export function templateNames(): string[] {
	return [...FILE_TEMPLATES, ...SEED_TEMPLATES, "plan"];
}

/** Collapse runs of blank lines left behind by empty optional sections. */
function tidy(text: string): string {
	return `${text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trimEnd()}\n`;
}

export function renderTemplate(
	name: string,
	tokens: Record<string, string>,
	language: ProjectLanguage,
): string {
	let body: string;
	if (name === "plan") {
		body = PLAN_SEED[language];
	} else if (name.startsWith("seed-")) {
		const role = name.slice("seed-".length);
		body = SEEDS[language][role] ?? "";
		if (body.length === 0) throw new Error(`unknown seed template: ${name}`);
	} else if (FILE_TEMPLATES.has(name)) {
		// `.gitignore` content is not Markdown; keep it extension-less so Markdown
		// linters do not read its `#` comments as headings.
		const suffix = RAW_TEMPLATES.has(name) ? "" : ".md";
		body = readFileSync(new URL(`./templates/${name}${suffix}`, import.meta.url), "utf8");
	} else {
		throw new Error(
			`unknown template "${name}" (known: ${templateNames().join(", ")})`,
		);
	}

	const rendered = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
		const value = tokens[key];
		if (value === undefined) {
			throw new Error(`template "${name}" has no value for {{${key}}}`);
		}
		return value;
	});

	if (/\{\{/.test(rendered)) {
		throw new Error(`template "${name}" left a placeholder unresolved`);
	}
	return tidy(rendered);
}
