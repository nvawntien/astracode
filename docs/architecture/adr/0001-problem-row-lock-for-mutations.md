# ADR-0001: Serialize Problem and testcase mutations with a Problem row lock

- **Status:** Accepted (instructed by the project owner on 2026-11-22; the reviewer confirms this when the PR merges, per workflow §10)
- **Decision date:** 2026-11-21, design approval for `remove-contributor-role`
- **Scope:** `services/problem` persistence and use cases; testcase metadata in `test_cases`

## Context

Problem edit, soft delete, publish, hide and testcase package mutations first check authorization and visibility, then write. Without serialization, a stale check can authorize a write. Examples: a User edits a problem just after a moderator publishes it, or a User deletes a package while a publication commits. The `remove-contributor-role` change allows Users to mutate their own hidden drafts, so these races now matter for a wider group of actors.

## Options

The approved design records the chosen approach. The alternatives below are the ones it rules out by its wording; they were not argued in a separate record.

- **A. Row lock in one transaction (chosen).** `SELECT … FOR UPDATE` on the undeleted Problem row, at PostgreSQL READ COMMITTED, with the state read, permission checks and writes in the same transaction.
- **B. Optimistic version column (ruled out by design).** Requires a schema change and retry handling in every caller.
- **C. SERIALIZABLE isolation (ruled out by design).** Requires retry on serialization failure in every caller.

## Decision

Use option A through `ProblemRepository.WithLockedProblem`:

- Edit, soft delete, publish, hide and testcase metadata mutations take the same row lock before their state and permission checks.
- The locked read, related Problem and tag reads, the Problem update, tag synchronization and testcase metadata reads and writes all use the transaction handle.
- ZIP validation, MinIO transfers and cleanup, and canonical-metadata cache invalidation run outside the transaction. Cache invalidation runs after a successful commit.
- A commit that cannot be confirmed is reported as `outbound.ErrMutationCommitUncertain`, so callers keep possibly referenced objects.

## Trade-offs

- Mutations on the same Problem run one at a time. The lock is held only for database work.
- Each new Problem or testcase write path must use `WithLockedProblem`. A path that skips it is not covered by this decision.

## Consequences

- The ordering guarantees are tested against a disposable PostgreSQL 15.6 fixture: `TestProblemMutationPostgresConcurrency` (6 cases) and `TestTestcaseMutationPostgresConcurrency` (13 cases). CI runs them in the `postgres-integration` job.
- ADR-0002 depends on this decision for the deletion and reconciliation order.

## Links

- `openspec/changes/remove-contributor-role/design.md`, "Concurrent Problem and testcase mutations / PostgreSQL transaction scope"
- `openspec/changes/remove-contributor-role/specs/content-moderation/spec.md`: CM-05, CM-14, CM-15, CM-20
