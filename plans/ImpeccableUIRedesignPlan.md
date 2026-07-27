# Face Attendance UI Redesign Plan

**Status:** Approved design direction, ready for implementation  
**Created:** 2026-07-27  
**Product:** Face Attendance  
**Register:** Product UI  
**Design direction:** Guided Workforce  

## 1. Purpose

Redesign the complete Face Attendance interface as a coherent, production-ready
product for three roles:

- Pump operators capturing attendance outdoors on mobile phones.
- Vendors monitoring pumps, anonymous persons, and attendance.
- Administrators reviewing attendance, fraud flags, guests, merges, and imports.

The redesign must improve workflow clarity, responsiveness, accessibility, and
visual quality without changing the established attendance, identity, fraud, or
background-worker rules in `plans/MasterPlan.md`.

## 2. Current UI Audit

The current interface is a functional prototype, but it has no shared product
design system. Each route contains isolated CSS and basic HTML controls.

Primary problems:

- Browser-default typography, controls, tables, and spacing.
- No shared application shell or persistent role navigation.
- No reusable tokens for colors, spacing, type, radius, elevation, or motion.
- Weak hierarchy between page titles, filters, metrics, actions, and content.
- Pump capture is a raw file input rather than a guided field workflow.
- Uploading and processing states are text-only and provide little reassurance.
- Admin tables do not adapt properly to narrow screens.
- Fraud, guest, and merge reviews lack enough visual evidence and context.
- Vendor information is presented as two raw tables without summary or trends.
- Empty, loading, offline, validation, and long-content states are incomplete.
- Focus, keyboard, status announcement, and touch-target behavior is inconsistent.

This redesign is structural. Applying the supplied colors to the existing pages
is not sufficient.

## 3. Approved Direction

Use the selected Guided Workforce concept as the visual foundation:

- Use Direction C's supportive, step-by-step workflow language.
- Use Direction A's compact horizontal metric strip.
- Use Direction B's sticky mobile capture action.
- Keep the experience friendly, dependable, calm, and operational.
- Use familiar controls and predictable navigation.
- Favor clear grouping, dividers, and whitespace over grids of decorative cards.
- Use real group photos and detected face crops as the meaningful visual assets.

Do not literalize inaccurate generated-mock content:

- The pump captures a group photo, not one employee portrait.
- People remain anonymous. Since the Attendance Insights Overhaul (2026-07-27), the
  product no longer shows raw UUID slices — every person is rendered through
  `personDisplayLabel(pumpCode, displaySeq)` as a stable, pump-scoped label such as
  `BGLPRVN1 Worker 3` (`persons.display_seq` is a permanent per-pump sequence
  assigned once, at first detection, and never renumbered). This is still an
  anonymous identifier, not an invented name — the redesign must carry this label
  format everywhere a person appears, rather than reverting to a raw ID or
  introducing real names.
- Raw face embeddings are never displayed in the product UI.
- Do not add employee enrollment controls.
- Do not introduce colors outside the approved tonal palette.

## 4. Users And Usage Context

### Pump operator

- Uses a phone outdoors, often in bright daylight.
- May be rushed, use one hand, or have an unstable connection.
- Needs to know which session is due, when another submission is permitted, and
  whether the submitted group was processed.
- Primary action: take and submit the current group attendance photo.

### Vendor

- Uses phone, tablet, or desktop.
- Reviews attendance across assigned pumps, plants, and areas.
- Needs concise summaries followed by pump and person-level detail.
- Cannot create pumps or manually enroll people.

### Administrator

- Primarily uses desktop, with tablet and mobile support for urgent reviews.
- Monitors the platform, filters attendance, exports records, and resolves
  review queues.
- Needs dense but readable data, reliable evidence, and clear action outcomes.

## 5. Design Principles

1. **Guide the next action.** Each screen must make the primary task obvious
   within two seconds.
2. **Use evidence, not decoration.** Group photos, face crops, timestamps,
   similarity, pump context, and status history carry the interface.
3. **Support field conditions.** Large controls, clear contrast, retained photo
   previews, and recoverable network failures are required.
4. **Keep identities honest.** Use the anonymous, pump-scoped `personDisplayLabel`
   (e.g. `BGLPRVN1 Worker 3`) and never imply the system knows a person's real name.
5. **Make review work efficient.** Admin evidence and actions stay visible
   together, with minimal navigation between list and detail.
6. **Use color consistently.** Teal means action, selection, progress, or
   success. Critical states also require icons and explicit text.

## 6. Visual System

### 6.1 Color

The supplied colors remain the brand anchors:

| Token | Value | Role |
|---|---:|---|
| `--brand-mist` | `#BBBFBF` | Dividers, strong borders, inactive structure |
| `--brand-steel` | `#878787` | Disabled controls and low-priority decoration |
| `--brand-teal` | `#05AD98` | Primary action, active navigation, progress |
| `--brand-white` | `#FFFFFF` | Main canvas and elevated surfaces |

Accessible tonal derivatives:

| Token | Value | Role |
|---|---:|---|
| `--ink-strong` | `#162625` | Headings and critical text |
| `--ink-default` | `#263735` | Body text and table values |
| `--ink-muted` | `#4D5E5B` | Secondary text and metadata |
| `--surface-subtle` | `#F5F7F7` | Page background and alternating rows |
| `--surface-muted` | `#E9EEEE` | Toolbars, disabled areas, skeletons |
| `--primary-hover` | `#049887` | Primary hover state |
| `--primary-pressed` | `#037C70` | Primary active state |
| `--primary-on` | `#102725` | Accessible text on `#05AD98` |
| `--primary-tint` | `#E4F7F4` | Selected rows and success surfaces |
| `--focus-ring` | `#05AD98` | Keyboard focus indicator |

Rules:

- Normal text must never use `#878787` or `#BBBFBF` on white.
- Primary filled controls use `#05AD98` with `--primary-on`.
- Teal is limited to approximately ten percent of the visible interface.
- No gradients, glass effects, decorative blobs, or color-only status meaning.
- Critical and warning states use strong ink, explicit labels, leading icons,
  and distinct neutral surfaces rather than introducing red or amber.
- All final combinations must pass WCAG 2.2 AA contrast checks.

### 6.2 Typography

Use a fast, locale-friendly system sans stack:

```css
font-family:
	"Segoe UI Variable",
	"Segoe UI",
	"Noto Sans",
	system-ui,
	sans-serif;
```

Use a fixed product type scale:

| Role | Size | Weight | Line height |
|---|---:|---:|---:|
| Caption | `0.75rem` | 500 | 1.4 |
| Metadata and compact labels | `0.875rem` | 500 | 1.4 |
| Body and controls | `1rem` | 400 or 600 | 1.5 |
| Section heading | `1.125rem` | 600 | 1.35 |
| Page title | `1.5rem` | 700 | 1.25 |

Use tabular numerals for metrics, timestamps, confidence values, and pagination.
Do not use fluid font sizes, display fonts, negative letter spacing, or all-caps
body copy.

### 6.3 Spacing, Shape, And Elevation

- Use a 4px spacing scale: 4, 8, 12, 16, 24, 32, 48, and 64px.
- Use 8 to 12px within related control groups.
- Use 24 to 32px between sections in product views.
- Use radii of 4px for compact controls, 6px for inputs and buttons, and 8px
  for framed review items and dialogs.
- Cards never exceed an 8px radius and are used only for independent,
  actionable items.
- Do not nest cards.
- Use borders for normal separation. Shadows are reserved for menus, drawers,
  dialogs, and sticky mobile controls.

### 6.4 Motion

- Button and focus feedback: 120 to 150ms.
- Selection, tab, and status changes: 180 to 200ms.
- Drawer and dialog transitions: no more than 250ms.
- Use ease-out quart or quint curves.
- Animate transform and opacity for overlays; avoid layout-property animation.
- Provide instant or crossfade alternatives under `prefers-reduced-motion`.
- Do not add page-load sequences or decorative motion.

## 7. Information Architecture

### Shared

- `/login`: unified sign-in.
- `POST /api/auth/logout`: clear the session and return to login.
- Desktop shell: persistent left navigation, top account bar, and main content.
- Tablet shell: collapsible navigation drawer.
- Pump mobile shell: compact header with a sticky bottom primary action.

### Pump

- `/pump`: session status, group-photo capture, processing, result, and retry.

### Vendor

- `/vendor`: overview and attendance summary.
- `/vendor/attendance`: attendance calendar and filtered records.
- `/vendor/pumps`: assigned pump directory and pump performance.
- `/vendor/people`: anonymous person directory and attendance history.

### Admin

- `/admin`: overview, now with an `Insights` nav entry alongside the existing links.
- `/admin/insights`: operational health — trend deltas, pumps needing attention,
  vendor/area rollups ranked against a 30-day baseline, and a data-quality backlog
  trend. Built 2026-07-27 as part of the Attendance Insights Overhaul; needs the
  same visual system as every other admin screen, not a bespoke look.
- `/admin/attendance`: attendance records and export. Now has two render modes —
  a single selected day renders a collapsible Area → Vendor → Pump grouped summary
  (expandable to per-person rows); a multi-day range renders the flat, paginated,
  sortable table. Both modes already filter by Area/Vendor/Pump (ID-based selects)
  and a day picker, and link Pump/Vendor/Area/Person cells to the drill-down pages
  below.
- `/admin/pumps/[id]`: pump drill-down — header, an attendance calendar grid
  (person × day), a session log (including expired-unpaired-morning rejections),
  and a worker roster with yearly present/morning-only/evening-only counts.
- `/admin/vendors/[id]`: vendor drill-down — pump list with attendance % over a
  date range, and a calendar grid columned by pump.
- `/admin/areas/[id]`: area drill-down — same pattern, columned by plant.
- `/admin/persons/[id]`: one person's full attendance history and yearly rollup.
- `/admin/fraud-flags`: cross-pump fraud review.
- `/admin/flagged-guests`: unknown-face review.
- `/admin/merge-candidates`: same-pump duplicate-person review.
- `/admin/import`: CSV structure import.

## 8. Shared Components

Create reusable Svelte components with typed props and slots:

- `AppShell`, `SideNav`, `TopBar`, `MobileHeader`, and `PageHeader`.
- `Button`, `IconButton`, `TextField`, `SelectField`, and `DateRangeField`.
- `MetricStrip`, `StatusBadge`, `ProgressSteps`, and `InlineAlert`.
- `DataTable`, `Pagination`, `FilterBar`, and `EmptyState`.
- `Skeleton`, `ToastRegion`, `Dialog`, and `DetailDrawer`.
- `UploadZone`, `PhotoPreview`, `FaceThumbnail`, and `FaceResultList`.
- `ReviewEvidence`, `ReviewActions`, and `ComparisonPanel`.
- Restyle, don't reinvent, the three data-viz primitives already built and
  functionally verified in `src/lib/components/` and `src/lib/sparkline.ts`:
  `AttendanceCalendarGrid.svelte` (day × entity grid, status or percent mode) and
  `DateRangePicker.svelte` (range + presets, single-day as a special case) should
  become the design system's canonical trend/grid and date-range controls rather
  than being replaced by new ones; `sparklinePath()` remains the only charting
  mechanism — still no charting library dependency.

Add `lucide-svelte` as the only icon library. Every unfamiliar icon-only button
requires an accessible label and tooltip.

Component state coverage:

- Default, hover, focus-visible, active, disabled, and loading.
- Form validation, server error, and success.
- Empty and long-content states.
- Pointer and touch input behavior.

## 9. Screen Specifications

### 9.1 Login

- Place a compact Face Attendance identity above a single sign-in form.
- Keep email and password labels visible.
- Add a password show/hide icon with an accessible name.
- Use `Sign in` as the primary action.
- Disable the action and show inline progress during authentication.
- Show a plain-language error connected to the form through `aria-describedby`.
- Do not add role selection, marketing copy, or decorative imagery.

### 9.2 Pump Capture

Page order:

1. Pump code, plant, area, and current session.
2. Morning/evening session progress and next allowed submission time.
3. Group-photo capture area with camera and gallery actions.
4. Selected image preview and replace-photo action.
5. Upload and processing progress.
6. Face-processing result and next step.

Requirements:

- Primary label is `Take group photo`, never `Capture face`.
- The capture action remains reachable in the phone thumb zone.
- Use a sticky bottom action on narrow screens with safe-area padding.
- Preserve the selected image after a temporary network failure.
- Polling interruptions retry automatically with bounded backoff.
- Do not show a fake percentage when the backend cannot provide one.
- The nine-hour rule shows the exact next permitted IST time.
- Duplicate-photo, stale-session, and early-evening errors explain how to
  continue.

Result groups:

- Matched people.
- Newly discovered people.
- Faces awaiting guest review.
- Faces withheld for fraud review.

Each group shows a count, crop thumbnails when available, and the
`personDisplayLabel` (e.g. `BGLPRVN1 Worker 3`) already returned by
`api/attendance/status/[id]` for matched and newly discovered people — this
replaced raw `person_id.slice(0,8)` rendering during the Attendance Insights
Overhaul and must not be reverted. A fraud result tells the operator that
attendance was withheld for admin review without accusing a named person.

### 9.3 Vendor

Overview:

- Compact metrics for attendance rate, active pumps, known people, and
  incomplete sessions.
- Thirty-day attendance trend in teal and gray.
- Pump activity list ordered by attention needed.
- Direct links to attendance, pumps, and people.

Attendance:

- Calendar summary with complete, partial, and missing-session labels.
- Filters for pump, plant, area, and date range.
- Responsive records with morning/evening status.

Pumps:

- Pump code, plant, area, latest submission, session state, and attendance rate.
- No create, edit, or delete controls.

People:

- Face crop when available, `personDisplayLabel`, pump, first seen, last seen,
  days present, and partial-day counts (already surfaced via
  `person_attendance_yearly`'s `days_present`/`days_morning_only`/
  `days_evening_only` on the vendor persons table and the admin person page).
- No manual enrollment or cross-pump merge actions.

### 9.4 Admin Overview

- Use a horizontal metric strip instead of six identical cards.
- Show attendance percentage, active pumps, persons, fraud flags, pending guest
  reviews, pending merge reviews, and average elapsed hours.
- Add a seven-day attendance trend using semantic SVG and an accessible data
  table fallback.
- Add an urgent review queue ordered by fraud, guest, then merge work.
- Show recent attendance activity below the overview.
- Link prominently to `/admin/insights` (already built) rather than duplicating
  its content inline — the overview should stay a fast at-a-glance summary and
  route the admin to Insights for trend deltas, the "pumps needing attention"
  list, and vendor/area rollups.

### 9.4a Insights (`/admin/insights`)

Redesign the existing, functionally-complete page — this is a visual/interaction
pass, not new backend work:

- **Today at a glance**: three metric cards (attendance %, fraud flags, active
  pumps), each with a "vs yesterday" and "vs 7-day avg" delta. Deltas must be
  legible without relying on color alone (use `+`/`−` and an icon, not red/green
  only, per §6.1's critical-state rule).
- **Pumps needing attention**: a ranked list, each row linking to
  `/admin/pumps/[id]`, showing its combined reasons (silent pump, expired-unpaired
  morning, or a >15pp 7-day attendance drop) as plain-language text, not codes.
- **Vendor rollup** and **Area rollup**: tables with pump count, distinct persons,
  today's %, 30-day baseline, delta vs baseline (sorted worst-first), an
  area-median comparison column (vendor rollup only), fraud rate, and a 7-day
  inline sparkline. Needs the shared `DataTable` treatment plus the restyled
  `AttendanceCalendarGrid`/sparkline components, not a bespoke table.
- **Data-quality backlog**: pending flagged-guest count plus a 7-day sparkline.

### 9.5 Attendance Records

Restyle the existing, functionally-complete implementation rather than
redesigning its data behavior from scratch:

- Area/Vendor/Pump are already ID-based `<select>` controls populated from real
  options (no more name-string matching), and a Day picker already overrides the
  from/to range for single-date lookups — filters already live in URL query
  parameters (`area`, `vendor`, `pump`, `day`, `from`, `to`, `page`, `sort`, `dir`).
- Selecting a single day already switches the page into a collapsible
  Area → Vendor → Pump grouped summary (counts per pump, expandable to
  per-person rows); a multi-day range already renders the flat table. The
  redesign must preserve this two-mode behavior — it is real, tested product
  logic, not a mock to discard.
- Pagination (50 rows/page, prev/next, total count) and click-to-sort
  (whitelisted columns only: `session_date`, `pump_code`, `vendor_name`,
  `area_name`, `status`) are already implemented on the flat-table mode.
- Result count, clear-filters, and XLSX export already exist; the export already
  applies the same ID-based + day filters and uses `personDisplayLabel` plus a
  real Excel date cell (`numFmt`). Still needed: page-size control, and adding
  `plant` and `session type` as additional filter dimensions (not yet supported
  by the backend — see §10).
- Pump/Vendor/Area/Person cells already link to their respective drill-down
  pages (§9.5a) — carry these links into the redesigned table rather than
  reverting to plain text.
- Desktop uses a compact table with a sticky header.
- Narrow screens use stacked records with a row-detail disclosure.
- Do not truncate identifiers or names without a tooltip or detail view.

### 9.5a Pump, Vendor, Area, and Person Drill-Downs

New since the Attendance Insights Overhaul — needs the shared design system, not
new backend work:

- `/admin/pumps/[id]`: header (pump/plant/area/vendor), an
  `AttendanceCalendarGrid` (person × day, status mode) over a `DateRangePicker`
  range, a 30-day attendance sparkline, a rejection-history note (expired-unpaired
  mornings only — 9-hour-rule and duplicate-photo rejections are not persisted
  and must not be shown as if they were queryable history), a session log table,
  and a worker roster linking to `/admin/persons/[id]`.
- `/admin/vendors/[id]`: pump list with attendance % over a range (sortable), and
  an `AttendanceCalendarGrid` in percent mode columned by pump.
- `/admin/areas/[id]`: same pattern, columned by plant.
- `/admin/persons/[id]`: full attendance history and yearly rollup for one
  person, with a link back to their pump.

### 9.6 Fraud Review

- List unreviewed items first.
- Detail evidence includes both pumps and plants, timestamps, source session
  images, face crops where available, anonymous person ID, and similarity.
- Keep evidence and `Mark reviewed` visible together in a detail drawer.
- Confirm completion with a toast and remove the item from the active queue.

### 9.7 Guest Review

- Use one face-focused review item per guest because the image is the primary
  evidence.
- Show source pump, plant, session date, session type, and created time.
- Actions are `Create person` and `Dismiss guest`.
- The source pump is fixed and clearly stated.
- Show a useful empty state when all guests are reviewed.

### 9.8 Merge Review

- Show two face crops side by side.
- Include both `personDisplayLabel`s, pump, similarity, first/last seen, and
  attendance summaries.
- Actions are `Merge people` and `Dismiss suggestion`.
- Explain that merging keeps the selected primary ID and combines history.
- Persist dismissals so rejected pairs do not immediately reappear.
- Never allow a cross-pump merge.

### 9.9 CSV Import

- Add a drag-and-drop zone with a normal file-picker fallback.
- Provide a downloadable CSV template.
- Validate the required headers before upload.
- Show filename, size, and replace-file action.
- Present created, updated, skipped, and error totals in distinct rows.
- Display row errors in a searchable or scrollable table.
- Explain that importing the same valid file is safe and does not duplicate
  pumps.

## 10. Data And Interface Changes

### Attendance status

Extend `GET /api/attendance/today` additively with:

- Pump code, plant, and area display context.
- Current session state.
- `next_allowed_at`.
- Pairing expiry.
- Latest session ID, type, and status.

Extend `GET /api/attendance/status/:id` additively with:

- Submission and completion timestamps.
- Original photo URL.
- Crop URLs for matched and newly discovered people.
- Unknown faces for the current session.
- Fraud context with the other pump code and plant.

Already implemented: `matched` and `new_persons` are joined with `pump_code` and
`display_seq` so the client can render `personDisplayLabel` directly (added
during the Attendance Insights Overhaul) — build the remaining fields listed
above on top of this, don't replace it.

Embeddings must never be returned.

### Attendance filtering

Already implemented on `admin/attendance` and its export endpoint: `area`,
`vendor`, `pump`, `day` (single-date override), `from`/`to` (range), `page`
(50 rows/page, fixed size), and whitelisted `sort`/`dir`. Still to add,
additively, without breaking the existing contract:

- `plant`
- `session` (morning/evening)
- `status` (present/absent)
- `page_size` (currently fixed at 50)

The export endpoint must continue to apply the same filter contract as the page.

### Merge decisions

Add a normalized merge-review decision table containing:

- Lower and higher person IDs as a unique pair.
- Decision: `dismissed` or `merged`.
- Reviewing admin.
- Similarity score.
- Review timestamp.

Candidate queries exclude dismissed or completed pairs.

### Logout

Add `POST /api/auth/logout`, clear the HTTP-only session cookie, and redirect to
`/login`.

## 11. Responsive Behavior

- Start with mobile styles and add complexity at content-driven breakpoints.
- Validate 320px, 390px, 640px, 768px, 1024px, 1440px, and wide desktop.
- Pump capture remains single-column at every width.
- Admin/vendor navigation becomes a drawer below the desktop shell breakpoint.
- Use 48px field touch targets and at least 44px elsewhere.
- Account for phone notches and home indicators with safe-area environment
  values.
- Do not rely on hover for any action.
- Prevent horizontal page overflow; only intentional table scrollers may scroll.
- Verify phone portrait and landscape layouts.

## 12. Accessibility And Privacy

- Target WCAG 2.2 AA.
- Use semantic landmarks, headings, labels, tables, buttons, and links.
- Include a skip link and consistent visible focus indicators.
- Announce upload, processing, success, and failure states through live regions.
- Use icons and text alongside color for every status.
- Keep body text at or above 1rem and preserve browser zoom.
- Ensure the UI reflows at 200 percent zoom.
- Provide meaningful alt text for evidence images and empty alt text for
  decoration.
- Restrict face crops to authorized role views.
- Never expose embeddings, internal vector values, or unnecessary personal data.

## 13. Resilience And Performance

- Do not add a general UI framework or runtime-heavy animation library.
- Lazy-load face crops outside the initial viewport.
- Use image dimensions or aspect ratios to prevent layout shift.
- Keep the pump route free from dashboard chart code.
- Retain the selected photo until the server accepts it.
- Continue status polling after recoverable network errors.
- Stop polling and offer a specific retry action after the bounded timeout.
- Use skeletons for dashboard data and inline progress for field submissions.
- Avoid claiming precise progress or completion time without backend evidence.

## 14. Implementation Sequence

### Phase 1: Foundation

- Create `PRODUCT.md` and `DESIGN.md`.
- Add global tokens, reset, typography, icon library, and shared primitives.
- Build the responsive application shell and logout flow.

### Phase 2: Authentication

- Redesign login and all authentication states.
- Preserve the unified role-detection behavior.

### Phase 3: Pump Workflow

- Build session context, photo capture, preview, progress, result, and retry.
- Extend attendance status responses.
- Validate the complete flow on an actual phone viewport before continuing.

### Phase 4: Admin Operations

- Build overview, metric strip, trend, and filters.
- Restyle the already-implemented attendance table (two-mode day-summary/flat
  view, ID-based filters, pagination, sorting, export) and the already-built
  `/admin/insights`, `/admin/pumps/[id]`, `/admin/vendors/[id]`,
  `/admin/areas/[id]`, and `/admin/persons/[id]` drill-down pages — this is a
  visual/interaction pass onto real, tested data flows, not new page
  construction from a blank slate.
- Redesign fraud, guest, merge, and CSV import workflows.
- Add persistent merge decisions.
- Add the still-missing `plant`/`session`/`status`/`page_size` filter dimensions
  called out in §10.

### Phase 5: Vendor Views

- Build overview, attendance, pumps, and people routes.
- Add vendor-scoped aggregates and filters.

### Phase 6: Hardening

- Add empty, loading, error, offline, long-content, and permission states.
- Complete responsive, keyboard, screen-reader, and reduced-motion behavior.

### Phase 7: Visual QA

- Capture and inspect every primary route at phone, tablet, and desktop sizes.
- Compare against the approved Guided Workforce direction.
- Fix hierarchy, overflow, density, contrast, and interaction defects.

## 15. Test Plan

### Pump

- Morning ready, waiting for evening, evening ready, and day complete.
- Early evening blocked with exact next allowed time.
- Uploading, queued, processing, completed, and failed.
- Matched, new, guest, and fraud result groups.
- Duplicate photo, slow response, timeout, offline, reconnect, and retry.

### Admin

- Metrics and review counts with zero and non-zero data.
- Seven-day chart with accessible tabular fallback.
- Every attendance filter independently and in combination.
- Pagination and filter-preserving export.
- Fraud review completion.
- Guest creation and dismissal.
- Merge confirmation and persistent dismissal.
- Valid import, invalid headers, row errors, and safe re-import.

### Vendor

- Vendor sees only assigned pumps and people.
- Overview metrics and trends.
- Attendance calendar and filters.
- Empty vendor, long pump names, and large person lists.
- No creation or enrollment controls.

### Accessibility And Visual Regression

- Add `@axe-core/playwright` checks for primary routes.
- Test keyboard-only navigation and focus order.
- Test 200 percent zoom and reduced motion.
- Add Playwright snapshots at 390x844, 768x1024, and 1440x900.
- Test long labels, 500-row results, and narrow-screen overflow.

### Verification Commands

```text
npm run check
npm run build
npm run test:e2e
```

## 16. Acceptance Criteria

- Every current role surface uses the shared design system.
- The primary pump action is visible without scrolling at 390x844.
- A temporary network interruption does not require recapturing the photo.
- No page has unintended horizontal overflow from 320px through wide desktop.
- Every asynchronous action has loading, success, and recoverable error feedback.
- Admin review screens show enough evidence to make the available decision.
- Vendor screens never expose pumps or people outside the authenticated scope.
- Status is understandable without relying on color.
- Text and controls meet WCAG 2.2 AA contrast and target-size requirements.
- Existing attendance, identity, fraud, and queue business rules remain unchanged.
- Raw embeddings never appear in frontend responses or rendered content.
- `npm run check`, `npm run build`, and the complete E2E suite pass.

## 17. Explicit Non-Goals

- Dark mode.
- Marketing or landing-page content.
- Manual person enrollment or naming.
- Cross-pump person merging.
- Replacing the Postgres job queue or worker architecture.
- Changing face-match thresholds or fraud scope.
- Displaying raw embeddings to any role.
- Adding decorative illustration, stock photography, or presentation-only
  animations.
