---
change: baseline-code-run
round: 1
max_rounds: 3
reviewed_commit: 78cb7844a954aefc1f40dd6092260434621303f6
status: approved
---

## Round 1 findings

No blocking findings. All 19 requirements (R01–R19) have an Evidence row, and each requirement plus its scenarios were checked directly against the cited code:

- `openspec validate baseline-code-run --strict` → `Change 'baseline-code-run' is valid`.
- R01: `services/submission/internal/application/usecase/user/run_code.go:46-78` confirms identity/ProblemID checks and Problem resolution before execution; `services/submission/internal/adapter/outbound/problem/grpc_client.go:29-77` confirms actor identity/Role forwarding and error-before-execution.
- R02: `services/submission/internal/domain/entity/submission.go:17-24,109-116` confirms exact-match `ParseLanguage`/`IsExecutable` (no case/whitespace normalization) for `CPP, GO, JAVA, PYTHON`.
- R03–R07: `run_code.go:57-134` and `normalizeRunCodeLimits` (`run_code.go:136-165`) confirm byte-exact boundary checks (262,144 / 10 / 64×1024 defaults), trimmed id/kind validation, case-sensitive `sample`/`custom`, and nil-vs-empty expected-output handling.
- R08: `pkg/judge/limits.go:17-25` (`ProblemTimeLimitMS`) and `run_code.go:167-179` confirm the <50-seconds/≥50-legacy-ms threshold and default fallback; `workers/judge/internal/adapter/outbound/execute/go_judge_client.go:568-579` (`normalizeLimits`) confirms the second-layer nonpositive-limit replacement with 2,000 ms / 262,144 KiB described in the requirement's last sentence.
- R09: `run_code.go:80-90` creates the timeout after `problemReader.GetProblem` returns; `services/submission/internal/adapter/outbound/judge/grpc_runner.go:42-51` confirms `DeadlineExceeded`→timeout, else→unavailable mapping.
- R10–R12: `go_judge_client.go:194-254` (`compile`) confirms stderr>stdout>executor-error preference and the 30s/60s/512MiB/500-proc compile bounds; `go_judge_client.go:340-353,568-597` confirm per-testcase 2×CPU wall-clock, proc limit 50, and the expected-output+65,536-byte output headroom (verified against the 1,024/2,048/67,584-byte scenario).
- R13–R16: `go_judge_client.go:80-174` (no early stop when `StopOnFirstFailure=false`, which `workers/judge/internal/application/usecase/judge/run_code.go:35-41` always sets for runs) and `mapJudgeStatus`/`mapTestCaseResult` (`go_judge_client.go:478-562`) confirm status mapping, including nonzero-exit-with-matching-output → `runtime_error` taking precedence over the output comparison; `workers/judge/internal/domain/output.go` confirms the CRLF/trailing-whitespace normalization; `run_code.go:49-57` (worker use case) confirms `completed`/`compile_error`/`system_error` run-level mapping including the nil-result fallback.
- R17: `services/submission/internal/application/dto/submission.go:40-61` and the mapping chain (`go_judge_client.go:478-518` → worker `run_code.go:49-95` → `workers/judge/internal/adapter/inbound/grpc/handler/run_code.go` → `grpc_runner.go:53-74`) confirm every returned field, unit conversions, and empty-output-as-empty-string handling.
- R18: `workers/judge/internal/adapter/outbound/execute/diagnostics.go` confirms path sanitization, per-language compile/runtime regexes (Python excluded from compile diagnostics, consistent with it having no compile step), column-1 fallback, and that runtime diagnostics are appended to both the owning testcase and the run's combined `Diagnostics` (`run_code.go:63-75` in the worker use case).
- R19: `testcase_cache.go:54-66` (`newTestcaseCacheKey`) returns `ok=false` immediately when `identity == nil`, and the worker `RunCodeUseCase.Execute` never sets `TestcaseDataset`, confirming no Testcase package load; `NewRunCodeUseCase` (submission) depends only on `ProblemReader`, `JudgeRunner`, limits — no persistence/event ports — confirming no Submission/Attempt is created or updated.

Findings 1–4 in `proposal.md` were independently confirmed: `max_concurrent_requests` (`pkg/config/config.go:148`, `services/submission/config/config.yaml:71`) is parsed but absent from `ProvideRunCodeLimits`/the custom-run call chain; `compile_time_limit`/`compile_memory_limit_kb` (`pkg/config/config.go:152-153`) are likewise unreferenced by `GoJudgeClient.compile`, which instead computes its own minimums as described.

No boundary violations: all requirements describe custom-run-only behaviour; `judging` is referenced by name only, consistent with the out-of-scope entry for M0-16 in the boundary table. `openspec/changes/` and `openspec/specs/` are otherwise untouched by this worktree's commit. `spec.md` is behaviour-only — no endpoints, tables, class or file names found. Domain terms (`Custom run`, `Sandbox`, `Problem`, `Standard mode`, `User`, `Role`, `Submission`, `Attempt`) match `docs/process/glossary.md`.

Both proposal.md Open questions (effective deployment limits/toolchains; product intent for the unused concurrency/compile/output settings) are genuinely unanswerable from source and correctly left open — no requirement invents an answer.

No minor findings.

STATUS: approved
