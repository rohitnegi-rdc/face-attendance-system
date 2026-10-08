# Production Readiness Audit (2026-10-08)

**Verdict: 55/100, Risky.** Do not go live yet. The core pipeline (submit, queue, worker, matching,
pairing, admin review) is well built and well guarded against races. What is missing is a handful
of test-mode leftovers, a way for a pump operator to erase fraud evidence, a pairing rule that
misfiles attendance when someone misses a session, and a deploy gate that does not run the tests.

Scope: the local checkout on `main` (7 commits ahead of `origin/main`, plus a large uncommitted
diff). Docker and `.env` were not available, so no end-to-end test was run against this code. The
score is capped at 84 for that reason alone, and the blockers below pull it further down.

---

## 1. Blockers (fix before go-live)

| # | Problem | Evidence | Fix |
|---|---|---|---|
| B1 | Evening gap is 1 minute, not 9 hours. The pump sees the message "Test evening rule". This breaks a non-negotiable in CLAUDE.md. | `src/routes/api/attendance/submit/+server.ts:10`, `src/routes/api/attendance/today/+server.ts:6` (two separate constants) | One env var `EVENING_MIN_GAP_MINUTES` (default 540), read in one shared helper used by both files. Remove the "Test" wording. |
| B2 | A pump operator can delete their own **completed** session through Retry. That deletes the photo, the evidence, the attendance rows **and any `fraud_flags`**. There is no time limit and no admin involvement. A pump caught by the cross-pump check can erase the flag. | `src/routes/api/attendance/retry/[id]/+server.ts:85` allows `completed`; line 115 deletes `fraud_flags` | Allow pump retry only for `failed` and `review`. Block it when the session has fraud flags. Move retry of completed sessions to admin only, and keep an audit row instead of hard-deleting. |
| B3 | Missed evening misfiles the next morning. Morning at 08:00, no evening that day, next photo at 07:30 the following day is 23.5h later: it is inside the 24h window, so it is recorded as **yesterday's evening**. Every later session that day shifts by one slot. | `EVENING_PAIRING_WINDOW_HOURS` default 24; pairing in `submit/+server.ts` picks the most recent open morning | Decide the rule (see product gap P1). Shortening the window to about 16h fixes the common case without breaking night shifts. |
| B4 | Fraud check ignores brand-new workers and sessions in review. It only compares against `persons.status = 'active'` and `attendance_sessions.status = 'completed'`. The same new worker at two pumps on day one is never flagged, and whichever pump has not approved its review yet is invisible to the other. That makes detection depend on order, which CLAUDE.md forbids. | `worker/index.js` cross-pump query (`p.status = 'active' AND ats.status = 'completed'`) | Include `pending_review` persons and `review` sessions in the cross-pump comparison. Add scenario FRD-05 before changing it. |
| B5 | The deploy gate runs only `npm run check`. No test runs before deploy, so the "stay on the previous version if tests fail" goal is not met. | `scripts/deploy.sh:23` | After the fast test tier exists (see test plan, Tier 1), set `DEPLOY_CHECKS` to run it. |
| B6 | Nothing is pushed. `origin/main` is 7 commits behind, and most of this work is uncommitted, so `deploy.sh` (which requires `main == origin/main`) cannot deploy it yet. | `git status` | Commit in logical pieces, push, then deploy. |

## 2. High-value fixes (next, in order)

1. **Login brute force.** `/api/auth/login` has no rate limit or lockout. Pump logins use predictable emails (`<pumpcode>@pumps.rdc`). Add a per-email and per-IP limit (a small Postgres table is enough; no Redis needed).
2. **Cross-pump false positive has no recovery.** Admin "review" on a fraud flag only sets `reviewed = true`. If the flag was wrong, the worker stays absent for that day. Add "Not fraud, mark present" (it can reuse the manual correction path in `admin/attendance/correct`).
3. **Threshold mismatch.** CLAUDE.md says `FACE_MATCH_THRESHOLD` defaults to 0.68. Code defaults to 0.30, and `docker-compose.yml` **hardcodes** `'0.30'` for app and worker, so the `.env` value is ignored. Pick one value backed by the eval results, make compose read `${FACE_MATCH_THRESHOLD:-…}`, and update CLAUDE.md. Same for the hardcoded `EVENING_PAIRING_WINDOW_HOURS: '24'`.
4. **Health check can trigger a rollback for the wrong reason.** `/api/health` returns 503 when the oldest queued job is older than 300s. A backlog during a deploy fails the health check and rolls back a good release. Use a liveness check (DB plus process) for deploy and Docker, and keep the queue-lag check as a separate readiness or alert signal.
5. **Remove the scaffold routes** `src/routes/demo/**`.
6. **Security headers.** There is no CSP, `X-Frame-Options` or `Referrer-Policy`. Add them in nginx or in `hooks.server.ts`.
7. **Account lifecycle.** There is no way to deactivate a vendor or plant manager, move a pump to another vendor or plant, manually disable a pump, reset a plant manager's or admin's password, or change your own password after first login. These come up in week one of real operations.
8. **Lint debt.** 339 ESLint errors (238 `no-explicit-any`, 70 `require-each-key`, 17 `no-navigation-without-resolve`). Svelte-check is clean. Fix `require-each-key` first, because missing keys cause real list-update bugs, then make lint part of the deploy gate.
9. **`Plant Managers.csv`** (real names and emails) sits untracked in the repo root and is not ignored. Move it out or add it to `.gitignore`.

## 3. Product owner review: is v1 complete?

The core idea is complete for one happy-path day. These gaps decide whether vendors can actually
use it for payroll and whether the anti-fraud promise holds.

| # | Gap | Why it matters | Suggested v1 decision |
|---|---|---|---|
| P1 | What happens when a pump misses morning or evening? Today a missed morning turns the evening photo into a "morning", and a missed evening shifts the next day (B3). | This happens every week at some pump. | Evening must arrive within about 16h of morning. An admin can mark a day "evening only" if needed. Alternatively, the operator picks Morning or Evening explicitly, with the server validating the choice. |
| P2 | Workers are anonymous ("ASLPWWI2 Worker 3"). | Vendors pay people, not numbers. They will keep a separate sheet, and it will drift. | Let the vendor (or admin) attach an optional name or employee code to a person. This is not enrollment; the face stays the identity. |
| P3 | Only admin can export attendance. Vendors and plant managers cannot. | Payroll and billing are the reason vendors use this. | Give vendor and plant manager a scoped export. The export code exists, so this mostly needs scoped routes. |
| P4 | The pump operator approves unknown faces and retries their own sessions, with no oversight (B2). | The person being checked controls the check. | Pump can approve new faces, but admin or plant manager sees a daily "new workers" list. Retry of completed sessions becomes admin-only. |
| P5 | Biometric data: no consent notice, no retention period, no deletion path. Photos and face crops are kept forever (crops are stored as base64 inside Postgres). | India's DPDP Act 2023 treats this as personal data that needs notice, purpose limitation and erasure. Get legal review; this is not legal advice. | A consent line on the pump screen, a retention period (e.g. 90 days for photos, longer for attendance totals), and a cleanup job. |
| P6 | Fraud alert email is wired only to the falsified-photo path, which is off for v1. Cross-pump fraud does not notify anyone. | Admins must remember to open the fraud page. | Daily digest email to the plant manager: new fraud flags, pumps that did not submit, sessions in review. |
| P7 | No "pump did not submit today" view or alert. | Missing attendance is found at month end. | A list on admin and plant-manager home: pumps with no morning by 11:00 IST. |
| P8 | No offline or poor-network handling on the pump page beyond a failed upload. | Sites have weak signal. | v1: clear retry message and keep the selected photo. Later: queue the upload. |

## 4. Strengths (short)

- Race safety is real: per-pump advisory lock on submit, `SERIALIZABLE` matching with retry, `SKIP LOCKED` job claiming, stale-claim recovery, unique indexes as a last line of defense.
- Authorization is enforced server-side in `hooks.server.ts`, with per-record checks for pump and plant manager on photo and status endpoints. Disabled pumps are re-checked on submit, not only at login.
- Deploy has a backup, snapshot, health check and automatic rollback, plus the `main == origin/main` guard.
- An accuracy gate exists (`eval:*`, golden small-group corpus).

## 5. Evidence

**Checked:**
- `git status`, `git log`
- `package.json` scripts
- `scripts/deploy.sh`, `scripts/deploy-remote.sh`, `Dockerfile`, `docker-compose.yml`, `.env.example`
- `src/hooks.server.ts`, `src/lib/server/auth.ts`
- auth, submit, today, approve, retry, photo, status and health endpoints
- admin fraud-flags and plant-manager actions
- the cross-pump and local matching section of `worker/index.js`
- schema constraints in `db/init.sql` and migrations 001 to 017
- the existing test inventory (34 Playwright tests across 8 files)
- `npm run check`: 0 errors
- `eslint .`: 339 errors

**Missing** (each would change confidence):
- A green run of the existing Playwright suites against this code (Docker was down and there is no `.env`).
- A load run on the production server hardware.
- Server-side nginx config.
- A restore drill on the server (`scripts/restore-drill.sh` exists but has not been run there).
- Eval results for the threshold actually configured (0.30).

## 6. Next action

Fix B1 and B2 (small, contained changes), then build Tier 1 of
[RegressionTestPlan.md](RegressionTestPlan.md) so that each later fix lands with its scenario.

---

## 7. Status update (later on 2026-10-08)

| # | Status |
|---|---|
| B1 | Fixed. Gap is 540 min by default, one shared setting (`src/lib/server/settings.ts`), editable at /admin/settings. "Test evening rule" text removed. |
| B2 | Fixed. Pump retry is limited to `failed`/`review` sessions without fraud evidence. Admin delete/reset (per session, or whole pump with typed confirmation) is audited in `admin_audit_log`. |
| B3 | Fixed with the 16 h window (admin-editable). Missed-morning rule (PAIR-08) is still a product decision. |
| B4 | Fixed. The cross-pump check includes `pending_review` people and `review` sessions. |
| B5 | Fixed. `deploy.sh` runs `npm run test:regression` (36 scenarios, about 2 min) and stops with logs on failure. Deploy is also switched off (`DEPLOY_ENABLED=false`) until the app is stabilised. |
| B6 | Committed and pushed. |

Still open from section 2: login rate limit, a "not fraud" recovery for cross-pump flags, the compose-hardcoded `FACE_MATCH_THRESHOLD`, the health check as a rollback trigger, the demo routes, security headers, account lifecycle and lint debt.
