# Staging controller

The Azure Functions candidate contains a monitored one-minute timer and an Entra-authenticated HTTPS handler. Both use one ETag-protected Blob record for the environment. Approval binds the originating request, GitHub repository, dispatcher, reviewer, workflow revision, run and attempt. The controller validates Entra and GitHub signatures separately and reads the native review history itself. Separate Entra clients and app roles cover lifecycle, deployment, promotion eligibility, App poll and the S3 infrastructure operator. Live operation depends on review of Proposed ADR-0013 and verified directory and federation support. [Proposed ADR-0013](../../../../docs/architecture/adr/0013-staging-lifecycle-control-plane-and-identity.md)

Build the deterministic source package with `bash infra/azure/lifecycle/controller/package.sh OUTPUT.zip`. Review the contents and digest. A Phase B operator installs this package with the pinned Python dependencies using the approved Flex Consumption build and delivery path. Test storage firewall access, Functions timer delivery, Entra validation, GitHub review proof, Azure power responses and Monitor notification on the actual target before arming compute. Only synthetic fixtures are used in Phase A.

The infrastructure operator supplies `controller.policy_json` as protected non-secret configuration. Tenant, audience, VM IDs, Blob scope and App poller principal are independently generated from the Terraform target. The policy contains:

| Field | Required binding |
| --- | --- |
| `repository`, `repository_id` | The approved repository full name and immutable numeric ID. |
| `clients` | Entra application ID to role mapping. Set object ID plus app role for each application identity, or the delegated scope for the member client. Set member user object IDs to GitHub numeric IDs in `members`. |
| `workflows`, `subjects`, `dispatchers`, `reviewers` | Exact paths and allowlisted protected main revisions per operation role, an OIDC subject per environment and numeric GitHub actor IDs as strings. Owner reviews lifecycle. Designated maintainers review deployment and promotion. |
| `off_start`, `off_end`, `off_window_confirmed` | The owner-confirmed daily Asia/Ho_Chi_Minh window, at least twelve hours. Leave confirmation false until approved. Observe a complete off window before relying on the measured off-time floor. |
| `contest` | A protected boolean. The timer imports it into the record. Shutdown remains active during a freeze. |
| `receipt_endpoint`, `canonical_sources` | The S4 release-records endpoint and registered bundle digest to canonical merge SHA lookup. The controller independently validates the immutable receipt and hash before use. |
| `reviewed_forward_rollback`, `promotion_mappings` | Previously reviewed compatible forward rollback bundle digests, and reviewed semantic tag mappings keyed by the approved protected workflow revision. |
| `experiment`, `rehearsal_owner` | S3 only. UUID, exact VM pair, approval reference, hard UTC deadline and `releases` mapping each approved OCI bundle digest to the full reviewed source SHA. Set the owner numeric ID. Persist before compute. Upload each verified receipt conditionally to `controller-state/rehearsal-DIGESTHEX.json` using the protected provisioning identity. The initialized durable bindings and deadline are authoritative. |

Members submit a typed request to `POST /api/v1/draft` with a delegated Entra token. Use `schemaVersion: 1`, `environment: s2`, the `operation`, a fresh UUID `requestId`, and the original numeric GitHub ID string as `requester`. Include `sessionGeneration` for every operation except `start`, `requestedExpiry` for an extension, and `releaseDigest` plus `migration` for deployment, rollback, restart or recovery. The latter binds the PostgreSQL `system_id`, the reviewed `recovery_point` and `rollbackDigest`. A recovery request additionally names `reconcile_attempt`, all three `observed_versions`, `confirmed_retired_jobs` and `work_reconciled: true` after reconciling retained work. A backing-store-only startup for a retained mutation names its `recoveryAttempt`. Dispatch the identical JSON from protected `main` and review the displayed digest and contents. The requester can be the owner if a different authorized dispatcher submits the request. `POST /api/v1/status` with an empty JSON object returns sanitized session and power status. A durable accepted request stays in the record after the GitHub run exits.

The App host reports fresh per-node epochs and boot IDs. It pulls an approved ticket and bundle, updates the activation record conditionally, and requests a short lease for the trusted processes. It records the verified backing-store and runtime descriptors, the selected migration and initialization artifacts, per-owner schema versions and smoke outcome. Deployment admission creates no power intent. Traefik verifies a tester certificate and uses the App host's private forward-auth service for a new request. A separate SNI and CA admit the narrowly authorized smoke fixture during rollout. Provision distinct `tester-ca` and `smoke-ca` trust roots, server certificates and reviewed hostnames. Keep the smoke private key on App and distribute tester client certificates only to approved members. The App cache permits for at most two seconds and denies on controller failure after cache expiry.

On expiry, tester and workload leases expire. The App drains by safely interrupting guarded work, confirming prior Submission exit and zero Worker group membership, and recording aggregate counts for retained attempts, outbox entries, Kafka work, results and DLT. It does not delete jobs or advance offsets. A failed drain retains an uncertain record while the independent controller still deallocates at the hard deadline. Delay on one VM leaves cleanup visibly incomplete. Cleanup continues after workflow loss and timer restarts. A reviewed provider resolution for an ambiguous intent can be added to protected `confirmed_power_intents` as intent UUID to exact target and durable evidence reference. The controller requires both observed deallocated states before applying it. Status alone does not prove the original start operation terminated.

The emergency operator uses a separate deallocate-only Entra identity and a reviewed JSON pair of VM resource IDs. With the controller and release helpers on the Python module path, run `python3 infra/azure/lifecycle/controller/emergency.py REVIEWED_TARGETS.json` from the authorized operations environment. It polls both exact VM instance views and reports whether both are deallocated. The Azure role and VM-pair policy independently restrict resource changes. The emergency command can run during controller or GitHub unavailability. S3 uses deallocate-only controller RBAC and signals the inventory follow-up at its protected deadline.

Before an S2 Terraform compute apply, the approved `start` carries the exact plan `sha256`, `operation`, `role` and `expiresAt`. The controller requires confirmed inactive targets and leaves App and tester leases closed. The reviewed runner verifies its live status. A normal approved `start` follows deallocation when staging is ready for activation. See the [controller contract draft](../../../../openspec/changes/azure-walking-skeleton/design.md#controller-http-contract-draft) for payload compatibility and the protected-ref proof change.

On S3, the protected rehearsal operator posts to `/api/v1/approve` with `schemaVersion: 1`, `environment: s3`, `operation: resume-rehearsal`, a fresh UUID `requestId`, the approved numeric `requester`, the original experiment UUID as `sessionGeneration`, and the retained operation UUID as `recoveryAttempt`. Verify both VMs are deallocated before submitting. Start the exact pair from the separate authorized Azure power identity inside the returned `bootDeadline`. The controller requires two fresh boots before issuing any operation ticket. Submit a separate `recover` request with the original attempt, confirmed stale Job exits and verified retained-work and all-owner evidence. At partial histories, successful reconciliation returns to the closed forward-required state. Use a separate approved `deploy` for the same reviewed release and current epochs. [Rehearsal procedure](../README.md#s3-pre-merge-rehearsal-and-cleanup)

Submit a reviewed S3 deploy, rollback or recovery JSON from the repository root and the approved S3 API-client context. Use the exact Function hostname and configured controller audience, with the JSON and response kept in protected storage.

```bash
set +x
PYTHONPATH=scripts/release python3 - "$S3_CONTROLLER_HOST" "$S3_CONTROLLER_AUDIENCE" "$REQUEST_JSON" <<'PY' >"$RESPONSE_JSON"
import json
from pathlib import Path
import re
import sys

from policy import canonical
from transport import azure_token, request

host, audience, source = sys.argv[1:]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]*[.]azurewebsites[.]net", host):
    raise SystemExit("Unexpected Function hostname")
payload = json.loads(Path(source).read_bytes())
if payload.get("environment") != "s3":
    raise SystemExit("Expected the reviewed S3 request")
_, _, body = request(
    f"https://{host}/api/v1/approve",
    "POST",
    canonical(payload),
    {"Authorization": "Bearer " + azure_token(audience), "Content-Type": "application/json"},
)
print(body.decode())
PY
```

Run `python3 -B infra/azure/lifecycle/controller/test_controller.py` with the pinned dependencies installed. Tests use local RSA signatures, synthetic GitHub review records, a conditional in-memory store, a fixture clock and VM power operations. They verify the actual handler, timer state and request admission without using cloud credentials.
