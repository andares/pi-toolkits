import { describe, expect, it } from "vitest";
import { parseBlocks } from "./blocks.js";
import { escapeHtml, renderBlockHtml } from "./render.js";

const render = (markdown: string): string => {
	const [block] = parseBlocks(markdown);
	if (!block) throw new Error(`no block parsed from: ${markdown}`);
	return renderBlockHtml(block);
};

describe("escapeHtml", () => {
	it("escapes the five entities", () => {
		expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
			"&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;",
		);
	});
});

describe("renderBlockHtml", () => {
	it("never passes raw HTML through", () => {
		const html = render("<script>alert(1)</script>");
		expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
	});

	it("renders inline code, bold, italic and links", () => {
		const html = render("use `plan_submit` and **never** *skip* [the spec](https://example.com/x)");
		expect(html).toContain("<code>plan_submit</code>");
		expect(html).toContain("<strong>never</strong>");
		expect(html).toContain("<em>skip</em>");
		expect(html).toContain('href="https://example.com/x"');
		expect(html).toContain('rel="noreferrer noopener"');
	});

	it("keeps HTML escaped inside inline code", () => {
		expect(render("`<b>`")).toBe("<p><code>&lt;b&gt;</code></p>");
	});

	it("renders headings at their level", () => {
		expect(render("### Step three")).toBe("<h3>Step three</h3>");
	});

	it("strips closing hashes from a heading", () => {
		expect(render("## Title ##")).toBe("<h2>Title</h2>");
	});

	it("renders a code fence verbatim with its language", () => {
		const html = render("```ts\nconst a = 1 < 2;\n\nif (a) run();\n```");
		expect(html).toBe(
			'<pre><code class="language-ts">const a = 1 &lt; 2;\n\nif (a) run();</code></pre>',
		);
	});

	it("does not run inline markup inside code", () => {
		expect(render("```\n**not bold** <tag>\n```")).toBe(
			"<pre><code>**not bold** &lt;tag&gt;</code></pre>",
		);
	});

	it("renders unordered and ordered lists", () => {
		expect(render("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
		expect(render("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
		// a continuation line belongs to the item above it
		expect(render("- one\n  continued")).toBe("<ul><li>one continued</li></ul>");
	});

	it("renders block quotes with their marker stripped", () => {
		expect(render("> quoted text")).toBe("<blockquote><p>quoted text</p></blockquote>");
	});

	it("renders a table with a header and body", () => {
		const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |");
		expect(html).toBe(
			"<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
				"<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
		);
	});

	it("joins prose lines with <br />", () => {
		expect(render("first line\nsecond line")).toBe("<p>first line<br />second line</p>");
	});
});
