# @andares/pi-ask-mode

Lightweight **ask mode** for [pi](https://github.com/earendil-works/pi-coding-agent) — a read-only Q&A mode.

> 🚧 **WIP** — skeleton only. Design was discussed (see `src/index.ts` header); implementation pending.

## Planned features

- `/ask` toggle (optionally `--ask` flag, `/ask <question>` one-shot)
- **Hard guarantee**: `write`/`edit` removed from the active tool set — pi's runtime rejects calls to non-active tools, so file modification is genuinely impossible in ask mode
- `bash` stays available but is gated by a read-only command sandbox (shell-quote based parsing; deny-by-default). Heuristic, not a security boundary
- Mode banner appended to the system prompt while active, describing the current mode and its restrictions
- Gray footer status while ask mode is active

## Install (local dev)

```bash
pi install ./packages/pi-ask-mode
# or one-off:
pi -e ./packages/pi-ask-mode/src/index.ts
```

## License

MIT
