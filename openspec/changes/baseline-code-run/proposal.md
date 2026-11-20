## Why

Custom run already exists, but there is no `code-run` capability spec. This baseline records the behaviour confirmed in the current code so future changes can distinguish existing behaviour from intended improvements.

## What Changes

- Add only ADDED requirements for custom run requests, input limits, synchronous execution, returned results, and separation from a Submission.
- Record one implementation-evidence row per requirement in `design.md`, including limitations and likely bugs without fixing them.
- Add review-only tasks and verification evidence in `progress.md`.
- Make no code, configuration, dependency, or runtime behaviour changes. Do not merge or archive this change.

## Capabilities

### New Capabilities

- `code-run`: Baseline of existing Custom run behaviour, including caller-provided sample/custom cases and diagnostics. New to the spec inventory; already implemented.

### Modified Capabilities

None.

## Impact

- Files changed exclusively under `openspec/changes/baseline-code-run/`.
- Read-only evidence comes from Judge Worker, Submission's custom-run coordination, and shared language/limit helpers. Source baseline: `728aef24cc0d6f624f79fd612265e904406d3d44`.
- Contract impact: **NON-BREAKING**; no interface or contract changes.
- Out of scope: `judging` (official judging). It is referenced by name only; this change adds no requirements for it.
- Documentation impact: this change's artifacts only; no changes to `docs/` or main specs.

## Findings

1. **Configured concurrency cap is unused.** `max_concurrent_requests: 16` is declared in Submission configuration and parsed by `pkg/config/config.go`, but is absent from `ProvideRunCodeLimits` and the custom-run call chain. The inspected path has no custom-run admission semaphore; this baseline promises no such cap.
2. **Compile settings do not control compilation.** Configured `compile_time_limit: 15s` and `compile_memory_limit_kb` are not forwarded. `GoJudgeClient.compile` instead requests at least 30 seconds of CPU time, twice that wall-clock time, and at least 512 MiB, enlarged by execution limits when greater. The enclosing custom-run timeout defaults to 30 seconds, so compilation can exhaust that deadline before cases run.
3. **Captured-output setting is not a separate hard maximum.** `MaxCapturedOutputBytes` only supplies a fallback when the default output limit is nonpositive. The executor sizes each stdout/stderr collector using the requested/default output budget, raised when necessary to the largest caller-supplied expected output plus 65,536 bytes. Worker `run_code` output settings are not consumed by its executor provider.
4. **The custom-run timeout starts after the Problem lookup.** The configured 30-second run deadline bounds the worker call, rather than the whole request including that lookup; the Problem client has its own timeout.

## Open questions

- Which effective limits and language toolchains are active in a running deployment? Code confirms normalization, checked-in defaults, and command construction, but not environment overrides or execution in a live Sandbox. No deployment guarantee is specified.
- Are the unused concurrency/output/compile settings intended to become enforced controls? Current code confirms their limited or absent effect, but cannot establish product intent. Any correction needs a separate change; it is not part of this baseline.
