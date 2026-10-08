# 50-Agent Attendance Concurrency Evaluation Plan

## Goal

Run the real attendance pipeline with 50 concurrent virtual pump agents and the reusable
`golden-small-groups-v1` dataset. The test measures biometric accuracy, API reliability, queue
behavior, persistence correctness, and speed without replacing the existing threshold dashboard.

This first profile contains two synchronized bursts:

1. 50 morning uploads released at the same instant.
2. After all morning jobs finish and evening becomes eligible, 50 evening uploads released at the
   same instant.

This is 100 real submissions with a peak concurrency of 50. Morning and evening are separate
because an evening match requires its morning gallery to exist first.

## Safety And Repeatability

- Run only against the local/test Docker stack, never production.
- Use 50 existing pumps selected deterministically by `pump_code`; do not create replacement pumps.
- Preflight fails before uploads unless 50 eligible pumps, the AI service, app, worker, database,
  dataset, and writable output directory are available.
- Record the selected pump IDs and original password hashes. Reset a password only when HTTP login
  is required, use a run-specific test password, and restore the original hash after the run.
- Write every created session, job, person, vector, attendance row, review item, fraud flag, and
  upload path to a run ledger. Cleanup uses only this ledger and verifies that unrelated rows did
  not change.
- Preserve failed-run evidence by default; cleanup is a separate explicit command.
- Use unique photo filenames and request markers while preserving image pixels used by the model.

## Scenario Preparation

1. Read all 50 cases and ground-truth files from `datasets/golden-small-groups-v1`.
2. Select 50 existing pumps that have no attendance for the test date.
3. Map one golden case to one pump. Fraud-pair cases are assigned to different pumps in the same
   Area; ordinary cases use pumps that avoid accidental cross-pump contamination.
4. Authenticate each agent through the real login endpoint and retain its own cookie jar.
5. Capture a baseline database checksum/count snapshot and the worker/container configuration.
6. Start structured request logging and sample queue depth every 250 ms.

## Concurrent Execution

### Wave 1: Morning

- Prepare all 50 multipart requests before release.
- Hold agents at a start barrier and release them together.
- Submit through `/api/attendance/submit`; no direct session or job insertion.
- Poll each accepted session to a terminal state while sampling queue depth and job states.
- Require the queue to drain before evening setup.

### Evening Eligibility

- Use a test-only database time adjustment on only the 50 run-owned morning sessions so the real
  waiting rule permits evening uploads without changing production policy.
- Verify every pump reports evening as available before starting Wave 2.

### Wave 2: Evening

- Repeat the same 50-agent barrier with the paired evening photos.
- Poll all sessions to completion and wait until queued and claimed job counts return to zero.
- Cross-check final people, face evidence, matching, fraud flags, and daily attendance against each
  case's ground truth.

## Logging

Every event is JSONL and includes:

`run_id`, `wave`, `agent_id`, `case_id`, `scenario`, `pump_id`, `pump_code`, `request_id`,
`session_id`, monotonic timestamp, HTTP status, queue state, worker attempt, and error code.

Capture these event types:

- barrier-ready and barrier-release
- request-start, upload-complete, response-received
- queued, claimed, processing, completed, failed, retry
- queue-depth sample (`queued`, `claimed`, `done`, `error`)
- status-poll and terminal-result
- persistence-audit and cleanup-audit
- matching decision with similarity score and threshold, but never raw embeddings in logs

Docker app, worker, AI, and Postgres logs are sliced by run start/end time and stored separately.

## Metrics

### Accuracy And Attendance

| Metric                            | Meaning                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| Detection precision / recall / F1 | Detected faces compared with labeled faces                   |
| Identity precision / recall / F1  | Correct morning-to-evening identity assignments              |
| False match rate                  | Different people incorrectly linked                          |
| False non-match rate              | Same person not linked                                       |
| False present / false absent      | Incorrect final attendance decisions                         |
| Attendance accuracy               | Correct worker attendance decisions / all expected decisions |
| Fraud precision / recall          | Correct known cross-pump duplicate decisions                 |
| Threshold sweep                   | All accuracy metrics for each configured threshold           |

### Reliability And Persistence

| Metric                               | Calculation                                         |
| ------------------------------------ | --------------------------------------------------- |
| Accepted rate                        | HTTP 202 / attempted requests                       |
| Success rate                         | completed sessions / accepted sessions              |
| Failure rate                         | failed sessions / accepted sessions                 |
| Conflict, 4xx, 5xx and timeout rates | count by response class / attempted requests        |
| Retry rate                           | jobs with attempts greater than one / accepted jobs |
| Duplicate/lost/orphan rate           | invalid persistence rows / accepted sessions        |
| Queue drain result                   | final queued + claimed jobs; must be zero           |

### Latency And Capacity

Report `min`, `mean`, `p50`, `p90`, `p95`, `p99`, and `max` for:

| Metric                 | Measurement                                                 |
| ---------------------- | ----------------------------------------------------------- |
| API acceptance latency | request start to HTTP response                              |
| Queue wait             | `attendance_jobs.created_at` to `claimed_at`                |
| AI/worker processing   | `claimed_at` to `attendance_sessions.processed_at`          |
| End-to-end latency     | request start to terminal status                            |
| Evening match latency  | evening request start to final attendance decision          |
| Queue depth            | sampled queued and claimed counts over time                 |
| Throughput             | terminal sessions per second and faces processed per second |
| Drain time             | barrier release until no queued/claimed jobs remain         |

Also report morning and evening separately, combined, and grouped by golden scenario. Queue timing
uses database timestamps; client duration uses a monotonic clock.

## Fast Deterministic Report

Write each run to:

`test-output/load-evaluations/<run-id>__50-agents__golden-small-groups-v1/`

Keep the top level small:

- `index.html` - lightweight report shell
- `summary.json` - overall metrics and run metadata
- `requests.csv` - one row per HTTP request
- `queue-jobs.csv` - one row per queue job with calculated timings
- `accuracy-by-threshold.csv` - threshold comparison table
- `events.jsonl` - complete correlated lifecycle log
- `assets/` - lazy-loaded charts, threshold chunks, thumbnails, and failure evidence
- `logs/` - run-bounded service logs

The report follows the existing optimized evaluation dashboard:

- render only summary cards and compact tables initially;
- load threshold details only after threshold selection;
- load request traces, charts, and image pairs only when their row/section is opened;
- use generated thumbnails in lists and load full images only on preview click;
- use deterministic static JSON/JS chunks with no runtime AI calls or recomputation;
- show failing/slow requests first and provide filters for wave, scenario, outcome, pump, status,
  threshold, retry count, and latency band.

The first screen contains success/failure rates, throughput, queue peak/drain time, API p95, queue
wait p95, processing p95, end-to-end p95, attendance accuracy, false matches, and false absences.

## Reusable Commands To Implement

```text
npm run eval:attendance:concurrency -- --scenario eval/scenarios/attendance-50-concurrent.json
npm run eval:attendance:concurrency:report -- --run <run-id>
npm run eval:attendance:concurrency:cleanup -- --run <run-id>
```

## Acceptance Criteria

- Exactly 50 requests begin in each barrier window, with recorded start skew.
- All 100 attempts have a correlated response and lifecycle trace.
- No unexpected HTTP 5xx, timeout, lost job, duplicate job, orphan upload, or stuck queue item.
- Final queue depth is zero and every accepted session is terminal.
- Persisted attendance and matching metrics reconcile with golden ground truth.
- Report values can be regenerated byte-for-byte from saved run data.
- Dashboard first view loads without decoding full-size images or loading every threshold chunk.

## Deliverables During Implementation

1. Extend the existing runner instead of creating a disconnected load framework.
2. Add barrier-based 50-agent execution, existing-pump mapping, login/reset/restore, run ledger,
   queue sampler, deterministic metrics, and cleanup.
3. Reuse the golden evaluator's threshold and image-review generation.
4. Add the optimized lazy HTML report and package commands.
5. Run the scenario, retain the report, append verified results to
   `plans/ImplementationSummary.md`, and document any defects found and fixed.

## Verified Execution

- Run: `20260904-144239__attendance-50-agents__golden-small-groups-v1`
- Load: 50 synchronized morning requests followed by 50 synchronized evening requests.
- Result: 100 accepted, 100 completed, 0 failed, 0 retries, and 0 conflicts.
- Peak queue: 50 queued and 4 claimed concurrently.
- API acceptance p95: 569.3 ms.
- Queue wait p95: 228,501 ms.
- Processing p95: 22,649 ms.
- End-to-end p95: 238,736 ms.
- Combined throughput: 0.202 completed sessions per second.
- Chromium verification confirmed the threshold selector, deferred 100-row trace, and on-demand
  morning/evening image loading.
- Infrastructure defect found and fixed: the AI service conflicted with another application on host
  port 8000 and was detached from the Compose network. This project now publishes AI on host port
  8001 while retaining `ai-service:8000` internally.

## Concurrency Matrix Execution

The same reusable workflow was run at 10, 20, 30, 40, and 50 synchronized requests per attendance
wave. Each level completed its morning and evening wave with 100% success and was then cleaned from
the database without deleting the real pump inventory or its static report.

| Agents per wave | Total requests | Queue p95 (min) | End-to-end p95 (min) | Drain (min) | Throughput (/sec) |
| --------------: | -------------: | --------------: | -------------------: | ----------: | ----------------: |
|              10 |             20 |           0.856 |                1.052 |       1.979 |             0.168 |
|              20 |             40 |           1.750 |                2.025 |       4.097 |             0.163 |
|              30 |             60 |           1.675 |                1.786 |       3.678 |             0.272 |
|              40 |             80 |           2.169 |                2.457 |       5.081 |             0.262 |
|              50 |            100 |           3.808 |                3.979 |       8.261 |             0.202 |

The comparison confirms that queue wait, rather than HTTP acceptance time, is the limiting factor.
