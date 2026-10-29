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

### 2026-10-22: pagers built from `window` crash server rendering

The admin pump, area and vendor pages built pager links with `new URLSearchParams(window.location.search)`. That runs during server rendering whenever a pager shows (more than one page), so those pages returned 500 only once the data grew past one page, and never in small test data. Build page links from `page.url` (`$app/state`), which exists on the server and in the browser. UI-12 renders the admin pump page with 26 workers to keep the pager on.

### 2026-10-23: the fraud check compared old gallery faces, not today's

The cross-pump check matched each new face against all up-to-5 saved faces of every worker at other pumps who attended that day, including faces from earlier days. An old, worse photo let a stranger reach the threshold, and the flag then pointed at today's session, which did not hold the matching face. The check now joins each face to its own session (`ats.id = pfv.session_id`) and compares only faces from that pump's sessions of the same shift date. Same-pump matching still uses the full gallery, where older faces help with light changes. FRD-14.

### 2026-10-23: the same-pump match skipped new workers the fraud check counted

The cross-pump check compared `active` and `pending_review` people, but the same-pump match only `active` ones. A new worker stays `pending_review` until the pump presses Complete. A shift end must wait for a completed start, but the next day's start does not wait for a completed end, so a worker first seen at an uncompleted end became a second new person the next morning. (First guess was wrong: I assumed the end photo could follow an uncompleted start; submit refuses that, so check the submit guards before naming a scenario.) Both lookups now live in `worker/faceQueries.js` and include `pending_review`, as does admin "Not fraud" (`fraudResolution.ts`). The class guard: any lookup of "this pump's people" must use the same status set as the fraud check. Side effect fixed with it: deleting or retrying a session removed every `pending_review` person in its photo, which would now include the worker an earlier uncompleted end found; it removes only people no other session has seen (`sessionCleanup.ts`). Unit tests: `npm run test:unit` (`tests/unit`, real pgvector database, no app); regression MATCH-09.

### 2026-10-23: wrong matches fed on themselves through the gallery

Every matched face was saved into the person's gallery (5 newest faces), however weak the match, and the oldest face was dropped, the first one included. A stranger matched at 0.29 added their face to the worker, so the same stranger matched them more easily the next day, and after five such photos the worker's real face was gone. An admin's "Incorrect person match" flag only recorded a note. The golden set has one photo per day, so it never showed this; it needs several days per person. Now (migration 035, `worker/faceQueries.js` GALLERY): a matched face joins the gallery only at `GALLERY_ADD_THRESHOLD` (0.40) or more and when it beats the next-closest worker by `GALLERY_ADD_MARGIN` (0.10); otherwise it still counts attendance and keeps its row with `in_gallery = false`, because the photo's review screen, Complete and the cross-pump check read rows by session (simply not saving the row would have hidden the worker from the fraud check). The face a person was created from is the anchor and is never trimmed. "Incorrect person match" takes that face out of the gallery. The numbers come from the golden run's match-pairs.csv: different people never above 0.24, 88% of same-person faces at 0.40 or more, every correct match at least 0.15 ahead. Unit: `tests/unit/gallery.test.ts`; regression MATCH-10.

### 2026-10-23: two faces in one photo could take the same worker

Each face took its own best match, so two faces closest to the same worker both took them, and the evidence insert (`ON CONFLICT (session_id, person_id) DO UPDATE`) folded the second into the first. One worker was marked absent and the photo looked clean. The rule already existed for new workers (two new faces never become one person) but not for known ones. Now the worker collects every face's closest people first, then `assignFaces` hands out workers strongest match first, one face each; a face whose worker is taken takes its next-best worker above the threshold or becomes a new worker, and stays out of the gallery. Rejected: a warning on the pump's review screen and a hard stop. Operators are not expected to judge faces, so matching problems are solved in code. Unit: `assignFaces` tests; regression MATCH-11.

### 2026-10-23: admin face fixes, and why a merge could be undone

"Flag error" only recorded a note, and there was no way to move one face to another worker, undo a merge, add a worker the camera never found, or clear an old fraud flag that had no stored face. Now (migration 036, `src/lib/server/faceFixes.ts`): Flagged errors (`/admin/review-flags`) closes each flag as moved, new worker, marked present or dismissed; Move face and Undo merge sit on the admin worker page; Attendance > Correct adds a never-detected worker; fraud flags without a face take a chosen worker. One face per worker per photo holds for every fix. Undo merge works because merge never moved `attendance_face_evidence`: those rows still say which photos the merged worker was in, so keep them unmerged. A worker left with no face, photo or day after a move is archived. Worker choices show each worker's latest face next to the face being fixed. Two slips caught at 390 px: an inline `{#if}` after text drops the space before "·" (build the line as a joined list), and a long worker list hid "New worker" at the end, so it comes first. Forms in the browser must use the app's `ORIGIN` host (localhost, not 127.0.0.1), or SvelteKit refuses the POST. Unit: `tests/unit/faceFixes.test.ts`.

### 2026-10-23: the Excel hid days the screen showed ("-" meant two things)

A plant manager saw workers on the attendance grid, but the headcount Excel showed "-" for the same pump and day, and the sheet's own legend says "-" means no photo was sent. Cause: `heldShiftDay` dropped every day whose shift start was waiting for location approval or had been rejected. It was dropped from both Excel files (headcount and attendance report), and the screen grids never had that filter. The guess was "leave a held day out until it is approved". It was wrong because leaving a day out looks the same as having no data: two different states shared one symbol, and the screen and the file disagreed. Now `heldShiftStatus` returns 'pending' or 'rejected' and both reports show the day. Headcount shows the real count, amber for pending and red for rejected, with a cell note. The attendance report gives it the day result "Location pending" or "Location rejected". Both leave the day out of totals and averages until it is approved, and the legend says so. Rule: a report never drops a day it has data for; it marks the day and says why it is not counted. Regression LOC-04 and LOC-05 (flipped).

### 2026-10-26: test mode behind a server env was invisible where it was needed

Test mode (fraud check off) worked only while the server env `TEST_MODE=true`, so on production the switch was simply missing from /admin/settings and the admin could not tell why. The guess was "keep production safe by making test mode impossible there". It was wrong because testing happens on production with real pumps and a few testers, and changing an env file plus a rebuild is not something the admin does. Now test mode is one admin switch (`app_settings` key `test_mode`): it turns the cross-pump fraud check off and holds back fraud alert and location approval emails (logged instead; password reset emails still go, a person asks for those). Safety moved from "impossible" to "impossible to miss": a confirm before turning it on, a red banner with since when and by whom on every admin page, an audit entry, and Reset to production defaults turns it off. Migration 038 deletes the old `fraud_check_disabled` key, because a value left behind while the env gate ignored it would otherwise have switched test mode on the moment the gate went away. Rule: a switch that changes a safety check must be visible where it is used, and renaming its storage must not wake up stale values. Regression FRD-13 (flipped), LOC-11.

### 2026-10-26: "Clear test records" wiped genuine attendance too
- The button deleted every session and worker of the pump. Its name promised test data, but nothing in the data said which records were tests, so one click on a live pump would erase real attendance.
- Fix: each session stores `test_mode` at submit (migration 039). The clear deletes only shifts where every photo was taken in test mode, plus workers left with no photo; a shift that is part test, part genuine is kept and reported.
- Rule: a destructive action named after a kind of data needs that kind recorded on the row. Records from before the flag count as genuine.

### 2026-10-26: unit and regression gates shared a database port
- The unit database used port 6114, which is regression lane 2's database port since the lanes were added. Run one after the other it worked; run in parallel, the regression failed at "Prepare test databases" with "port is already allocated".
- Fix: the unit database moved to 6199. Rule: a new port range (like the lanes' 6104 + 10·i) must be checked against every other script's fixed ports.

### 2026-10-26: web-push sendNotification always speaks https
- The shift end reminder test posted to the stub push service at an http:// address and got `EPROTO ... packet length too long`: `webpush.sendNotification` uses `https.request` whatever the address says.
- Fix: `worker/endReminders.js` builds the encrypted, signed request with `webpush.generateRequestDetails` and sends it with `fetch`, which follows the address. Production push services are https anyway.
- Rule: when a library hides the transport, test against the real protocol, or take the transport into your own code so the test exercises the same path.

### 2026-10-26: the reminder question was hidden behind the guide, and the browser test could not show notifications
- The pump screen asked for notifications only from a card, and the guide that opens on every visit covered that card, so on a real phone nothing seemed to ask. The guess was "a card with an Allow button is enough". It was wrong because the first thing a pump sees is the guide, and browsers only ask after a tap. Now the browser's own question opens on the first tap anywhere on the pump screen (closing the guide counts); the card stays as the fallback and says why when reminders cannot work (http, unsupported browser).
- Schedule changed at the user's request: first reminder the moment the shift can end, then every 15 minutes, 4 at most.
- Testing: Playwright's default headless shell refuses `showNotification` even with the permission granted. `chromium.launch({ channel: 'chromium' })` (full Chromium, headless) shows them. Chromium under Playwright has no push service, so REM-02 points the subscription at the stub, decrypts the message the worker sent (RFC 8291) and hands it to the real service worker with the DevTools command `ServiceWorker.deliverPushMessage`.
- Rule: a permission request must not sit behind something that opens first; test a notification feature through the real service worker, not only up to the push service.

### 2026-10-26: "ask on the first tap" still did not ask on a real Android phone
- Production ran 3eeaad8 (ask on the first tap on the pump screen), yet the user, on Android Chrome, saw no question after signing in. The guess was "the first tap after the guide is soon enough". It was wrong because the user expects the question the moment they sign in, before anything else, and a test that fakes the question cannot show whether a real phone shows it.
- Fix: a pump login is asked on the Sign in tap itself (a tap, so every browser allows it) and the login page waits for the answer before moving on, because leaving the page drops the question. A phone still undecided is asked as the pump screen opens, and on its first tap there.
- Rule: ask for a permission at the user's first deliberate tap in the flow (here Sign in), not at a later screen; and verify permission prompts on a real phone before calling it done, since Playwright answers them itself.

### 2026-10-27: Chrome called the shift end reminder "possible spam"
- After reminders finally reached the user's Android phone, Chrome showed them with "this notification might be spam". The site had no app icon and was a plain browser tab, so Chrome had nothing that marked it as an app the user trusts.
- Fix: the pump screen is installable (manifest with the RDC truck icons, an Install app card when Chrome offers it) and every reminder carries the RDC icon and a badge. Notifications from an installed app are the documented way past the flag, but Chrome decides on its own, so it is not guaranteed.
- Rule: anything that sends notifications ships with real icons and an install path from day one; a bare site sending repeated reminders looks like spam to the browser.

### 2026-10-27: asking for notifications by itself gave way to an Enable notifications button
- The earlier guess was "ask as early as possible": on the Sign in tap, then on page open, then on the first tap anywhere. Chrome treats a question the person did not clearly ask for as unwanted: it may show only the quiet bell, and repeated dismissals pause asking for a week, so asking early cost more answers than it won.
- Fix (user's flow): sign in, an Enable notifications sheet with one line of why, the button opens Chrome's question, the subscription is saved only once allowed. The guide waits behind the sheet.
- Rule: a permission question follows a tap on a button that names it, after a short reason; never piggyback on an unrelated tap.

## 2026-10-28: worker names are not unique per pump

- Migration 033 made names unique per pump, guessing that a repeated name is one person split in two by the matcher. Real crews have two Rajus, so the operator was refused and told to add a father's name or village. That is an operator decision, which the app avoids.
- Why the guess was wrong: it used the name as an identity signal. The face is the identity; the name is only a label. Splits are found by face similarity in the admin merge review, not by names.
- Now (migration 041): same names are allowed. Every label keeps the worker number beside the name (`personShortLabel`: "Raju (#3)"), and the face shows next to it, so same-named workers stay apart.

## 2026-10-29: "Same people?" asked from the wrong side

First version: one row per worker seen only at the shift START, with the end faces to tap. On real data (6 only at start, 1 only at end) the same lone end face repeated in six rows, with jargon ("Not paired", "Merge 1 pair"), and the user found it confusing. The problem the user has is "who is this new face at the end?", so ask exactly that: one question per new face at the END (usually the smaller side), its face big beside the start faces, the likeliest first and picked, "Someone new" as the way out, plain outcome text ("Same person as X" / "Stays a new worker"). Lesson: build a pairing question around the thing that looks wrong (the new face), not around the list that looks normal.

## 2026-10-29: shift card badge for "Same people?" removed

A yellow "Same people? N new faces at shift end" badge sat on every shift card next to Fix attendance. The user asked to drop it: two links to the same page on one card is duplicated UI, and on real data almost every card with a new face at the end showed it, so it read as noise rather than a warning. The question now lives only on Fix attendance (top of the page). The card was tidied at the same time: every tool (Fix attendance, Delete / reset, Fix shift, fraud buttons) is one compact outlined button, the photo tools sit on their own row at the bottom of both halves so start and end line up, and face chips get room for "Name (#1) (Operator)". Lesson: a hint that shows on most rows is not a hint; put it where the fix happens.

## 2026-10-29: two Fix attendance pages drifted apart

The admin and the plant manager each had their own Fix attendance page. Features were added to one at a time: the admin got duplicates, missed workers and whole photos, the plant manager got the friendlier roster (missing a shift first, reason only after a tick changes). Neither had a rename. The user asked for the plant manager to have "the same interface". Now there is one component (`FixAttendance.svelte`) and one server module (`fixAttendance.ts`) taking the actor, so a feature added for one role lands for both, and the plant manager limit is one SQL condition. Same for the People list (vendor and plant manager). Lesson: when two roles do the same task, build one page with an actor, not two pages; copies drift with every change.
