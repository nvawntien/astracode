---
change: baseline-judging
round: 1
max_rounds: 3
reviewed_commit: f336dc0cb2590b66d9270e60bfc408cc09ed317f
status: approved
---

## Round 1 findings

| # | Severity | Location | Problem | Expected |
|---|---|---|---|---|
| 1.1 | minor | proposal.md: "Findings" (relates to specs/judging/spec.md: "J01 Ordered and bounded job consumption") | The concurrency override is read only from the `WORKER_POOL_SIZE` environment variable (`workers/judge/internal/adapter/inbound/kafka/judge_job_consumer.go:49`). The worker's own `judging.max_concurrent_jobs: 4` (`workers/judge/config/config.yaml:28`) is referenced by no Go code, and the checked-in deployments set the override to `1` (`docker-compose.yml:331`, `docker-compose.prod.yml:102`), so the deployed limit is one rather than the default four. J01 is truthful as written ("a configured positive integer override"), but this is the same class of discrepancy already recorded as proposal Finding 5 (DLT destination). | Add a sixth entry to proposal.md "Findings" recording that `judging.max_concurrent_jobs` is inert and that the checked-in deployment override is `1`. No requirement change needed. |
| 1.2 | minor | specs/judging/spec.md: "J19 Correlated and restricted official results" | The published result-level public error message for a failing testcase is derived from the program's standard error: `go_judge_client.go:159` calls `errorMessageForTestCase`, which for `RUNTIME_ERROR` calls `runtimeErrorMessage` (`diagnostics.go:149-157`) over the testcase's sanitized stderr, truncated by `publicErrorMessage` (`diagnostics.go:160-176`), and the publisher forwards it as `ErrorMessage` (`kafka_result_publisher.go:53`). J19's exclusion list is explicitly scoped "as per-testcase data", so the requirement is not false, but this publish-path behaviour is recorded nowhere in the spec. | Add a sentence or scenario to J19 stating that a failing testcase contributes a sanitized, length-bounded public error message derived from its standard error, distinct from the per-testcase data allowlist. |
| 1.3 | minor | proposal.md: "Open questions" → "Sandbox guarantees beyond submitted limits" | The filesystem part of this question is partly answered by checked-in configuration: `docker-compose.yml:200-213` sets `ES_SRC_PREFIX=/cache/testcases`, mounts `testcase_cache:/cache/testcases:ro`, binds the executor to loopback on the `judge_internal` network, runs it `privileged: true`, and caps it at 2 CPUs / 2048 MiB. The worker-side comment at `go_judge_client.go:368-370` relies on that `ES_SRC_PREFIX` check. | Narrow the open question to what the repository genuinely does not establish (executor-internal syscall and network enforcement at runtime), and cite the checked-in sandbox configuration above as the part that is answered. Deferral remains correct; no requirement should assert runtime isolation. |
| 1.4 | minor | proposal.md: "Open questions" → "Dead-letter recovery" | Confirmed repository-wide, not only for the inspected worker: no component consumes or replays the DLT. `judge.submission.jobs.dlt` is only created (`infra/kafka/kafka-init.sh:33`) and written (`workers/judge/internal/adapter/inbound/kafka/dlt_publisher.go`, `services/submission/internal/adapter/inbound/kafka/dlt_publisher.go`); there is no DLT consumer anywhere. | Record the confirmed answer — nothing in this repository replays retained DLT jobs — so the question becomes a known operational gap rather than an unresolved one. The baseline correctly covers retention and acknowledgement only. |

Open question 3 ("Operational language versions") is correctly deferred: `build/sandbox/Dockerfile:4-11` installs `g++` and `python3` unpinned, so the repository does not establish those versions. Only the base image digest, Java 17 and Go 1.22.1 are pinned, which is exactly what J07 and design.md Decision 2 claim.

## Round 1 review coverage

- `openspec validate baseline-judging --strict` → `Change 'baseline-judging' is valid` (exit 0).
- All 24 requirements (J01–J24) have exactly one Evidence row; every cited path, function and corroborating test name resolves in the tree (24/24 rows, 22/22 cited tests).
- Each requirement and all 55 scenarios were checked against the cited implementation branches. Confirmed in code, among others: the shared four-slot default and per-claim sequential handling (J01); zero-limit retryable vs. unrepresentable non-retryable split in `ValidateOfficialExecutionLimits`/`ValidExecutionLimits` ordered before package load (J03); 64 MiB compressed / 128 MiB declared-uncompressed bounds, directory-skip-then-symlink/traversal checks, and non-retryable extraction vs. retryable download (J05); `^0*([1-9][0-9]*)\.(in|out)$` pairing, numeric ordering, normalized IDs and 1-based indices (J06); exact uppercase language keys with `-O3 -std=c++17` and interpreted Python (J07); `max(30s, limit)` / `max(512 MiB, limit)`, doubled wall time, 500 procs, stderr→stdout→executor-error precedence (J08); 50 procs and the 120 s job-bounded RPC timeout (J09); `max(1 MiB, largest expected + 64 KiB)` on independent stdout/stderr collectors (J10); normalization semantics (J11); full status→Verdict table including `InternalError`/default → SYSTEM_ERROR as a completed outcome (J12); batch-of-four, first-failure prefix retention, and maxima-not-sums aggregation (J13); all five incomplete-response paths (J14); the 3 MiB inline budget with lexical + `EvalSymlinks` containment and the single-oversized-input ordering (J15); default-disabled cache, five-part key identity, `singleflight` coalescing, failure/denial falling back rather than erroring, and the single verified stale-input retry (J16); admission with reservations and unknown-size blocking, owned-name-only reconciliation, pin protection and retained accounting on delete failure (J17); submission-scoped executable reuse with an independent 500 ms deferred deletion (J18); the per-testcase publish allowlist in `KafkaResultPublisher.PublishResult` and zero-metric omission (J19); non-retryable → SYSTEM_ERROR publish with generic public message plus separate processing description (J20); three tries with 500 ms / 1 s waits only (J21); undecodable payload → DLT with count zero and no completeness check (J22); DLT provenance with JSON embedding or base64 marker and original key (J23); acknowledge-only-after-successful-DLT-publication, partition hold on DLT failure, and all four cancellation points (J24).
- Boundaries: no requirement strays into `code-run` (the 50-command generic batch path is deliberately unspecified) or `submission` (only publication is specified, not result application). The core data-exposure rule is specified, not omitted (J19).
- spec.md form: behaviour only — no endpoints, table names, class names or file paths. `Sandbox`, `Verdict`, `Attempt`, `Submission`, `Testcase package`, `Standard mode` and `DLT` all match `docs/process/glossary.md`.
- All five recorded proposal Findings were re-checked against the code and are accurate, including the compile-status conflation, the ZIP-only checksum scope, the unsynchronized cache promotion, unrejected duplicate identities, and the empty-config DLT destination divergence.
- The reviewed commit touches only `openspec/changes/baseline-judging/`.
- Not run: Go tests, `scripts/verify.sh`, live broker or real Sandbox, consistent with the author's recorded limitations. Cited tests were confirmed to exist by name, not executed.

## Round 1 author response

No response required: the review is `approved` and no finding is blocking. Findings 1.1–1.4 are recorded for the human Gate 1 reviewer; 1.1 and 1.2 are optional artifact improvements, 1.3 and 1.4 are answers to deferred open questions.

| # | Action | Note |
|---|---|---|
| 1.1 | | |
| 1.2 | | |
| 1.3 | | |
| 1.4 | | |
