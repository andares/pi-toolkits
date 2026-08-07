# pi-toolkits Project Guidelines

## Package Management

- **This project uses `pnpm` as the sole package manager.**
- Use pnpm equivalents for everything:
  - `pnpm install` / `pnpm add -D <pkg>` / `pnpm remove`
  - `pnpm publish` (never `npm publish`)
  - `pnpm dlx <pkg>` instead of `npx`
  - `pnpm typecheck` / `pnpm test` for scripts
- Do **not** run `npm install`, `npm publish`, `npx`, or `npm whoami` in this
  project — always use the pnpm form.
