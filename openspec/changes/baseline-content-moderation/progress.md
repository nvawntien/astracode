# progress.md — baseline-content-moderation

## Verified state

- Review branch `feature/baseline-content-moderation` started clean at `1791a71`, with implementation from `728aef2`. `git ls-remote --heads origin` confirmed the incoming branch tip and M0-04 at `a248892`.
- `GOTOOLCHAIN=go1.25.8 QUICK=1 scripts/verify.sh` → PASS after the sandboxed run failed to open a loopback socket. Verification ran in a disposable checkout.
- `npm ci --no-audit --no-fund` → PASS in the disposable website checkout. `npm test -- tests/roles.test.ts` → PASS, 3 tests. `GOTOOLCHAIN=go1.25.8 scripts/verify.sh` → PASS with lockfile-pinned Next.js 15.5.29, including Go test/vet/race, website typecheck/build, Compose config, and all-change strict OpenSpec validation.
- `openspec validate baseline-content-moderation --strict` → PASS, `Change 'baseline-content-moderation' is valid` (CLI 1.13.0).
- `git diff --check` → PASS. `git diff --name-only` and the structural audit confirmed six scoped files, 21 ADDED requirements, 53 WHEN/THEN scenarios, 21 matching Evidence rows, and 35 existing evidence source paths.

## Last session

- Tasks 1.1–1.6 verified by the ownership and moderation traces in `review.md`. The full gate ran the Problem role/ownership, router policy, testcase access, metadata-redaction, and cache tests. The focused website role test covered role ordering and Contributor Workspace membership.
- Task 2.1 verified by the isolated PostgreSQL 15.6 probe: explicit false → HTTP 201, false entering GORM, true in the INSERT, false in the response, and true in both PostgreSQL and repository readback. The omitted flag returned and persisted true. See the probe scope and source trace in `review.md`.
- Tasks 2.2–2.3 verified by the structural audit, scoped diff, strict validation, and full repository gate above.
- Revised `spec.md`, `design.md`, `proposal.md`, `tasks.md`, `review.md`, and this file. The spec now preserves management UI, authoring mutations, and package behavior. Catalog reads and taxonomy remain covered by M0-04.

## Broken or unverified

- Proposal OQ-2 remains open for concurrent package replacement and partial-failure recovery. Payload integrity and deleted-slug reuse were reviewed from source. The PostgreSQL probe covered the tag create/read path with fixture claims.
- Existing website lint warnings and the confirmed inactive-tag defect do not block this documentation baseline.

## Next action

- The reviewed baseline is ready for merge review.
