## Why

The current judging implementation has no OpenSpec capability spec. Record its observed behaviour so later changes can distinguish existing guarantees, implementation limitations, and new requirements.

## What Changes

- Add a baseline delta for `judging`, with every requirement under ADDED Requirements and evidence traced to the current code.
- Cover official job consumption, testcase retrieval, supported languages, compilation and execution limits, verdict determination, retries, and dead-letter handling.
- Record findings and unconfirmed operational behaviour without changing the implementation.
- Keep all artifacts inside this change. This baseline introduces no runtime behaviour or interface changes; contract impact is **NON-BREAKING**.

## Capabilities

### New Capabilities

- `judging`: A new spec for existing official judging behaviour, rather than a new runtime capability.

### Modified Capabilities

None.

## Impact

- Documentation only: proposal, judging delta spec, implementation evidence, review tasks, and session progress.
- Read-only evidence sources: `workers/judge/`, `build/sandbox/`, the shared language configuration and limit validators used by the worker, and the requested codebase documents and glossary.
- Out of scope: `code-run`; `submission`.
- No code, dependencies, main specs, contracts, gateway routes, infrastructure, or production configuration change. No merge or archive is included.

## Findings

These are observations from code inspection, not fixes or new desired behaviour.

1. **Compilation failures conflate program and executor failures.** `GoJudgeClient.compile` in `workers/judge/internal/adapter/outbound/execute/go_judge_client.go` maps every returned non-Accepted compile status, including executor internal errors and resource failures, to `COMPILATION_ERROR`. Transport failures instead remain retryable errors. The spec preserves this distinction.
2. **The local package checksum does not validate extracted testcase contents.** `OfficialLoader.verifiedCachedChecksum` in `workers/judge/internal/adapter/outbound/testcase/official_loader.go` verifies the cached ZIP against a locally recorded hash; `bundleFromDir` subsequently reads extracted files without comparing their contents with that ZIP. This is neither an authoritative upstream digest nor complete extracted-content integrity verification.
3. **Concurrent package refresh has no per-problem synchronization.** `OfficialLoader.Load` removes an existing problem cache before renaming its prepared replacement. Concurrent refreshes or reads can race with that replacement. No uninterrupted or concurrency-safe cache replacement guarantee is specified.
4. **Duplicate testcase identities are not rejected.** `OfficialLoader.extractZip` flattens archive paths to basenames and can overwrite earlier entries; `loadFromDir` assigns paths into maps keyed by parsed numeric identifiers. Duplicate basenames or differently padded versions of one identifier can therefore replace data without an explicit ambiguity error.
5. **The empty-configuration DLT destination differs from the checked-in destination.** `NewDLTPublisher` in `workers/judge/internal/adapter/inbound/kafka/dlt_publisher.go` falls back to `judge.submission.dlt`, while `workers/judge/config/config.yaml` configures `judge.submission.jobs.dlt`. The spec describes the selected DLT without asserting one universal name.

## Open questions

- **Sandbox guarantees beyond submitted limits:** Which network, filesystem, syscall, and privilege restrictions does the pinned external executor actually enforce at runtime? The repository's sandbox build definition and worker requests establish installed tooling and requested limits, but do not establish these external runtime guarantees. Deferred; no such requirement is added.
- **Dead-letter recovery:** What operator or external component replays retained DLT jobs? No replay implementation was found in the inspected worker. Deferred; this baseline covers retention and acknowledgement only.
- **Operational language versions:** Which exact C++ compiler and Python versions are installed in a deployed sandbox? Their packages are not version-pinned in the build definition. Deferred; language support is specified, while exact versions are stated only where the repository pins them.
