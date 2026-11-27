# 2026-11-27T23:02+08:00 — Default a spec note to "suggest" and move it to the left-most pill

The ask-spec note editor opened on `must change`, so writing the everyday note meant clicking the left-most pill (which was also the default) after every open, and the previous choice carried over into the next note.

- Verdict order in `NoteEditor` is now `suggest` / `must change` / `question` (`VERDICT_ORDER` in `ui/src/SpecView.tsx`), and `DEFAULT_VERDICT` derives from its first entry so order and default cannot drift apart.
- Every editor open resets the shared verdict signal to `DEFAULT_VERDICT`: the block `+ Add note`, the Global notes editor, and re-opening after a save that used another verdict. Before, the last chosen verdict leaked into the next note.
- Rebuilt `src/features/review-page/assets/` (`pnpm ui:build`), and synced `design/ask-spec.ptr`: the three pills are reordered and the brand-filled "Suggest" pill replaces "Must change" as the highlighted default (paintress batch, validate 0 errors/0 warnings, screenshot read back).
- Backend untouched: `src/features/spec/server.ts` normalizes whatever verdict the page sends, so no server-side default existed to change.

Evidence:
- `pnpm ui:typecheck` green, `pnpm typecheck` green, `pnpm test` 61 files / 1035 tests green.
- Browser check against the built bundle with a mock `/api/state` (Playwright): order is suggest / must change / question, `suggest` is the `active` pill on first open; saving a `must change` note and re-opening shows `suggest` active again; the Global notes editor also opens on `suggest`.
