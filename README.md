# pi-toolkits

My collection of [pi](https://github.com/earendil-works/pi-coding-agent) toolkits and extensions, published as npm packages under the `@andares/*` scope.

## Packages

| Package | Status | Description |
| --- | --- | --- |
| [`@andares/pi-ask-mode`](packages/pi-ask-mode/) | 🚧 WIP | Lightweight ask mode (read-only Q&A) — `/ask` toggle, write/edit hard-removal, read-only bash sandbox, system prompt banner |

## Project structure

```text
packages/
└── pi-ask-mode/        # ask mode extension (first toolkit)
    ├── src/index.ts    # extension entry (loaded by pi at runtime)
    ├── package.json    # pi extension metadata ("pi.extensions")
    └── README.md
```

## Development

Workspace management uses pnpm.

```bash
pnpm install          # install workspace deps (incl. per-package dev deps)
pnpm typecheck        # type-check all packages
```

To try a package inside pi without publishing:

```bash
pi install ./packages/pi-ask-mode
```

Or for a one-off session:

```bash
pi -e ./packages/pi-ask-mode/src/index.ts
```

## License

MIT
