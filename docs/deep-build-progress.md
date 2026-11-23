# Deep build progress: regularisation calendar

## Scope
Pick a date on a month calendar and apply for regularisation, the same for pump, plant manager and admin.

## Findings
- The old flow only knew days with no photo at all. A day where a worker had only a start or an end could not be applied for.
- Approval used `ON CONFLICT DO NOTHING`, so a half-counted worker would have stayed half counted.
- Undo deleted the row, which would have lost a real photo on a half day. Migration 050 records which half was added.

## Acceptance criteria
- Colours: full green tick, half light red with Apply, missed dark red with Apply, regularised green R, rejected cross (can apply again), waiting hourglass, otherwise grey.
- Selectable: workers still on the pump with a real photo attendance there. Half day: only workers missing a half.
- Approval adds only the missing half. Undo removes only that half. Today never shows Apply. An open shift cannot be applied for.

## Test matrix
| Scenario | Type | Spec |
|---|---|---|
| REG-11, REG-12 | negative | tests/regression/regularisation-calendar.spec.ts |
| REG-13, REG-14 | data flow | same |
| REG-15 | approver email and link page, mail logged | same |
| REG-16, REG-17, REG-18 | browser to database, 390 px and desktop | same |
| REG-01 to REG-10 | earlier flow | tests/regression/regularisation.spec.ts |
| 13 screenshot tests | every state, Hindi and English, axe | tests/visual/regularisation-calendar.spec.ts |

## Work done
Migration 050, `regularisationDays.ts` (one day rule), half-day approve and undo, `RegularisationCalendar.svelte`, pump sheet, admin and plant-manager page, email and decision page labels.

## Found by looking at screenshots
Oversized radio and tick boxes on the admin form, a missing space in the decided line, and Next pushed off screen by a crew of 27. All fixed.

## Not covered
- Screenshot baselines are Windows only, and cover the pump sheet only. Admin and plant-manager screens were checked by eye.
- The full regression suite was not run, only the regularisation scenarios and unit tests.
- Nothing is deployed or committed.

## Blockers
None.

## 2026-11-17: Pump Day by day (ADM-18)
- Scope: admin pump page lists each day what the pump sent (by time sent, with the shift day it counted for), starts closed without an end, refusals from system_logs, status per day. Replaces the Daily attendance summary table.
- Files: src/lib/server/pumpDiary.ts, src/lib/components/PumpDiary.svelte, src/routes/admin/pumps/[id]/+page.*, tests/regression/pump-diary.spec.ts, playwright.paths.config.ts (root-path names for the gate).
- Verified: ADM-18 (data flow with a real duplicate submit, night shift, closed start, empty Active day), ADM-18 pump login blocked, REG-19. Screenshots 390 px and 1280 px inspected.

## 2026-11-17: Pump regularisation note box and voice note (REG-20)
- Why step: text box shown from the start (optional, needed for Something else without voice). Voice note tap to start / tap to stop with a timer (hold failed: the mic prompt ate the release). Sheet grid column pinned to minmax(0,1fr) (voice preview pushed it past 390 px).
- Verified: REG-20 x3 (fake microphone + real MediaRecorder + real upload, listed reason note, mic refused), regularisation.spec + regularisation-calendar.spec (18 passed), visual baselines (only step-why changed, inspected).

## 2026-11-17: 9 am email to business managers and business heads (SET-05)

- Scope: To adds the business managers of the Area's plants; CC adds the business heads of its plants (reworked the same day from a per-Area list to per plant, see below); each pump with a missed day request for the day shows reason, note, voice note and status.
- Files: `db/migrations/051_area_business_heads.sql`, `worker/attendanceDigest.js`, `worker/digestEmail.js`, `src/routes/admin/settings/+page.{server.ts,svelte}`, `tests/unit/attendanceDigest.test.ts`, `tests/regression/digest-business-heads.spec.ts`.
- Verified: lint, svelte-check, unit (all), SET-05 regression (4 tests); screenshots at 390 px and desktop inspected.

## 2026-11-17: business heads per plant with their own view (SET-05 rework)

- Scope: from the user's mapping `BHBMPLANTSMAPPING.MD` (8 business heads, 137 plants). Migration 051 now makes `is_business_head` + `business_head_plants` + `business_head_waiting` and adds them to `manager_plants`; 052 imports `052_business_heads.csv`. Business heads see Missed days, Attendance, Pumps and People of their plants, read only (every POST 403). Admin page `/admin/business-heads`, shared with Business managers (`businessRoleAdmin.ts`, `BusinessRolePage.svelte`). 9 am email CC = heads of the Area's plants. Settings lists To and CC per Area read only.
- Not imported from the mapping: its business manager and plant manager columns (some differ from 049 and 028); reported to the user.
- Verified: gate PASSED (lint, svelte-check, unit 71/71, digest-business-heads + regularisation + manager-pump-list specs); screenshots at 390 px and desktop inspected.

## 2026-11-17: CC by area for the 9 am email (SET-06)

- Scope: per-Area CC (`area_digest_cc`, migration 053) separate from the global CC; Settings "CC by area" with a search box (5 areas before typing, ticked first; 4 best matches while typing), add several / remove one, audited; worker adds it to that Area's CC only, no repeats.
- Files: `db/migrations/053_area_digest_cc.sql`, `src/routes/admin/settings/+page.{server.ts,svelte}`, `worker/attendanceDigest.js`, `tests/unit/attendanceDigest.test.ts`, `tests/regression/area-cc.spec.ts`.

## 2026-11-18: Pump GPS page + 9 am email recipients

- Scope: admin page /admin/pump-gps (latest position per pump, Fresh / Too old / No GPS, positions in 24 h, Google Maps link, refreshes every minute and on Refresh now). 9 am email: plant managers of the Area's plants added to To; every digest log line lists To and CC.
- Files: src/lib/gpsAge.ts, src/lib/server/pumpGps.ts, src/routes/admin/pump-gps/*, AppShell nav, worker/attendanceDigest.js, worker/mailer.js, tests/regression/pump-gps-page.spec.ts (LOC-16), tests/unit/attendanceDigest.test.ts (SET-07).
- Found: the refresh test raced the page script (server HTML showed before the timer started); the page sets data-ready on the live bar and the test waits for it.
- Found: BM/BH missing in production because b1a21b9 is on develop only; main is 2261910.
- No real mail sent: MAIL_ENABLED is never set locally; the unit test deletes it and asserts only the "NOT sent (mail off)" line.

## 2026-11-18: missed days decided by the plant manager where there is no business manager
- Rule: view `missed_day_deciders` (migration 055): business manager, else plant managers, else admins; business heads never. Plant managers no longer apply.
- Verified: unit 85/85; regularisation, calendar, escalation, voice, Kerala and auth-rbac specs pass (REG-05, REG-05b, REG-18 rewritten); gate PASSED; screenshots pm-missed-days-mobile/desktop inspected.

## 2026-11-21: Pump gangs, phase 1 (APPROVED SPEC, user said GO)
User: "GO ahead and implement this approach completely and test it properly with visual inspection and Don't delete the test results I will go through it". Keep all test output folders and screenshots (do not clean test-output/ or artifacts/).

Agreed requirement (from the conversation, do not re-decide):
- A pump can have several gangs; sometimes two at once on a big pour. Gangs rotate between pumps, only within an Area. No fixed gang per pump, no names: a gang is identified from faces; its first shift photo is its source. Still the same gang while most faces are the same (2 of 6 replaced = same gang).
- Goal: complete headcount tracking per gang (pay rules not ours). Extend existing headcount workbook `src/lib/server/headcountReport.ts` (Pumps sheet unchanged, new Gangs sheet in the same download: one row per gang grouped by Area/plant, headcount per day with each worker once a day, Avg MTD / Avg YTD same formula as pumps, + outline rows per pump the gang worked at, amber/red held days as today, daily total row reconciled with the pump sheet plus a note for workers seen at two pumps). Attendance page gets By pump / By gang view. Gang page: faces, members, day by day (pump, headcount, start/end, "ended near X"). 9 am email: gang lines under each pump.
- A worker at two pumps on the same day counts ONCE that day (for gang headcount).
- Switches at /admin/settings, audited: (1) Gangs per Area (areas column, off by default; unticked Area runs today's code exactly). (2) Fraud check "same face at two pumps on the same day (same Area)", OFF by default (production currently has it always on; CLAUDE.md non-negotiable must be updated to say this switch exists by user decision 2026-11-21).
- Workers linked across pumps within the Area by a clear face match (person rows stay per pump; add a cross-pump identity link). Close calls never auto-link: plant manager "Same person?" side by side.
- Gang tagging: each shift tagged with the gang most of its faces belong to; else new gang from that photo. Plant manager/admin can move a shift to another gang (audited), reports recalc.
- Two gangs at one pump: plant manager ticks "2 gangs today" on the pump status page (same row as Active/Idle). Only then the pump screen shows each running shift as a card with its faces ("running since", "end after") plus a "New gang starting" button; tapping a card = end that shift. The tap is only a hint: faces decide (wrong card -> the matching gang; new crew -> new start; same faces on New gang -> that gang's end once 9 h passed). One shift per gang per day replaces one per pump per day (unique index change). Each shift keeps its own 9 h rule, night date, 24 h cut-off, reminders. One-gang pumps: screen identical to today.
- Phone travels with the operator; operator signs in with the pump's normal login. NO QR stickers in phase 1. Gang vendor: NOT in phase 1.
- Gang moving pumps mid-day: option (b): the end photo is sent from Pump 1's login while at Pump 2. Extend the location check to shift ENDS, only in Areas with BOTH gangs and location check on: end >100 m from Pump 1 GPS is held (same 30 min GPS watch, then PM + monitor email with Approve/Reject, signed /location/<token> page). Email/page says "Shift end for PUMP1 was sent 4.2 km away, near BGPUMP07" (nearest pump by GPS). Approved -> full shift; rejected -> start only, reason shown, can still regularise. While held: end half not counted (amber in headcount, out of averages).
- Rollout: gangs start from the day an Area is switched on; past data untouched.
- Checks: accuracy gate (golden set) since matching changes; all existing tests unchanged; new regression tests: one-gang pump same numbers, gang moving between pumps incl mid-day held end, two gangs one pump, once-a-day count, fraud switch on/off, wrong gang moved, Gangs sheet totals vs stored attendance, gang switch off = old behaviour. Screenshots: pump screen 390 px, report + Gangs page desktop, inspected.

### Gangs phase 1: implementation design (decided while reading code, 2026-11-21)
Findings: submit decides start/end synchronously in `src/routes/api/attendance/submit/+server.ts` (lines ~108-165): open start (pairing_status 'open', session_type 'morning') -> end after gap, else start for today; "Today's shift is already recorded" refusal; unique index `attendance_sessions (pump_id, session_date, session_type)` in db/init.sql:98. Location check only for starts (`checkShiftStartLocation`, hold via location_ask_at). Fraud check = same shift date, other pumps in Area (worker; docs/Architecture.md §6). Headcount workbook `src/lib/server/headcountReport.ts` (Pumps sheet: day columns, Avg MTD/YTD, Old/New outline, held amber/red).
Design (migration 056_gangs.sql):
- `attendance_sessions.gang_slot int NOT NULL DEFAULT 1`; replace unique index with (pump_id, session_date, session_type, gang_slot). One-gang pump always slot 1 = identical behaviour.
- `areas.gangs_enabled bool default false`; `app_settings` key `same_day_fraud_check` ('on'/'off', missing = off). Fraud check in worker runs only when on (test mode still forces off).
- `pump_day_status.gangs smallint default 1` ("2 gangs today", set on pump status page by admin/PM/monitor, only meaningful when the Area has gangs on).
- Submit: optional form field `shift` = 'new' or an open start session id. Only honoured when Area gangs on AND pump_day_status.gangs >= 2 for today; else today's code path. 'new' -> start with next free slot (max gangs); id -> end that start (gap rule per start). Opening many open starts: expireStaleStarts per start already loops? check.
- Worker (faces decide): after matching an end in a multi-gang day, if its faces overlap another open start of the same pump more than the tapped one, re-pair to that start (gap passed); a 'new' start whose faces mostly (>50%) match an open start past its gap becomes that start's end.
- Cross-pump identity: `area_workers(id, area_id)`, `persons.area_worker_id`. Worker links a new person at pump P to an existing area worker when best Area-wide gallery similarity >= GALLERY_ADD_THRESHOLD (0.40) with margin; close calls (>= match threshold, < link bar) go to `worker_link_candidates` for PM "Same person?". Names copy from the linked worker when the new person has none.
- Gangs: `gangs(id, area_id, source_session_id, created_at, name)`, `attendance_sessions.gang_id`. On each completed START in a gangs Area: area workers in the photo vs each gang's members (area workers seen in the gang's last 5 shifts); best gang with overlap > 50% of the photo's linked workers -> tag; else new gang (source = this session). End inherits start's gang. Admin/PM move shift to another gang (audited `move_shift_gang`).
- Held far END: in Areas with gangs AND location check on, an end photo > 100 m from the pump GPS is held like a start (same location_* columns + hold worker); email/page text "Shift end for X was sent N km away, near <nearest pump>" (nearest pump from pump_locations latest per pump in Area). While held, end half not counted.
- Gang headcount: per gang per day = distinct area workers (persons without link count as themselves) in the gang's sessions that day, each worker once a day across pumps.
- UI: pump screen running-shift cards only when gangs>=2 today; /admin/gangs + /admin/gangs/[id] (and plant-manager equivalents scoped by manager_plants); Attendance page By pump / By gang; headcount workbook Gangs sheet; 9 am email gang lines; settings: gangs per Area + same-day fraud switch.
Worker hook points (worker/index.js processJob): `skipFraudCheck = await testModeOn(pool)` at ~575 -> also skip when same_day_fraud_check is off (spoof/screen fraud stays). Matching tx ~581-746: localFaces -> `assignFaces` (~654) -> per face writes persons/saveFace/attendance_face_evidence/daily_person_attendance (uses session.session_type for morning_/evening_ columns; dpa unique (person_id, session_date)). Plan: right after assignFaces, in gang Areas with a multi-gang day, compute overlap of matched person ids with each open start's evidence persons (same pump) and correct the tap (re-pair end / convert a 'new' start into an end) by UPDATE attendance_sessions BEFORE the dpa writes, using the corrected session_type/date. After the per-face loop, before COMMIT: new module `worker/gangs.js` `linkAndTag(client, session, areaId, personIds, newPersonIds)` (area worker link for new persons via Area-wide gallery search excluding own pump, >= 0.40 and margin 0.10 auto, >= threshold candidate; then gang tag for starts, end inherits start gang).
Progress: [x] gate started. [x] db/migrations/056_gangs.sql written (areas.gangs_enabled, pump_day_status.gangs, attendance_sessions.gang_slot + unique (pump,date,type,slot), area_workers, persons.area_worker_id, worker_link_candidates, gangs(code per area, source_session_id, first_pump_id, name), attendance_sessions.gang_id, near_pump_id). Fraud switch uses app_settings key `same_day_fraud_check` (no migration row; missing = off).
Next: settings (src/lib/server/settings.ts + /admin/settings UI: gangs per Area, same-day fraud switch), worker fraud switch, worker/gangs.js (link + tag + tap correction), submit multi-gang + held far end, pump screen cards, pump status "2 gangs today", gangs pages, headcount Gangs sheet, attendance By gang, 9 am email gang lines, tests (unit tests/unit/gangs.test.ts, regression tests/regression/gangs.spec.ts), docs.
Progress: [x] worker/gangs.js written (sameDayFraudOn, gangsOnForPump, gangsForDay, ensureAreaWorker, linkNewPerson, sessionWorkers, gangMembers, pickGang, tagGang, correctTap, nearestPump; constants LINK_THRESHOLD 0.4, LINK_MARGIN 0.1, GANG_SHARE 0.5, GANG_RECENT_SHIFTS 5, MAX_GANGS 4). Next: wire into worker/index.js processJob.
Progress: [x] worker/index.js wired (fraud switch, correctTap before dpa writes, linkNewPerson/ensureAreaWorker/tagGang before status update). eveningGapMinutes exported from worker/endReminders.js.
Progress: [x] submit: shift choice (new / start id) on multi-gang days, first free gang_slot, end location check in gang Areas + near_pump_id. [x] heldShiftStatus counts a pending END; decideLocation reject of an END clears evening_matched. Next: worker/locationHold.js email/page text for ends (near pump), settings + admin settings UI, pump status '2 gangs today', pump screen cards, gangs pages, headcount Gangs sheet, attendance By gang, digest lines, tests.
Progress: [x] worker/locationHold.js email words for held ENDS (session_type, near_pump_code, awayText km). TODO: /location/[token] page words for ends.

### Gangs phase 1: verification (2026-11-23)

- New regression spec `tests/regression/gangs.spec.ts`: GANG-01, 02, 04, 04b, 05, 06/07, 08, 09, 10, all passing. Unit `tests/unit/gangs.test.ts` passes (unit suite 95/95). svelte-check 0 errors.
- Related existing specs rerun (attendance, location, fraud-review-admin, fraud-rename, nav-badges, regularisation, digest-business-heads, reports, shift, admin-pumps, admin-shift-split, pm-fix-attendance): all pass after the fixes below.
- Found by tests: SET-03/04 assumed an empty `app_settings`; Reset to production defaults now also clears `same_day_fraud_check` (production default off), SET-03 ignores the suite baseline row. SET-05: the 9 am email printed "Asha Patil ()" when no decider role was known (from the 2026-11-18 change); the brackets are left out now and the test passes the role.
- Found by tests: `playwright.paths.config.ts` also ran stale spec copies under `.claude/worktrees/`; it now ignores `.claude/**`.
- Found by looking at screenshots: the gang page said Average headcount 2 next to Members 1 (the operator counted in the headcount but was left out of members); the operator is now a labelled member and GANG-08 checks members = headcount. "1 days this month" fixed. Phone screenshots taken after a resize caught the side menu mid-slide; the shot helper waits for animations. Settings: space above the Same-day fraud check heading.
- Accuracy gate: the golden script's own default threshold is 0.68 (stale, gives the 10 % match recall recorded in Learnings 2026-08-11); the gate is run at the configured 0.28. Gangs do not change detection, embeddings, threshold or matching SQL.
- Screenshots: `artifacts/deep-build/screenshots/gangs-*.png` (pump picker 390, attendance By gang 390/1440, gang page 1440/390, gang list, approvals and location link 390, settings 1440). Logs: `test-output/gangs-run-*.txt`, `test-output/gangs-related-run*.txt`, `test-output/golden-eval-gangs*.txt`.

### Gangs phase 1: shift end location check removed (2026-11-23, user)

- User: only the start is location checked; let the pump mark the end from that pump. Removed the held end everywhere: submit (end never checked), `nearestPump`, `near_pump_id` (dropped from migration 056 before it shipped), the end branch in `decideLocation`, end wording in the location email, the link page and Approvals, "held end" on the gang page, grid legend and 9 am gang line (amber now means a held start, as on the pump sheet). GANG-04/04b replaced by GANG-04: an end 520 m away counts at once, nothing asked.

