# Kinetic Haus — project notes for Claude

## What this is
A mobile-first workout tracker for one user (the repo owner). Monochrome
black/white brand, optimized for a Google Pixel 8, must work one-handed
mid-workout.

- `index.html` — the ENTIRE frontend. Single self-contained file: Tailwind
  (CDN) + vanilla JS + Chart.js (CDN). No build step, no framework. Served
  by GitHub Pages from the root of `main`:
  https://mlombardi29.github.io/kinetic-haus/
- `Code.gs` — the backend: a Google Apps Script Web App acting as a pure
  data API over a Google Sheet ("Workout App") with tabs Logs / Days /
  Settings. One Logs row per set.
- The frontend auto-detects its host (`state.gas`): served from Apps Script
  it uses `google.script.run`; served anywhere else it uses `fetch()` to the
  `/exec` URL stored in Settings. GET `?action=getData`; POST body as
  `text/plain;charset=utf-8` (avoids a CORS preflight Apps Script can't answer).

## The owner is not a developer
Explain everything in plain, non-technical language. Do every possible step
directly from Claude Code; only hand over steps that truly require their
hands (Apps Script paste/redeploy, GitHub web settings), and make those
click-by-click.

## Deployment workflow
- Work on the designated `claude/...` session branch, then merge to `main`
  and push both (owner has approved pushing to `main`; `main` is the live
  Pages branch). Small, descriptive commits.
- Pushing `index.html` to `main` = live in ~1 minute (Pages auto-deploys).
  Tell the owner to refresh the app.
- Changing `Code.gs` is NOT live until the owner: opens the Sheet →
  Extensions → Apps Script → select-all, paste the new file, Save →
  Deploy → Manage deployments → pencil → Version: "New version" → Deploy.
  Hand them the file with SendUserFile and give the click-by-click every time.
- After any significant push, remind the owner to refresh their desktop
  backup: open GitHub Desktop → pick the repo (top-left) → click
  "Fetch origin" → if it turns into "Pull origin", click that too.
  (Clone is one-time only; they sometimes re-clone by mistake — gently
  correct that.)

## Pending TODO (do this next time Code.gs changes for any reason)
Make `doGet` without an `action` parameter return a small "this app has
moved" page linking to https://mlombardi29.github.io/kinetic-haus/ instead
of serving the old "Index" HTML file; then tell the owner they can delete
the "Index" file from the Apps Script project. Until then the stale Index
copy is harmless but must never be used (it predates bug fixes).

## History worth knowing
- July 2026: an old deployed backend without LockService caused duplicate
  set rows and stuck `in_progress` workouts. Cleaned by `runCleanupJuly2026()`
  in Code.gs (already run; kept for reference — it is idempotent).
- The owner's desktop backup lives in a "Claude" folder; one subfolder per
  GitHub repository, synced manually via GitHub Desktop.

## Hard-won gotchas — never reintroduce
1. Google Sheets returns date cells as Date OBJECTS. Always normalize with
   `ymd()` on read; never `.localeCompare` a raw date.
2. All Sheet reads/writes go through `withLock` (LockService); client
   `flushSaves()` is one-at-a-time (`_flushing`) and drains the queue.
3. Auto-save guards must check `(state.apiUrl || state.gas)`, never apiUrl alone.
4. The Sheet is the source of truth; localStorage is only a cache.
   `applyCloud()` must never wipe local data on an empty cloud — it re-pushes.
5. Startup: `waitForGAS()` + `apiGetRetry()` + Reconnect screen. A slow read
   must never render a false-empty home.
6. Names with apostrophes: never inline into onclick; data-* attributes +
   event delegation.
7. Monochrome brand: yellow (`--edge`) is OUTLINE/STROKE ONLY (focus ring,
   in-progress border, PR markers, chart lines, badge ring) — never a fill
   or text color. Primary buttons are white with black text. Default unit lbs.
8. Keep `index.html` a single self-contained file (CDNs only). Logo is
   inline SVG with `KH_LOGO_OVERRIDE` hook.

## How to test before committing
- `index.html`: extract the `<script>` blocks and `new Function(...)` them to
  confirm they parse; exercise pure functions (exerciseType, allExerciseStats,
  computeBadges, applyCloud, suggestExercises) in Node with light stubs.
- `Code.gs`: eval in Node with stubbed SpreadsheetApp/ContentService/
  LockService/Utilities/Session; feed fake rows INCLUDING a Date object in
  the date column; confirm getData round-trips and never throws.
