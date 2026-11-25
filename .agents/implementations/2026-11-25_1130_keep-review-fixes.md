# 2026-11-25T11:30+08:00 — keep review: rebuild, persistence and resume-note error fixes

Third-party review of `specs/keep-sessions.md` and this round's keep changes, with fixes limited to confirmed defects in that scope.

Findings fixed:

1. `rebuildKeepLedger` derived its known-session set only from currently active entries. Because `/keep-drop` leaves the session-file breadcrumb in place, rebuild re-added explicitly dropped sessions. The rebuild now treats any ledger event for a session as proof that its keep history exists, so drops survive. Regression test: `never resurrects a session that was explicitly dropped`.
2. `withSession` let a failed `sendMessage` escape into the switch error path, which appended `unload` even though the new session was already open, then tried to notify through the stale old context. Resume-note persistence now has its own error boundary using `newCtx`; the loaded owner remains correct and the warning names the write failure. Regression test included.
3. The approved spec required canonical session paths, but the ledger used `getSessionFile()` verbatim. Current and rebuilt session paths now pass through `realpathSync`, with an absolute-path fallback if the file vanished. Symlink regression test included.
4. `/keep-quit` checked conversation content but not actual on-disk persistence. It now refuses when the session file has disappeared, before writing a breadcrumb or ledger event. The same check guards the pre-switch keep dialog. Regression test included.
5. Notes are rendered in the terminal; control characters are now stripped in addition to whitespace collapsing, using the existing note-length constant. Test included.

Verification: `pnpm typecheck` green; `pnpm test` 54 files / 996 tests green (five new review regressions); `pnpm check:keybindings ctrl+r` unchanged, no upstream conflict. The previous full compatibility matrix covered pi 0.99.0–1.6.0; these fixes add no host API usage beyond the already reviewed surface.

Out-of-scope note: host sessions can still be opened simultaneously outside `/keep-load`; this is an explicitly accepted spec limitation, not a new defect.
