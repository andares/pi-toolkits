# 2026-11-26T11:07+08:00 — ask-talk: open every run, session title, shared port pool, outline/composer/back-to-top fixes

Six measured issues, all reproduced before changing code.

**1. Window did not pop like `/ask-spec`.** Only the first run called the opener; the same-reply path notified and the new-reply path broadcast to an already-open tab, so a closed tab stayed closed. `src/features/talk/index.ts` now calls `open(server.url)` on all three paths (fresh, same reply, refresh). Tests assert `opened` twice.

**2. Title.** `TalkSession.title` comes from `ctx.sessionManager.getSessionName()` (fallback: first user message, clamped to 80 chars); the page sets both `document.title` and the h1 from it, with `talkUntitled` as the last resort. `getSessionName` is already used by keep across the supported range.

**3. Ports.** `portWalk()` in `src/lib/web-review.ts` walks 3401→3499 (same hundred block, default 100 attempts) and throws `cannot bind a review server on ports 3401–3499` when exhausted. Talk dropped its 3501 pool and uses 3401 like spec/uat.

**4. Outline strip.** The 14px `mask-image` fade erased the first and last bar (and an active red bar at either end) — measured: first bar at y=0..2 under a 0→14px transparent gradient. Removed the mask, bounded the strip (`max-height: min(52vh, 300px)`, `overflow-y: auto`, hidden scrollbar, `flex: none` so bars scroll instead of squashing), and added an effect that keeps the active bar inside the strip by adjusting `scrollTop` only.

**5. Back to top.** Was using the outline's right offset (96px at 1440), 4–8px off the footer edge. Now `right: max(24px, (100vw - 1232px)/2)`, i.e. the footer's right edge; measured 0 delta at 1280 and 1920.

**6. Composer.** Blur forced 24px while one line needs ~35px (line-height 20.9 + padding 12 + border 2), and `scrollHeight` (content+padding) was copied into a border-box height, dropping the borders. `composerMetrics()` now measures line-height/padding/border and blur collapses to exactly one line; focused height = content + border, capped at 40vh/220px with `overflow-y: auto` past that.

Evidence: `pnpm typecheck`, `pnpm ui:typecheck` green; `pnpm test` 61 files / 1064 tests green (new `src/lib/web-review.test.ts`); `pnpm ui:build` regenerated assets; pi 1.6.0 smoke `pi -p --no-extensions -e ./src/index.ts --tools ''` → `OK`. Playwright against the built bundle + mock state: title/h1 from state, first and last bars visible, 330px window scrolls the strip (60px forced → `scrollTop=111`, active bar in view), back-to-top delta 0, composer 34.9px blurred with clientHeight 33 ≥ one line, 77px for three focused lines. Full `pnpm check:compat` not rerun this round (no host API change).
