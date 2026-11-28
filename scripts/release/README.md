# Exact-revision release delivery

Phase A defines these paths and exercises them offline. Keep `M013_PUBLICATION_ENABLED` and `M013_DELIVERY_ENABLED` disabled until the separately authorized transition and live verification. The manual startup and protected automated delivery model is recorded in Accepted ADR-0013. [Accepted ADR-0013](../../docs/architecture/adr/0013-staging-lifecycle-control-plane-and-identity.md)

`publish-canonical.yml` accepts protected `develop` pushes only. It calls the reviewed reusable publisher on protected `main`. Each exact source SHA runs the existing Go, database, frontend, gateway, Compose, deployment-script, benchmark and six image checks, plus strict OpenSpec. Existing check names remain intact. CI records its explicit checkout SHA, run, attempt and linked outcome. Publication has a separate job with registry and S4 receipt permissions. PR checks have neither permission.

The publisher builds six application images and the managed migrator from that revision, resolves dependency pins, renders both environments, extracts the migration image's SQL and prefix fingerprints, and checks SQL against the owning source directories. The OCI bundle contains all 13 image pins, environment configuration bytes and hashes, source/configuration revision and CI evidence. It uses the existing Dockerfiles and Kustomize v5.7.1. Azure CLI is pinned to 2.76.0, Buildx to v0.29.1 and BuildKit to the v0.25.1 OCI digest in the workflow; third-party Actions use commit revisions. Publication does not update the infrastructure operator's approved executor digest or workload templates. A newly built executor requires the existing platform approval before activation.

Canonical receipts are created in S4 `astras4receipts/canonical-releases` via its Entra-only HTTPS endpoint, keyed by the full merge SHA, only after OCI publication and verification. `If-None-Match: *` prevents replacement; the locked container retention policy and scoped role are provisioned separately. A retry verifies and adopts the first complete receipt. A different bundle for the same SHA reports a conflict. An interrupted image/bundle upload leaves no selectable receipt. Concurrency groups include the source SHA, so another passing merge cannot cancel its checks or publication. Reconciliation on `main` accepts no SHA input: it enumerates missing, PR-backed merges from an owner-reviewed inclusive `M013_FIRST_MERGE` to protected `origin/develop`. The lower bound must include the merge introducing M0-13. A batch processes up to 64 missing receipts; subsequent runs continue the remaining history.

Pre-merge S3 read-only checks and rehearsal packaging can run before workflow registration. The protected automatic S3 deployment requires the separately authorized minimal default-branch registration. An authorized maintainer applies `m013-rehearsal` to the candidate PR. `rehearsal-checks.yml` runs read-only CI and strict validation against the explicit head SHA. After separate Phase B authorization, the protected operator checks out that exact reviewed SHA, uses a GHCR-only publication credential and runs:

```sh
python3 scripts/release/rehearsal.py --source /protected/candidate \
  --reviewed-source FULL_REVIEWED_SHA --run PASSING_REHEARSAL_RUN_ID \
  --output /protected/evidence/rehearsal.json
```

The operator sets `GITHUB_REPOSITORY=nvawntien/astracode`, `GITHUB_ACTOR` and a protected `GH_TOKEN`, authenticates Docker to GHCR without printing the credential, and installs the pinned Kustomize/PyYAML tooling. The command independently reads the run and every required job, checks their source and results, then uses the same build/packaging function as canonical publication. It writes only to the rehearsal registry namespace and never accesses S4. The resulting `rehearsal` bundle is ineligible for S2 and promotion. `rehearsal-release.yml` offers the same packaging path after default-branch registration, behind the owner-reviewed `testing-rehearsal` environment.

`staging-deploy.yml` freezes slot, action, full source revision, immutable release digest and compatible fallback before native Environment review. The S2 and S3 environments use separate scoped federated principals. Execution serializes per slot, requires a new run with fresh approval for a retry and invokes only the fixed App rollout command through Azure Action Run Command. The App validates actual authorization and immutable receipts, then performs migration, rollout and smoke. Publish sanitized per-run evidence with the observed image, config and schema digests. The workflow has no startup, S4 state or publishing role.

`promotion-eligibility.yml` resolves a semantic tag through the reviewed `promotions.json` on protected main and independently checks the exact successful S2 delivery run, its native review history, its artifact and the canonical S4 receipt. The eligibility reader has no package write, VM power or deployment role. The initial tag mapping is empty. Add reviewed mappings only when a canonical release has eligible S2 evidence. This workflow does not build or deploy production.

Run `python3 -B scripts/release/test_policy.py` and `actionlint` offline. `test_package.py MIGRATION_DIRECTORY` consumes `/migrations` extracted from the local managed migrator image, renders both overlays and exercises the App catalog/unpacker. Its CI proof is deliberately synthetic and is never published. Live registry permissions, receipt immutability and reachability, workflow registration, native approvals and federation remain mandatory Phase B checks.

## Separately reviewed default-branch transition

[Draft PR #74](https://github.com/nvawntien/astracode/pull/74) against `main` registers `staging-deploy.yml`, `publish-canonical.yml`, `release-candidate.yml` and `reconcile-releases.yml` with their executable helpers. It retires the workflow definitions at `release-images.yml` and `deploy-production.yml`. It leaves the existing `main` CI workflow unchanged. The canonical reusable workflow pins exact-source CI and strict OpenSpec to the independently reviewed M0-13 workflow revision `fe7c521f57b2918d55a29e5831e3fcc8a7810c89`. Those checks explicitly verify the candidate SHA. Updating the pinned check definitions needs review. The optional hosted rehearsal publisher and the future S2 read-only promotion workflow are outside the main maintenance diff. Use the protected S3 packaging procedure above.

With separate authorization, disable both old workflow IDs at repository level so historical refs cannot execute them. Keep them disabled when enabling the new `publish-canonical.yml`. Retire and revoke the legacy repository and environment SSH credentials, including `PROD_APP_SSH_KEY` and `PROD_JUDGE_SSH_KEY`, after inventorying their consumers. Remove obsolete host/user/port and known-host configuration from GitHub when authorized. Recheck old workflow IDs and credential inventory before exposure. Keep the old deployment scripts for local and historical reference.

Configure `s3-delivery` for protected `main`, with designated native reviewers, self-review prevention and admin bypass disabled. Use separate environment-scoped client, tenant and subscription variables for S2 and S3. Stage the S2 approval and identity separately before an S2 run. Allow `canonical-publication` only on the required `develop` publication and `main` reconciliation refs. The publisher uses its own S4 UAMI and receives a receipt-container data role only. Set the approved `M013_FIRST_MERGE` lower bound before publication. Keep `M013_PUBLICATION_ENABLED` and `M013_DELIVERY_ENABLED` unset or false until the separately authorized enable steps.

The required repository OIDC subject template uses `repository_id`, `context`, `ref` and `workflow_ref` in that order. The environment supplies the `context` value. The following Bash prints the expected subjects using the public GitHub repository ID. Configure Azure with issuer `https://token.actions.githubusercontent.com` and audience `api://AzureADTokenExchange`. Verify the actual protected token claims before enabling a workflow. For reusable publication, the caller determines `workflow_ref`. Check that `job_workflow_ref` identifies the reviewed publisher on `main` during live verification. [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc) · [Reusable workflows and OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)

```bash
repo=nvawntien/astracode
repo_id=$(gh api --method GET "repos/$repo" --jq .id)
subject() {
  printf 'repository_id:%s:environment:%s:ref:refs/heads/%s:workflow_ref:%s/.github/workflows/%s.yml@refs/heads/%s\n' "$repo_id" "$1" "$2" "$repo" "$3" "$2"
}
subject s3-delivery main staging-deploy
subject s2-delivery main staging-deploy
subject canonical-publication develop publish-canonical
subject canonical-publication main reconcile-releases
```

Use two exact federated credentials for the receipt publisher's separate callers. For the slot delivery UAMIs, use one exact credential per slot and the App-only role. No delivery UAMI needs receipt permissions. No publisher needs VM, ARM subscription or state access. Complete registration and authorization before S3, and repeat the canonical S2 activation and legacy-retirement checks at Task 3.1. [S4 identity order](../../infra/azure/README.md#task-22-first-time-s4-bootstrap)
