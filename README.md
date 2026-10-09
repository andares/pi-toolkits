<!-- markdownlint-disable MD033 -->
<!-- Inline <a name> anchors keep the TOC targets stable and identical across README.md and README.zh-CN.md. -->
# ⚙️ @andares/pi-toolkits

**English** · [中文](README.zh-CN.md)

> Integrated toolkit extension for [pi](https://github.com/earendil-works/pi-coding-agent) — one package, growing new capabilities over time.

[![npm version](https://img.shields.io/npm/v/@andares/pi-toolkits?label=npm&logo=npm)](https://www.npmjs.com/package/@andares/pi-toolkits)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Package Manager](https://img.shields.io/badge/package%20manager-pnpm-orange?logo=pnpm)](https://pnpm.io)
[![pi >= 0.86](https://img.shields.io/badge/pi-%3E%3D0.86.0%20%3C2.0.0-blueviolet)](https://github.com/earendil-works/pi)
[![GitHub](https://img.shields.io/badge/github-andares%2Fpi--toolkits-181717?logo=github)](https://github.com/andares/pi-toolkits)

In a nutshell: six ready-to-use capabilities — **read-only consult mode** `ask`, **model favorites** `favorites`, **prompt stash** `stash`, **third-party code review** `third-review`, **dedicated compaction model** `compact-model` and **session startup automation** `autostart` — with more to come.

**Requirements**: pi `>=0.86.0 <2.0.0` (covering the four most recently released minor lines — 0.86.x / 0.87.x / 0.99.x / 1.0.x; 0.88–0.98 were never released). Every one of the 10 published versions inside that range was compared against the host `dist`: no differences in the extension APIs we use, and the two runtime patch targets used by favorites — `ModelSelectorComponent` / `AgentSession.cycleModel` — are byte-identical. `typecheck` plus the full test suite pass on each of 0.86.0, 0.86.1, 0.87.1, 0.99.2 and 1.0.2, and smoke-loading on real pi 1.0.2 produces no warnings. Note: pi ≥ 0.99 hosts require `@earendil-works/pi-tui` to be declared in `peerDependencies` as `"*"` (provided by the host); this package declares it as required.

---

## 📦 Installation

<a name="install"></a>

```bash
# from npm (recommended)
pi install npm:@andares/pi-toolkits

# local development install
pi install .

# one-off session load, no install
pi -e ./src/index.ts
```

After installing, verify in any pi session:

- `/ask` → a grey `ask` status appears in the footer, `write`/`edit` are hard-disabled
- `/model` (or `ctrl+l`) → a favorites hint line appears at the top of the selector
- press `ctrl+alt+y` in the input box → the current prompt is stashed and the input box is cleared
- after finishing a development task, type `/third-review` → switches to the review model and runs check + fix
- `/compact-model`, pick a cheap fast model → from then on both `/compact` and auto-compaction summarize with it (a grey `compact` status appears in the footer)

---

## 📚 Contents

- [Installation](#install)
- [Features at a glance](#features)
  - [🛡️ ask — read-only consult mode](#ask)
  - [⭐ favorites — model favorites](#favorites)
  - [📥 stash — prompt stash](#stash)
  - [🔎 review — third-party code review](#review)
  - [🗜️ compact — dedicated compaction model](#compact)
  - [🚀 autostart — session startup automation](#autostart)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## ✨ Features at a glance

<a name="features"></a>

| Feature | Entry point | One-line description |
| --- | --- | --- |
| 🛡️ **ask** read-only consult mode | `/ask` | enter read-only Q&A mode: `write`/`edit` hard-disabled, `bash` runs in a read-only sandbox |
| ⭐ **favorites** model favorites | `ctrl+A` / `ctrl+J` inside `/model` | favorite the models you use most (marked in bold bright yellow), `ctrl+p` cycles only among favorites |
| 📥 **stash** prompt stash | `ctrl+alt+y` | a stash slot for one prompt: press to swap, press twice to stash and clear the input box |
| 🔎 **review** third-party code review | `/third-review` | summon the configured review model to check + fix the task just finished, focusing on "is this round's requirement implemented / is anything missing / is anything wrong" |
| 🗜️ **compact** dedicated compaction model | `/compact-model` | give `/compact` and auto-compact a cheap fast model to summarize with, leaving the main model free to focus on the conversation; zero overhead when unconfigured, falls back to pi's default on any failure |
| 🚀 **autostart** session startup automation | `.pi/autostart.toml` | declare slash commands to run automatically at session start, per project (first use case: mounting multi-repo directories with `/add-dir`); never runs in untrusted directories, unregistered commands are skipped instead of being sent to the model |

---

## 🛡️ ask — read-only consult mode

<a name="ask"></a>

Enter with `/ask` (press it again to exit). Meant for the case where you only want to "ask questions and read code", and absolutely never want the model to modify any file.

**While active**:

- **`write` / `edit` hard-disabled** — removed from the active tool set; pi rejects calls to inactive tools outright ("Tool not found"), so file modification becomes mechanically impossible
- **`bash` kept, but sandboxed to read-only** — based on shell tokenization plus write-intent detection (blocks `curl -o/-O`, `wget -O`, `dd of=`, `tee`, redirections, and the like). Heuristic, not a security boundary
- **System prompt appendix** — a mode description is appended so the model behaves along the read-only constraint
- **Grey `ask` footer status** — a permanent reminder that read-only mode is on

**Exit**: press `/ask` again; the tool-set snapshot taken on entry is fully restored.

---

## ⭐ favorites — model favorites

<a name="favorites"></a>

Mark the models you use often so that model switching "sticks" to them. Favorites are **persisted globally, across sessions and projects**.

**Inside the `/model` selector** (open it with `/model` or `ctrl+l`):

- The top hint line shows the keys and the current filter state
- `ctrl+A` — toggle the favorite flag on the currently selected model; favorite models are rendered in **bold bright yellow**
- `ctrl+J` — toggle the "show only favorite models" filter (composable with the built-in search)

**Model cycling**: as long as ≥1 favorite exists, `ctrl+p` / `ctrl+shift+p` cycle **only among favorite models**. When the current model is not a favorite, `ctrl+p` jumps to the first favorite and `ctrl+shift+p` to the last; with exactly one favorite it stays put (`Only one model available`). `ctrl+l` / `/model` always allow picking any model freely, favorites or not. Set `"cycleOnlyFavorites": false` in the state file to restore full cycling.

**State file**: `<agent-dir>/pi-toolkits-favorites.json` (defaults to `~/.pi/agent/`, the same directory as the auto-naming-session config):

```json
{
  "favorites": ["anthropic/claude-sonnet-4"],
  "config": { "cycleOnlyFavorites": true }
}
```

The `/favorites` command lists the current favorites and the cycling mode.

> **Implementation notes**: pi's `app.model.cycleForward` (`ctrl+p`) and `cycleBackward` are **reserved keybindings** that extension shortcuts cannot override; extension shortcuts also only fire while the editor is focused. This feature therefore rebinds nothing; instead it patches two built-in prototypes at runtime (version-guarded, idempotent under `/reload`): `ModelSelectorComponent` (hint line, `ctrl+A`/`ctrl+J`, bright-yellow rendering, favorites-only filter — the keys are consumed only inside the selector, so in the editor `ctrl+j` still inserts a newline) and `AgentSession.cycleModel` (favorites-only cycling). If a pi upgrade makes the patch inapplicable, it warns and degrades gracefully without affecting the other features.
>
> **Why `ctrl+A` and not `ctrl+F`**: since pi 1.0 the default `tuiMode` is `fullscreen` (0.86–0.99 defaulted to `regular`), and on Windows/WSL the host resolves `tui.altScreen.search` to `ctrl+f`; `TuiAltScreen.handleViewportInput()` checks that binding **before** handing input to the focused overlay, so `ctrl+f` opened the transcript search instead of reaching the selector. An interim pick, `ctrl+alt+f`, was clean at the pi layer but turned out to be grabbed by a Windows screenshot tool — a key free in the host table is not necessarily free on the machine. The final pick takes a letter from "favorite" and audits each: `v` is Windows Terminal's paste, `o`/`r`/`t` are host app actions, `i` is byte-identical to Tab (the selector's scope toggle), `e` works but carries no mnemonic; `a` only shadows the search box's jump-to-line-start, reads as *add favorite*, and nothing upstream of the selector claims it. Full audit: `src/features/favorites/constants.ts` and `pnpm check:keybindings`.

---

## 📥 stash — prompt stash

<a name="stash"></a>

One hotkey plus one stash slot, shuffling between "the prompt I am writing" and "the prompt I stashed": park a prompt to one side, free the input box for a new one, and take the old one back when you need it.

| Action | Effect |
| --- | --- |
| Press `ctrl+alt+y` once | current prompt → stash; stashed content → input box (**swap**) |
| Press again after a while | **toggle back and forth** between the two prompts |
| Press twice **within 400ms** | current prompt goes to the stash + **input box is cleared** (the old stash is discarded), so you can start writing the new prompt right away; later press once to take it back |

When the stash is empty, a single press means "stash + clear". The stash is **in-process memory and never written to disk** (prompts may contain sensitive content); `/new` switches sessions without clearing the stash, `/reload` clears it. While a selector (`/model`, `/tree`, …) is open the key does nothing (focus is on the component, not the editor).

**Why `ctrl+alt+y`** (the conclusion of a four-layer compatibility survey):

| Layer | Status | Notes |
| --- | --- | --- |
| pi keybindings | ✅ | no default `ctrl+alt+<letter>` binding; extension shortcuts are dispatched first inside the editor |
| Linux terminals | ✅ | `alt` is encoded as an ESC prefix (`ctrl+alt+y` = `ESC + ctrl+y`), distinguishable without the kitty protocol |
| Windows Terminal | ✅ | no default `ctrl+alt` binding |
| Windows OS | ✅ | only `ctrl+alt+del` is reserved system-wide |

**Rejected candidates**: `ctrl+shift+<letter>` — terminal emulators on both Linux and Windows grab copy/paste/tabs; and on terminals without the kitty protocol it collapses into `ctrl+<letter>` (`ctrl+shift+m` is Enter, which would submit the prompt immediately — dangerous). Plain `ctrl+<letter>` — pi occupies almost all of them, and the only free one, `ctrl+q`, is the XON flow-control character, with historical baggage.

---

## 🔎 review — third-party code review

<a name="review"></a>

After a development task is done, type the `/third-review` command to summon **a different model** as a third party to "check + fix" the code just written: the review model has **full tool permissions**, and confirmed problems are edited in place — this is not a read-only audit. The review turn stays in the current session transcript, and after the review **the session keeps the review model** (it does not switch back automatically).

> **Command-triggered only**: only `/third-review` starts a review. Typing `third-review` as chat text does not trigger it (that is sent to the model as an ordinary message), which avoids accidental launches.

**The review prompt focuses on three checks** (each gets an explicit verdict):

1. **Is this round's requirement implemented** — is the requirement fully and correctly implemented, consistent with the requirement description
2. **Is anything missing** — feature points, edge cases, error handling, compatibility, tests, etc.
3. **Is anything wrong** — logic errors, potential bugs, type/compile errors, security and performance hazards, etc.

**Strict scope constraint** — the review is limited to **the changes made in the current round**, to avoid scope creep; only problems confirmed inside this round's changes are fixed directly, while pre-existing or unrelated issues outside that range are only recorded as notes and left untouched.

**Choosing the review model** (every `/third-review` opens a picker):

- `/third-review` → opens the **same selector as `/model`** (height-limited scrolling + fuzzy search): **the currently configured model is selected by default** (✓ marker), so pressing **Enter** starts the review with it
- **Pick another model** → written back to the config immediately (**both on disk and in memory**), and **that model becomes the default next time**
- **Cancel** (Esc) → no review is run, the config is unchanged
- The config is persisted in `<agent-dir>/pi-toolkits-review.json` (defaults to `~/.pi/agent/`):

```json
{ "model": "anthropic/claude-sonnet-4" }
```

- `/review-model` — a separate config entry point: opens the same list (without changing the session model, only updating the default config)
- **Unconfigured / the configured model is no longer available** (e.g. it was deleted from pi's models.json) → a notice is shown and the list opens as usual (with no default entry in that case)
- Triggered while a task is still in progress (the agent is not idle) → you are told to wait and nothing runs; only one review may be active at a time
- A grey `review` status in the footer means a review model is configured

---

## 🗜️ compact — dedicated compaction model

<a name="compact"></a>

pi's `/compact` and auto-compact summarize the context **with the current session model** by default — the main model is usually expensive and slow, while compaction summarization is a textbook "a cheap fast model does this well" job. This feature configures a dedicated model to take over summarization for **all three compaction triggers**:

| Trigger | After takeover |
| --- | --- |
| Manual `/compact [instructions]` | summarized by the compaction model, custom focus is injected as usual |
| auto-compact threshold reached | summarized by the compaction model |
| context overflow recovery | summarized by the compaction model, retry behavior unchanged |

**Parts that are identical to pi's built-in behavior after takeover** (the built-in implementation is mirrored verbatim — byte-identical since 0.87.1, verified up to 1.0.2 — and only the executing model changes):

- **Summary format** — the structured Goal / Progress / Key Decisions checkpoint; when a summary already exists, the iterative-update prompt is used so information carries over instead of being lost
- **Split behavior** — the `keepRecentTokens` retention policy, and `firstKeptEntryId` / `tokensBefore` passed back unchanged
- **Output budget** — the same formula as the built-in (history segment 0.8×, split-prefix segment 0.5× of `reserveTokens`, then capped by the model's max output)
- **File-list tail** — `<read-files>` / `<modified-files>` tags are appended to the summary as usual, with details maintained in the same shape
- **Usage accounting** — the compaction model's tokens/cost are counted in the session statistics
- **Cancellable** — `Esc` during compaction cancels cleanly (the signal is passed through to the underlying call)

**Configuration** (`<agent-dir>/pi-toolkits-compact.json`, defaults to `~/.pi/agent/`):

```json
{ "model": "google/gemini-2.5-flash" }
```

- `/compact-model` — view/replace: the **same selector as `/model`** (height-limited scrolling + fuzzy search), with **the currently configured model selected by default**; Enter confirms, picking another model writes it, cancelling leaves it unchanged (to clear the config: edit `pi-toolkits-compact.json` and set `model` to `null`)
- Unconfigured = feature disabled, everything goes through pi's default at zero overhead; a grey `compact` status in the footer means it is configured

**Lossless fallback** (this feature can never "break" compaction):

| Situation | Behavior |
| --- | --- |
| Not configured | falls straight back to pi's default compaction |
| Configured model unavailable (e.g. deleted from models.json) | warning + fallback |
| Summarization failed / empty summary / token limit hit | notice + fallback to pi's default compaction |
| User cancelled (`Esc`) | clean cancel, no error spam |

> **Implementation notes**: the takeover point is the official `session_before_compact` extension event (all three triggers pass through it); returning a compaction result takes over completely, returning `undefined` falls back to the built-in. The auto-compact path never shows any dialog (the handler only calls `notify`). `/tree` branch summarization (`session_before_tree`) is a different event and is not taken over in this iteration — it is left for later.

---

## 🚀 autostart — session startup automation

<a name="autostart"></a>

A first step for multi-repo projects: declare inside the project which slash commands should run automatically "when a new session starts" — the first use case being `/add-dir` mounting sibling repositories, so a new session does not have to replay them by hand.

**Configuration** (`<project root>/.pi/autostart.toml`, committed with the project; `.pi/` is pi's project-level config convention, following `.pi/mcp.json`):

```toml
version = 1

[command]
run = [
  "/add-dir ../shop-frontend",
  "/add-dir ../shop-api",
]
```

No file = feature disabled, zero overhead, silently skipped.

**When it runs**:

| session_start reason | Replayed | Why |
| --- | --- | --- |
| `startup` / `new` | ✅ | a new session, replay as declared |
| `fork` | ✅ | the branch point may predate the config's appearance |
| `resume` | ❌ | the restored branch already carries the mount state from its time, replaying would conflict |
| `reload` | ❌ | extensions are rebuilt, replaying would duplicate side effects |

**Safety gates** (in order):

1. **project trust** — no command runs automatically in an untrusted directory (a warning is shown); a config parse failure likewise prevents execution (an error is shown)
2. **Command pre-validation** — only commands **registered by extensions** are executed; an unregistered command name is **skipped with a warning** and never sent to the model (for an unhandled `/x`, `sendUserMessage` treats the text as an ordinary message and sends it to the LLM — this is exactly why pre-validation is mandatory)

**Key constraint: extension commands only**. Commands registered via `registerCommand` such as `/add-dir` (pi-add-dir) and `/cd` (pi-cd) work; built-in commands (`/compact`, `/reload`, `/resume`, …) are dispatched in the TUI layer and cannot be triggered from the extension layer; skill commands (`/skill:name`) are an expansion mechanism rather than an execution mechanism. The target extension you depend on (e.g. pi-add-dir) must be installed first.

> **Implementation notes**: execution uses `sendUserMessage(cmd, { expandPromptTemplates: true })` — that option routes `/cmd args` into command dispatch instead of the model prompt path (the wrapper defaults to `false`; verified against pi 0.86–1.0.4 sources, see the host-compatibility discipline in AGENTS.md). Pre-validation uses `pi.getCommands()` (accepting only `source: "extension"`). Depends on `smol-toml` (zero-dependency, ~10KB, TOML 1.0).

---

## 🛠️ Development

<a name="development"></a>

**pnpm is the only supported toolchain** — never use `npm install` / `npm publish` in this repo.

```bash
pnpm install      # install deps
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (all feature unit tests)
```

### Project structure

```text
src/
├── index.ts              # entry point: aggregates feature modules
├── lib/                  # shared infrastructure (tool-set snapshot/restore,
│                         # model-key resolution shared by review & compact)
└── features/             # feature modules — one directory per feature
    ├── ask/              # ask mode: command + state machine, bash sandbox,
    │                     #           system prompt banner, tests
    ├── autostart/        # session startup automation: autostart.toml parsing,
    │                     #           command pre-validation + replay, tests
    ├── compact/          # dedicated compaction model: session_before_compact
    │                     #           takeover + /compact-model, store, prompts,
    │                     #           tests
    ├── favorites/        # model favorites: selector + cycle patches,
    │                     #           persisted store, tests
    ├── review/           # third-party review: input/command triggers,
    │                     #           review-model config store, prompt, tests
    └── stash/            # prompt stash: hotkey state machine + tests
```

**Adding a feature**: create `src/features/<name>/` exporting `registerXxx(pi)` and call it from `src/index.ts`. Existing modules stay untouched. Each feature ships its own `*.test.ts` (vitest) — keep them deterministic (inject clocks/state, no real agent-dir writes).

**Publishing** (pnpm-only, one command):

```bash
pnpm release patch   # 0.1.2 → 0.1.3
pnpm release minor   # 0.1.2 → 0.2.0   (patch zeroed)
pnpm release major   # 0.1.2 → 1.0.0   (minor + patch zeroed)
pnpm release patch --dry-run   # preview without changing anything
```

`release` requires exactly one of `major | minor | patch`; incrementing a higher level zeroes the lower ones. The chain is: **the working tree must be clean (any uncommitted change aborts before anything happens, guaranteeing tag content == published content)** → `typecheck + test` gate → version bump → git commit + `vX.Y.Z` tag (self-check that tag == HEAD and the tree is clean) → `pnpm publish` (with `prepublishOnly` as a second gate) → push only the current branch + the current tag and verify the remote hashes match (if the remote tag differs, GitHub Release creation is skipped).

---

## 🤝 Contributing

<a name="contributing"></a>

PRs and issues welcome. A few conventions:

- **pnpm only** — never `npm install` / `npm publish`; use `pnpm add` / `pnpm publish`
- **Feature-module pattern** — one directory per feature (`src/features/<name>/`), export `registerXxx(pi)`, register in `src/index.ts`; shared infra goes in `src/lib/`
- **Tests** — every feature ships vitest cases; keep them deterministic (injectable clocks/state), no writes to the real agent dir
- **Built-in patches** (favorites) must stay **version-guarded and idempotent** — verify the target prototype members exist before patching, guard against double-apply, degrade with a `console.warn` instead of breaking the extension
- **Built-in prompt sync** (compact) — the summarization prompts in `src/features/compact/prompt.ts` are copied verbatim from pi's built-in compaction; when upgrading the pi dependency, diff `dist/core/compaction/compaction.js` (and `utils.js`) and update the strings + assembly helpers to match, keeping takeover output byte-compatible with stock
- **Keybindings** — before picking a new shortcut, check pi defaults + reserved keys, terminal control chars, and OS/terminal-emulator grabs; prefer `ctrl+alt+<letter>` for cross-platform safety. Do not stop at "it works on my machine in the main screen": in `fullscreen` mode (pi's default since 1.0) the alt-screen layer consumes `tui.altScreen.*` **before** dialogs see the key, and on Windows/WSL several of those bindings differ from the Linux defaults. Run `pnpm check:keybindings [candidate...]` (and `pnpm check:keybindings --all` after a pi upgrade) — it probes the installed host's resolved keybinding table with the host's own `matchesKey`. A key free in the host table can still be taken at the machine layer: Windows Terminal binds `ctrl+v` (paste) and `ctrl+shift+f` (find), and third-party Windows tools commonly grab `ctrl+alt+<letter>` (a screenshot tool once took `ctrl+alt+f`) — so try the key for real on the target machine before shipping it.
- **Quality gate** — `pnpm typecheck && pnpm test` must pass before submitting

---

## 📄 License

<a name="license"></a>

MIT © 2026 Andares Cui. See [LICENSE](LICENSE).
