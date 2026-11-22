# ADR-0003: The worker testcase cache publishes immutable generations behind an atomic reference

- **Status:** Accepted (instructed by the project owner on 2026-11-22; the reviewer confirms this when the PR merges, per workflow §10)
- **Decision date:** 2026-11-21, design approval for `remove-contributor-role`
- **Scope:** `workers/judge` official testcase loader; the `testcase_cache` volume shared read-only with the go-judge executor

## Context

The Judge Worker caches official testcase bundles on a volume that the go-judge executor reads. A running job must keep reading the bundle it started with, even while another fill or a repair of a corrupt entry runs. The earlier loader deleted and renamed a per-problem directory in place, which could remove files a running job still used.

## Options

The approved design records the chosen approach. The alternatives below are the ones it rules out by its wording; they were not argued in a separate record.

- **A. Generation directories behind an atomically replaced reference (chosen).** Each fill is staged in a unique directory and validated. Publishing replaces a `.current` reference atomically on the same filesystem.
- **B. Replace the directory in place (ruled out).** Active jobs can lose files mid-run.
- **C. Cross-process lock around cache fills (not chosen).** The design does not use one. The cache is written by one worker container in the current Compose topology. `docs/codebase/TECH_DEBT.md` records the open question for multiple replicas.

## Decision

- Cache identity is the Problem ID and a SHA-256 digest of the storage origin and object path, without the signature query and fragment. A fresh signature for the same object reuses the entry. A new object gets its own entry.
- Each fill writes `generation-*` under that entry, validates the version, checksum and extracted testcases, then publishes by writing a temporary `.current` file and renaming it over the reference.
- A load resolves `.current` once and returns input paths inside that generation. Active jobs keep their paths.
- A failed fill removes only its private staging directory.
- Old generations, including legacy `problem_<id>` directories, are reclaimed only after every worker and executor that shares the volume is drained.
- The executor validates that a testcase path resolves inside `/cache/testcases`. This check covers the deeper generation paths.

## Trade-offs

- Disk use grows until the manual reclamation step runs.
- Correctness depends on an atomic rename within one filesystem. Moving the cache to another filesystem breaks the decision.
- Concurrent fills from several worker replicas are not covered by a lock. Scaling out needs a new decision.

## Consequences

- `TestOfficialLoaderConcurrentRepairPreservesActiveGeneration` and `TestOfficialLoaderSeparatesObjectsWithReusedVersion` cover the decision in `workers/judge`.
- `docs/codebase/CONCURRENCY.md` and `docs/codebase/TECH_DEBT.md` record the reclamation and replica open items.

## Links

- `openspec/changes/remove-contributor-role/design.md`, "Worker official testcase cache"
- ADR-0002 for the immutable object keys that give each cache identity a stable meaning
