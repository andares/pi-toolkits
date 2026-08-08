/**
 * stash feature — PromptStash state machine tests.
 *
 * All branches are deterministic via injected `now`:
 *  - empty-cache first press = stash + clear
 *  - single press = swap; spaced second press = toggle back
 *  - double press (within 400ms) = stash current + clear editor, old stash
 *    discarded
 *  - two presses beyond the window = normal swap (not clear)
 *  - triple press: the third press is a fresh swap
 */
import { describe, expect, it } from "vitest";
import { PromptStash, STASH_DOUBLE_PRESS_MS } from "./stash.js";

describe("PromptStash", () => {
	it("first press with empty cache stashes the text and clears the editor", () => {
		const stash = new PromptStash();
		const result = stash.press("write tests first", 1_000);
		expect(result).toEqual({
			text: "",
			kind: "swap",
			stashed: "write tests first",
		});
		expect(stash.peek()).toBe("write tests first");
	});

	it("swaps editor text with the stash on a normal press", () => {
		const stash = new PromptStash();
		stash.press("first prompt", 1_000); // stash = "first prompt"
		// User types a new prompt, then presses the hotkey.
		const result = stash.press("second prompt", 2_000);
		expect(result.text).toBe("first prompt"); // old stash fills the editor
		expect(result.stashed).toBe("second prompt"); // current text went to cache
		expect(stash.peek()).toBe("second prompt");
	});

	it("toggles back and forth between the two prompts on spaced presses", () => {
		const stash = new PromptStash();
		stash.press("A", 1_000);
		stash.press("B", 2_000); // editor gets A, cache = B
		// Press again (outside the double-press window): swap back.
		const back = stash.press("A", 3_000); // editor currently shows A
		expect(back.text).toBe("B");
		expect(back.stashed).toBe("A");
		// And again: swap forward.
		const forth = stash.press("B", 4_000);
		expect(forth.text).toBe("A");
		expect(forth.stashed).toBe("B");
	});

	it("double press within the window stashes current text and clears the editor", () => {
		const stash = new PromptStash();
		stash.press("old stash", 1_000); // cache = "old stash"
		// User types "current prompt", presses once (swap), then quickly again.
		const first = stash.press("current prompt", 2_000);
		expect(first.text).toBe("old stash"); // editor momentarily shows old stash
		const second = stash.press(
			"old stash",
			2_000 + STASH_DOUBLE_PRESS_MS - 1, // within the window
		);
		expect(second.kind).toBe("stash-clear");
		expect(second.text).toBe(""); // editor cleared
		expect(second.stashed).toBe("current prompt"); // cache kept the current prompt
		expect(stash.peek()).toBe("current prompt");
	});

	it("exactly at the window boundary counts as a double press", () => {
		const stash = new PromptStash();
		stash.press("A", 1_000);
		stash.press("B", 2_000);
		const boundary = stash.press("A", 2_000 + STASH_DOUBLE_PRESS_MS);
		expect(boundary.kind).toBe("stash-clear");
	});

	it("two presses beyond the window behave as a normal swap, not clear", () => {
		const stash = new PromptStash();
		stash.press("A", 1_000);
		stash.press("B", 2_000);
		const late = stash.press("A", 2_000 + STASH_DOUBLE_PRESS_MS + 1);
		expect(late.kind).toBe("swap");
		expect(late.text).toBe("B"); // toggled back to the previous stash
	});

	it("triple press: the third press is a fresh swap (window consumed)", () => {
		const stash = new PromptStash();
		stash.press("A", 1_000);
		stash.press("B", 2_000);
		stash.press("A", 2_050); // double press → stash-clear, window consumed
		const third = stash.press("", 2_100); // editor is empty now
		expect(third.kind).toBe("swap");
		expect(third.text).toBe("B"); // the previously stashed prompt comes back
		expect(third.stashed).toBe("");
	});

	it("peek exposes the stash without changing state", () => {
		const stash = new PromptStash();
		expect(stash.peek()).toBe("");
		stash.press("hello", 1_000);
		expect(stash.peek()).toBe("hello");
	});
});
