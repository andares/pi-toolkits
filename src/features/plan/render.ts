/**
 * plan block rendering — markdown subset → HTML, server side.
 *
 * Why not a markdown library: the UI only needs to show prose, headings, lists,
 * code and tables of a document our own agent wrote, and a dependency here
 * would ship a parser (and its transitive surface) to every user of the
 * extension. Why not render in the browser: then the escaping rules live in a
 * second implementation that the test suite cannot reach.
 *
 * Everything is escaped first; the transformations below only ever insert
 * markup, so a plan that contains `<script>` renders as text. That is the whole
 * security model for this path — no raw HTML passthrough, by design.
 */
import type { Block } from "./blocks.js";

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Inline markup: code spans, bold, italic, links. Input is NOT escaped here. */
function renderInline(escaped: string): string {
	return escaped
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(
			/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
			'<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>',
		);
}

function inline(text: string): string {
	return renderInline(escapeHtml(text));
}

function renderHeading(lines: readonly string[]): string {
	const match = /^ {0,3}(#{1,6})\s+(.*)$/.exec(lines[0] ?? "");
	const level = match ? match[1].length : 1;
	const title = match ? match[2].replace(/\s+#+\s*$/, "") : (lines[0] ?? "");
	return `<h${level}>${inline(title)}</h${level}>`;
}

function renderQuote(lines: readonly string[]): string {
	const body = lines.map((line) => line.replace(/^ {0,3}>\s?/, "")).join("\n");
	return `<blockquote>${body
		.split("\n")
		.map((line) => `<p>${inline(line)}</p>`)
		.join("")}</blockquote>`;
}

function renderList(lines: readonly string[]): string {
	const ordered = /^ {0,3}\d{1,9}[.)]\s/.test(lines[0] ?? "");
	const items: string[] = [];
	for (const line of lines) {
		const bullet = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
		if (bullet) {
			items.push(bullet[1]);
		} else if (items.length > 0) {
			items[items.length - 1] += ` ${line.trim()}`;
		}
	}
	const tag = ordered ? "ol" : "ul";
	const body = items.map((item) => `<li>${inline(item)}</li>`).join("");
	return `<${tag}>${body}</${tag}>`;
}

function renderCode(lines: readonly string[]): string {
	const first = lines[0] ?? "";
	const opener = /^ {0,3}(?:`{3,}|~{3,})\s*([\w+#.-]*)/.exec(first);
	const language = opener?.[1] ? ` class="language-${escapeHtml(opener[1])}"` : "";
	const body = lines.slice(1, lines.length > 1 ? -1 : 1).join("\n");
	return `<pre><code${language}>${escapeHtml(body)}</code></pre>`;
}

function splitRow(line: string): string[] {
	const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
	return trimmed.split("|").map((cell) => cell.trim());
}

function renderTable(lines: readonly string[]): string {
	const rows = lines.filter((line) => !/^ {0,3}\|?[\s:-]*-{3,}[\s:|-]*$/.test(line));
	const [head, ...body] = rows.map(splitRow);
	const headHtml = head
		? `<thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`
		: "";
	const bodyHtml = body.length
		? `<tbody>${body
				.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
				.join("")}</tbody>`
		: "";
	return `<table>${headHtml}${bodyHtml}</table>`;
}

function renderText(lines: readonly string[]): string {
	return `<p>${lines.map((line) => inline(line)).join("<br />")}</p>`;
}

/** Render one block to HTML. Unknown kinds fall back to prose. */
export function renderBlockHtml(block: Pick<Block, "kind" | "text">): string {
	const lines = block.text.split("\n");
	switch (block.kind) {
		case "heading":
			return renderHeading(lines);
		case "quote":
			return renderQuote(lines);
		case "list":
			return renderList(lines);
		case "code":
			return renderCode(lines);
		case "table":
			return renderTable(lines);
		default:
			return renderText(lines);
	}
}
