# @andares/pi-toolkits

Integrated toolkit extension for [pi](https://github.com/earendil-works/pi-coding-agent) — a single npm package that grows new capabilities over time. Currently provides **ask mode**.

## Features

### ask — read-only Q&A mode

Toggle with `/ask` (press again to exit). While active:

- **`write`/`edit` hard-disabled** — removed from the active tool set; pi's runtime rejects calls to non-active tools, so file modification is genuinely impossible
- **`bash` kept but sandboxed to read-only commands** — shell-quote tokenization with per-segment validation plus write-intent detection (`curl -o/-O`, `wget -O`, `dd of=`, `tee`, redirects); heuristic, not a security boundary
- **System prompt banner** appended describing the current mode and its restrictions
- **Gray `ask` footer status** while active

Exiting restores the exact tool set from before ask mode was entered.

### favorites — model favorites

Mark your frequently-used models and make model cycling stick to them.

**In the `/model` selector** (opened via `/model` or `ctrl+l`):

- A hint row at the top shows the keys and the current filter state
- `ctrl+f` toggles favorite on the currently selected model — favorited
  models render in **bold bright yellow**
- `ctrl+j` toggles the **only-favorites** filter (keeps working together with
  the built-in search)

**Model cycling:** once at least one favorite exists, `ctrl+p` /
`ctrl+shift+p` cycle **only among favorited models** instead of all models.
If the current model is not a favorite, `ctrl+p` jumps to the first favorite
and `ctrl+shift+p` to the last. `ctrl+l` / `/model` stays available to pick
any model. Set `"cycleOnlyFavorites": false` in the state file to restore
full cycling.

Favorites persist globally in `<agent-dir>/pi-toolkits-favorites.json`
(`~/.pi/agent` by default, alongside the auto-naming-session config):

```json
{
  "favorites": ["anthropic/claude-sonnet-4"],
  "config": { "cycleOnlyFavorites": true }
}
```

`/favorites` lists the current favorites and cycling mode.

> **How it works / keybindings:** pi reserves `app.model.cycleForward`
> (`ctrl+p`) and `cycleBackward` for built-ins, and extension shortcuts only
> fire while the editor is focused — so the feature doesn't rebind any keys.
> Instead it patches two built-in prototypes at runtime (version-guarded and
> idempotent across `/reload`): `ModelSelectorComponent` (hint row, `ctrl+f`/
> `ctrl+j`, styling, only-favorites filter — keys are consumed only inside
> the selector, so `ctrl+f` cursor-right and `ctrl+j` newline keep working in
> the editor) and `AgentSession.cycleModel` (favorites-only cycling). If pi
> upgrades its internals and a patch can't apply, it logs a warning and
> degrades gracefully.

### stash — prompt stash

One hotkey juggles the editor prompt and a single stash slot — handy when
you want to set a prompt aside without losing it.

- **`ctrl+alt+y`** — swap the current editor text with the stashed prompt
  (press again to toggle back between the two)
- **`ctrl+alt+y` twice quickly** — stash the current prompt **and clear the
  editor**, ready for a new prompt; press once later to bring the stashed
  prompt back

With an empty stash, a single press stashes the current prompt and clears
the editor. The stash is in-memory (not persisted — prompts may be
sensitive), survives `/new` within the same process, and resets on `/reload`.
The key is inert while a selector (`/model`, `/tree`, …) is open.

**Why `ctrl+alt+y`** (researched across four compatibility levels):

| Level | Status | Notes |
| --- | --- | --- |
| pi bindings | ✅ | no default `ctrl+alt+<letter>` binding; extension shortcuts dispatch first in the editor |
| Linux terminal | ✅ | `alt` = ESC-prefix, so `ctrl+alt+y` = `ESC + ctrl+y`, distinguishable without kitty protocol |
| Windows Terminal | ✅ | no default `ctrl+alt` binding |
| Windows OS | ✅ | only `ctrl+alt+del` is system-reserved |

Rejected: `ctrl+shift+<letter>` (terminal emulators grab copy/paste/tab on
both Linux and Windows, and without kitty protocol it collapses to
`ctrl+<letter>` — `ctrl+shift+m` would be Enter and submit the prompt);
plain `ctrl+<letter>` (fully occupied by pi defaults or terminal control
chars — only `ctrl+q` is free but it is the XON flow-control character).

## Install

```bash
# local development
pi install .
# or one-off session
pi -e ./src/index.ts
```

## Development

```bash
pnpm install      # install deps (pnpm is the only supported toolchain)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (bash sandbox boundary cases)
```

### Publishing

One-command npm release with automatic version bump (pnpm-only — never `npm publish`):

```bash
pnpm release patch   # 0.1.2 → 0.1.3
pnpm release minor   # 0.1.2 → 0.2.0   (patch zeroed)
pnpm release major   # 0.1.2 → 1.0.0   (minor + patch zeroed)
```

Requires exactly one of `major | minor | patch`; a higher-level bump zeroes
all lower levels. The script runs `pnpm typecheck && pnpm test`, bumps
`package.json`, creates the git commit + `vX.Y.Z` tag, then `pnpm publish`
(`prepublishOnly` re-gates the publish with the same checks). `--dry-run`
previews the plan without changing anything.

## Project structure

```text
src/
├── index.ts              # entry point: aggregates feature modules
├── lib/                  # shared infrastructure (tool-set snapshot/restore)
└── features/             # feature modules — one directory per feature
    ├── ask/              # ask mode: command + state machine, bash sandbox,
    │                     #           system prompt banner, tests
    ├── favorites/        # model favorites: selector patches, cycle patch,
    │                     #           persisted store, tests
    └── stash/            # prompt stash: hotkey state machine + tests
```

Adding a new feature = create `src/features/<name>/` exporting `registerXxx(pi)`
and call it from `src/index.ts`. Existing modules stay untouched.

## License

MIT
