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

## Project structure

```text
src/
├── index.ts              # entry point: aggregates feature modules
├── lib/                  # shared infrastructure (tool-set snapshot/restore)
└── features/             # feature modules — one directory per feature
    └── ask/              # ask mode: command + state machine, bash sandbox,
                          #           system prompt banner, tests
```

Adding a new feature = create `src/features/<name>/` exporting `registerXxx(pi)`
and call it from `src/index.ts`. Existing modules stay untouched.

## License

MIT
