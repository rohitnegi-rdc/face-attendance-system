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
