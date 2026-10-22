# Learnings

Running log of things discovered during planning/build that aren't obvious from re-reading the code or the CSV — append here whenever a new one surfaces. Newest at the top. Each entry: what we learned, why it mattered, and what it changed.

---

## 2026-07-27 — Session pairing must update BOTH rows' pairing_status, not just one
Real testing (submitting a 3rd, genuinely new photo the same day) surfaced a bug the "build it and see" pass on paper missed: `submit/+server.ts` flipped `pairing_status` to `'paired'` on the morning row when an evening session paired with it, but never flipped it on the evening row itself — so the evening row's `pairing_status` silently stayed at its default `'open'` forever. The "is today already complete" check queries `session_type='evening' AND pairing_status='paired'`, which never matched, so a third submission fell through to "start a new morning" and crashed on the unique constraint instead of cleanly returning 409. Fixed by updating both rows. Lesson: when a fix touches a *pair* of rows, write the test for the *third* event afterward (not just the pair itself) — that's where an asymmetric update shows up.

## 2026-07-27 — A local dev machine can have a native service silently shadowing a Docker port
Docker Compose mapped `postgres` to host port 5432, but this Windows machine already had a native Postgres service bound to 5432 — host-side connections (seed script, test scripts) were silently hitting the wrong Postgres instance and failing auth, while everything looked fine from inside `docker compose ps`/`docker compose logs`. Diagnosed via `netstat -ano` + `Get-Process` on the port, not from any Docker-side signal. Fixed by remapping to host port 5433 (container-internal 5432 unaffected, so app/worker's internal `postgres:5432` networking needed no change). Lesson: if a host-side connection to a freshly-started container mysteriously fails auth/connection while the container itself looks healthy, check for a competing local process on the same host port before assuming it's a credentials or app bug.

## 2026-07-27 — SvelteKit's built-in CSRF check rejects non-JSON POSTs without a matching Origin header
Server-to-server test scripts (Node `fetch`, not a browser) don't automatically send an `Origin` header the way a browser tab does — SvelteKit's CSRF protection requires one for any POST with a non-JSON content type (our multipart photo upload), and `adapter-node` also needs the `ORIGIN` env var set explicitly to correctly compute the expected origin (it can't always infer it reliably from the Host header alone). Real browser submissions from the pump capture page are unaffected (browsers always send Origin). Fixed by adding `origin: APP_URL` to the test script's fetch headers and setting `ORIGIN=http://localhost:3000` on the `app` container in `docker-compose.yml`. Lesson: any Node-based test harness hitting a SvelteKit app's non-JSON POST endpoints needs to set Origin explicitly — don't assume "it works in the browser" implies "it works from curl/fetch in Node."

---

## 2026-07-24 — Symmetric fraud-check scope, not vendor-scoped
An early design scoped fraud-checking to "same vendor's own pumps" for ordinary vendors and "same Area, any vendor" only for Area-split accounts (RDC). This is asymmetric and order-dependent: whether a real fraud case gets caught depends on which of the two pumps involved happens to submit later in the day. Fixed by making **every** vendor account's fraud-check scope Area-wide, uniformly. Lesson: any scoping rule for a symmetric relationship (A-vs-B fraud match) must itself be symmetric, or it silently has holes that only show up in specific orderings.

## 2026-07-24 — Open-ended session pairing can strand a pump forever
Fixing the midnight-rollover bug (evening session pairing to its morning session instead of "today's" date) introduced a worse bug: if a pump ever misses submitting an evening photo, "most recent unpaired morning" has no time bound, so *every future submission* at that pump gets mispaired as the evening completion of that one ancient morning — permanently, until an admin manually intervenes. Fixed with an `EVENING_PAIRING_WINDOW_HOURS` (default 24h) expiry: past that window, the open morning auto-closes as morning-only and the next submission starts fresh. Lesson: any "find the most recent open X" pairing pattern needs an explicit expiry/timeout, or a single missed step in the pair breaks everything downstream indefinitely.

## 2026-07-24 — Real CSV data surfaces bugs sample data hides
The original 12-row illustrative sample in Prompt A never exposed several real problems: a pump code containing a space (`BOOM 3`, breaks naive login-email generation), pump-code naming patterns that don't reliably indicate vendor (`BGLPRVN2` looks like an R V N Enterprises pump but is actually KS Enterprises), and one vendor (`RDC Concrete (India) Ltd`) operating nationally across nearly every Area rather than being naturally scoped like typical vendors. Lesson: always sanity-check a spec against the *actual* onboarding data, not just a hand-picked illustrative sample — toy examples underrepresent real-world messiness by construction.

## 2026-07-24 — Verified facts about the real 204-row CSV (don't re-derive, just re-verify if the source file changes)
- No duplicate `pump_code` values across all 204 rows.
- No live vendor-name near-duplicates today (82 raw strings normalize to 82 distinct keys) — the importer's normalization step is a *forward-looking* safeguard against future re-imports, not a fix for existing dirty data.
- Sr.No has gaps (162, 183 missing) — rows were likely deleted upstream without renumbering; Sr.No is ignored by the importer anyway, so this doesn't affect anything, just noted in case it signals a missing pump.
- Kerala and Hyderabad are the two largest Areas (20+ pumps each) — relevant if Area-wide serialization (advisory lock) ever needs load-testing.

## 2026-10-08 — Serving under a sub-path (BASE_PATH, e.g. ops.rdcc.ai/pump-attendance)
- `BASE_PATH` (read in `vite.config.ts` into `kit.paths.base`) is baked in at build time. The Dockerfile takes it as a build arg, and `app`, `worker` and `migrate` in compose all pass it, because app and worker share one image tag and an un-argued build would overwrite it.
- `event.url.pathname` in `hooks.server.ts` includes the prefix, so the role guards strip it first. Without that, every `startsWith('/admin')` guard silently stops matching.
- Build every app URL with `resolve()` / `asset()` from `$app/paths` (the eslint rule `svelte/no-navigation-without-resolve` enforces it for hrefs). Relative `?query` links are fine as they are.
- Cookies use `COOKIE_PATH` from `src/lib/server/cookies.ts` so other apps on the same domain never see them. It's kept out of `auth.ts` because `scripts/seed.ts` imports that outside SvelteKit.
- nginx must pass the prefix through: `location ^~ /pump-attendance { proxy_pass http://127.0.0.1:6100; }` with no trailing slash on proxy_pass, unlike OpsMitra whose backend expects it stripped.
- Git Bash on Windows rewrites `BASE_PATH=/x` env vars into `C:/Program Files/Git/x`. Prefix local commands with `MSYS2_ENV_CONV_EXCL=BASE_PATH`. vite.config.ts rejects the mangled value instead of building with it.

## 2026-10-08 — Pairing window, pump retry and the regression gate

- (Superseded the same day by the single-button shift flow below: the window is back to 24h because the missed end is now closed by End session, admin fix or timeout instead of by the next photo.) A 24h pairing window misfiles attendance: morning 08:00, missed evening, next photo at 07:30 the next day is 23.5h later and becomes yesterday's evening. The default is now 16h, editable at /admin/settings (stored in `app_settings`, which wins over env).
- Pump Retry used to delete completed sessions together with their `fraud_flags`, so a pump caught by the cross-pump check could erase the evidence. It is now limited to `failed`/`review` sessions without fraud evidence. Admin delete/reset is the only full delete and is written to `admin_audit_log`.
- The cross-pump check compared only against `active` people in `completed` sessions, so a new worker (still `pending_review`) at two pumps on day one was never flagged, and detection depended on which pump approved first. It now includes `pending_review` people and `review` sessions.
- New accounts default to `must_change_password = TRUE` (migration 016). Test fixtures must insert FALSE explicitly or every request returns "Password change required".
- A plain POST to a SvelteKit form action renders the page with HTTP 200 even when the action returns `fail()`. Tests call actions with `accept: application/json` and `x-sveltekit-action: true` and check the returned `type`.
- The duplicate-photo check must run before the "today's morning is still processing" check, or a resubmitted photo gets the wrong message.

## 2026-10-08 — Match threshold and "not fraud" recovery

- The golden small-group evaluation (2026-08-11) showed 0.68 is far too strict for this model: 60.6% attendance accuracy, 10% match recall, 0 of 2 fraud groups caught. 0.26–0.28 is the lowest range with zero false matches and zero cross-pump false duplicates (98.3% accuracy, 2/2 fraud groups). Default is now 0.28 from env (`FACE_MATCH_THRESHOLD`). docker-compose used to hardcode 0.30 and ignore `.env`.
- `Number(process.env.X ?? d)` turns an empty env var into 0, which would match every face. Parse with a range check and fall back to the default (see `faceMatchThreshold()`).
- A cross-pump flag skips the face completely, so nothing can be restored later unless the face is kept. Flags now store the face vector and crop (migration 019); flags raised before that can only be confirmed or fixed through manual correction.

## 2026-10-08 — Single-button shift flow and the live visual walk-through

- Postgres timestamps carry microseconds; a JS `Date` keeps milliseconds. Reading `submitted_at` into JS and passing it back as a parameter (`WHERE submitted_at = $1`, or `>= $1` to find "photos after this one") silently misses or includes the boundary row. Compare inside SQL or by id.
- `adapter-node` with `PROTOCOL_HEADER=x-forwarded-proto` and no `ORIGIN` assumes https when the header is absent. On plain local http every multipart upload then fails the CSRF check with 403 "Cross-site POST form submissions are forbidden". Production behind the HTTPS proxy is fine; local browser tests send `x-forwarded-proto: http` (see `playwright.live.config.ts`).
- Playwright dismisses `confirm()` by default, so a click on a confirm-guarded button (End session, Split, Delete) silently does nothing. Register `page.once('dialog', d => d.accept())` before the click, and also test the dismiss path.
- "Start only" means the shift is closed. Counting `morning_matched AND NOT evening_matched` on its own also counts a shift still waiting for its end. Use `shiftStillOpen()` from `shiftSessions.ts`, and give the pump screen a separate outcome for a start-only day instead of reusing "Shift complete".
- A fraud flag's `person_id` is the worker at the **other** pump. Labels built from it already contain that pump's code, so "X was also found at <other pump>" repeats the code. Say what the face matched and where.
- A long-running live test that hard-fails halfway leaves real data behind (open starts). Use `expect.soft` inside steps and keep only helpers and setup hard, so one wrong assertion does not burn another pump.

## 2026-10-13 — Mumbai live run: plain-http uploads, stuck failed photos, Split finalizations

- Local plain-http access (no proxy) must set `ORIGIN` in `.env` (e.g. `http://localhost:6100`). With `PROTOCOL_HEADER=x-forwarded-proto` and no header, adapter-node assumes https and every photo upload fails CSRF with a plain-text 403. compose passes `ORIGIN` only when it is set, because an empty `ORIGIN` stops the app from starting. Open the app at exactly that URL (localhost, not 127.0.0.1).
- The live Playwright config used to fake `x-forwarded-proto: http`, which hid that bug. Tests should send requests exactly as a browser does.
- Never read an error response with `res.json().catch(() => ({}))` and a generic fallback: the CSRF check, body-size limit and nginx answer text/HTML, and the cause vanished. The pump page now uses `failureMessage()`.
- A failed photo blocks the shift (failed start: submit refuses; failed end: its start reads as a full shift), and the pump screen never showed it after a reload. `/today` now returns `state: 'failed'` with `failed_session_id`, and the page offers Retry (SHIFT-11).
- Approving an end photo finalizes the day with the end's id. Admin Split moved that photo to another date but left the old date's finalization pointing at it, so every later delete of the photo failed on a foreign key. Split now repoints it to the old start; migration 022 repaired existing rows (SHIFT-04).
- A Sign in click before hydration is a plain form submit that reloads /login with empty fields. The button stays disabled until the page is interactive; tests wait for it to be enabled before filling.
- Live runs in one Area contaminate each other on the same day: the cross-pump check correctly flags the same test faces at a second pump. Use another Area, or clear the earlier run's shifts with `clearPumpAttendance`/`deleteSession`.

## 2026-10-15 — Worker failure paths, five-pump races, error toasts

- A claim query filtered on `attempts < MAX` re-claims crashed jobs, but a worker that dies during the **last** attempt leaves a job no query ever touches again: `processing` forever, and `/api/health` counts it as stale and answers 503, which also fails every deploy health check. Anything filtered out of the retry path needs its own sweep to a terminal state.
- Retrying a failed AI call at once wastes the attempts: an AI-service restart (model load) failed every photo in flight within a second. Retries now wait (`available_at`, doubling from `JOB_RETRY_BASE_SECONDS`).
- The success path must clear the error text a failed attempt wrote; otherwise a photo that worked on the second try still carries "failed" wording.
- `session.error_reason` reaches the pump screen. Raw errors there ("The operation was aborted due to timeout", file paths) mean nothing to an operator and leak internals. Keep the raw error in `attendance_jobs.last_error`.
- Running two workers in the regression gate is cheap and is what actually exercises cross-worker races: one run logs about 40 `SERIALIZABLE` conflicts, all retried, with exact results (CONC-01..08).
- Tests can reach "a worker crashed here" without killing a process: write the photo into `UPLOAD_DIR` and insert the session and job rows in the state a crash leaves (WRK-03/08/09).
- Base-path URL bugs kept coming back one page at a time (pump review photo, then the location approval photo). Cause: SvelteKit's default `paths.relative: true` makes server-side `resolve()` return `../../...`, which is only right for the exact URL it was computed for, not for a `__data.json` load, an API response or an email. `paths.relative: false` (vite.config.ts) makes it absolute everywhere. The regression build uses an empty BASE_PATH, so a missing prefix still works there: PATH-07 checks for `../` in `__data.json` instead.

## 2026-10-22: Worker names, plant manager fixes, faces on click

- Every processed photo waits in `review` until the pump presses Complete, so a mandatory step belongs at approve, not at submit: the photo is never blocked, and a worker is named once (on first sight), not on every photo.
- A missed shift start leaves one photo that the system rightly records as the start. Correction used to require a photo of the matching type, so neither admin nor plant manager could mark the end present. Corrections now need any processed photo that day; the reason and the actor (admin or plant manager) are stored.
- Base64 face crops (~17 KB each) inlined in list pages made a 20-row session log weigh megabytes. List pages now serve crops through cached, role-checked image routes and load them on click; only fraud faces, the evidence a reader must see at once, stay inline.
