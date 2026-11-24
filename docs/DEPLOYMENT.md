# AstraCode dual-node production deployment

Production uses immutable GHCR release images, Docker Compose, and a protected
manual GitHub Actions deployment. It has two distinct nodes:

```text
GitHub Actions runner
  ├─ SSH ────────────────────────────────> App Node (astracode-app)
  └─ SSH ProxyJump through App Node ─────> Judge Node (astracode-judge-01)
```

This document describes the production deployment contract. It does not claim
zero downtime or replace host/sandbox security review.

## M1-02 protected promotion hold

Keep the M1-02 cutover and its descendants on the feature branch until the
maintainer and Infra owner demonstrate the temporary freeze. Keep protected
promotion frozen until the ADR-0006 managed migration gate and a compatible
DDL-free application rollback have been implemented and rehearsed. The
current protected bundle has no migration runner.
[Schema policy](architecture/adr/0006-schema-migration-policy.md)

- The repository maintainer restricts `main` updates and creation, updates,
  and deletion of `v*.*.*` tags with empty bypass lists. Disable
  `release-images.yml` and `deploy-production.yml`, verify queued or in-flight
  runs can no longer mutate protected state, and suspend alternate writers to
  protected GHCR packages. Retain effective ruleset/workflow status and the
  writer inventory.
- The Infra owner withholds protected job deployment credentials and suspends
  manual SSH and Docker or sudo release access on the App and Judge nodes.
  Cover any enabled protected staging routes and retain redacted evidence.
  Running services and registry pulls continue during the hold.
- Rehearse refusal for the cutover and a descendant in an isolated equivalent.
  Cover semantic-tag publication, manual dispatch by SHA, dispatch on an old
  workflow ref, and manual activation or rollback on either node. Refusal must
  precede publication, Worker suspension, or host mutation.

Before lifting the freeze, serialize the managed release across all owning
databases and entry points. Verify target identity, least-privilege roles,
artifact provenance, ledger and schema, backup recovery point, and compatible
schema ranges. Rehearse forward migration, verification of all three databases
before activation, and a compatible DDL-free image rollback that leaves the
database versions in place. A pre-Goose managed database needs a separately
reviewed data-preserving adoption and recovery plan before routine releases.

## Release policy

Only a published semantic release tag is valid for production:

```text
vX.Y.Z
vX.Y.Z-prerelease
```

The image workflow publishes all custom images for semantic releases with both
the release tag and `sha-<full-commit>`:

```text
website
auth-service
problem-service
submission-service
judge-worker
sandbox
```

SHA images are useful for CI and staging, but production deployment accepts
only `vX.Y.Z` tags. It never uses `latest`, a branch name, or an arbitrary
commit. Protect release Git tags and configure registry policy so a release tag
cannot be silently overwritten.

## Node ownership boundary

GitHub Actions uploads repository-controlled files only. The following files
are node-owned operational inputs and must never be overwritten, copied from
the repository, or edited by a deployment script:

```text
# App Node
/etc/astracode/app-node.override.yml
/etc/astracode/stack.env
/etc/astracode/service.env
/etc/astracode/postgres.env
/etc/astracode/redis.env
/etc/astracode/symmetric.json

# Judge Node
/etc/astracode/judge-node.compose.yml
/etc/astracode/judge/config.yaml
```

No database, Kafka, Redis, MinIO, JWT, SMTP, WireGuard, or sandbox secret is a
GitHub Actions secret or deployment-bundle file.

## Gateway configuration cutover

Envoy now routes APIs directly and verifies the existing HS256 cookie JWT. Keep
`GATEWAY_JWK_FILE` pointing at the node-owned JWK; no key is included in bundles.
The bundle must contain `envoy/envoy.prod.yaml` and `envoy/edge.lua`. Review the
external override for stale gateway services, mounts and Envoy entrypoint overrides.
The App host needs Python 3.12+. Before the first cutover verify the on-disk
baseline matches the serving configuration, key and release tag, and save an
independent protected backup. The bundle controller snapshots configuration and
image version together before extraction, and explicitly recreates Envoy even
for same-image YAML/Lua/JWK changes. Follow the
[cutover and configuration rollback procedure](../envoy/README.md#cutover-and-rollback).

## App Node

The App Node owns these services:

```text
website
envoy
postgres
redis
minio
kafka
kafka-init
auth-service
problem-service
submission-service
```

It does **not** run production `go-judge` or `judge-worker`.

### Envoy file-descriptor limit

The checked-in `envoy` service sets Docker's `nofile` soft and hard limits to
`65536`. This is an ingress safety requirement for controlled high-connection
benchmarks, not a general proxy-tuning change. One live submission SSE stream
can require both a client-to-Envoy socket and an Envoy-to-Submission-Service
socket; a massive submission burst also creates short-lived API and ticket
connections. The inherited soft limit of `1024` is therefore insufficient and
has previously caused Envoy `socket(2)` failures.

The App Node's `/etc/astracode/app-node.override.yml` is composed last. It
must not replace `services.envoy.ulimits.nofile` with a lower value. A changed
Compose limit requires recreation of the Envoy container; restarting the old
container alone does not change its process limit.

After deployment, verify the effective setting on the running container:

```bash
docker inspect judge_envoy --format '{{json .HostConfig.Ulimits}}'

pid="$(docker inspect -f '{{.State.Pid}}' judge_envoy)"
test "$pid" -gt 0
grep '^Max open files' "/proc/$pid/limits"
```

The final command must show:

```text
Max open files            65536                65536                files
```

This change does not alter Envoy worker concurrency, circuit breakers,
connection pools, HTTP protocol settings, access logging, SSE timeouts,
or application services. It only raises the descriptor ceiling so a
subsequent benchmark can measure those components without the known 1024-FD
failure mode.

Every App deployment must compose exactly these files:

```text
/opt/astracode/docker-compose.yml
/opt/astracode/docker-compose.prod.yml
/etc/astracode/app-node.override.yml
```

The external override keeps Judge-only services behind an opt-in `judge`
profile and supplies the private network bindings required by the Judge Node:

```text
Problem gRPC: 10.77.0.1:9092
Kafka:        10.77.0.1:9094
MinIO:        10.77.0.1:9000
```

`scripts/deploy-app-node.sh` validates the complete three-file Compose model,
pulls and recreates only App services, runs edge smoke checks, preserves the
public avatar bucket behavior, and records state under:

```text
/opt/astracode/.deploy/app/current-image-tag
/opt/astracode/.deploy/app/previous-image-tag
```

`kafka-init` is one-shot and is intentionally not treated as a permanently
running health-checked service.

Kafka runs with a fixed 512 MiB JVM heap below its 1 GiB container memory
limit. Its recurring Docker healthcheck is a lightweight local TCP probe;
`kafka-init` separately performs bounded Kafka protocol-readiness retries before
the idempotent topic-creation commands. App activation starts Kafka, forcibly
recreates and runs the `kafka-init` Compose service to successful completion,
and only then activates the complete App service set.

### One-time benchmark account provisioning

The Auth image contains `/app/provision-benchmark-users` for the fixed
`benchmark_judge_001` through `benchmark_judge_10000` fixture pool. It does not
create sessions, tokens, mail, or verification artifacts. Operators must use
the exact immutable Auth image tag already deployed to the App Node, first run
a dry-run, review its sanitized target/range and exact confirmation phrase,
then run the same command with `--apply --confirm '<printed phrase>'`.
Verify that deployed immutable Auth tag before either invocation; never run a
local, `develop`, or `latest` image against the production Auth database.

Use an interactive TTY so the command can request the shared benchmark password
without echoing it; do not put a password in a command line or environment.
For example, with the same App Compose files, project name, and image tag used
by the deployed stack, run the Auth service as a one-shot no-dependency command
with its entrypoint overridden to `/app/provision-benchmark-users`. This does
not restart the running Auth service. A password-file alternative is accepted
only when it is a regular, non-symlink owner-only file readable by the runtime
`appuser`; verify bind-mount ownership before relying on it.

```bash
# First run dry-run and review the printed target/range confirmation phrase.
docker compose --project-name go-judge-system <same-app-compose-arguments> \
  run --rm --no-deps -it --entrypoint /app/provision-benchmark-users auth-service \
  --config-dir /app/config --start 1 --count 50

# Then use the exact phrase printed above; the password is prompted without echo.
docker compose --project-name go-judge-system <same-app-compose-arguments> \
  run --rm --no-deps -it --entrypoint /app/provision-benchmark-users auth-service \
  --config-dir /app/config --start 1 --count 50 --apply --confirm '<printed phrase>'
```

Normal provisioning is idempotent: canonical existing benchmark accounts are
skipped only when their stored hash matches the supplied password. Normal mode
never resets, deletes, or changes existing accounts; conflicts stop it safely.
The fixed range is `1..10000`; `%03d` keeps `001..100` unchanged and naturally
extends the deterministic namespace through `10000`. For a 10K fixture build,
plan the complete range first (`--start 1 --count 10000`), then apply only the
printed exact confirmation. The command reuses one database pool, processes
accounts sequentially with the production password encoder, and prints only
count-based progress every 500 accounts—never passwords or hashes.

### Benchmark password rotation

Rotation is a separate, explicit fixture-only operation for an already-created
canonical range. It never creates users, accepts no interactive password, and
updates only passwords in one transaction after validating the entire range.

1. Create one temporary local file containing the **new benchmark password**;
   run `chmod 600` on it. Do not place the password itself in documentation,
   command examples, shell history, logs, commits, or chat.
2. Copy that same owner-only file to the App Node using a secure operator
   transfer such as `scp`; ensure the container `appuser` can read the mounted
   file without weakening its permissions.
3. Run the explicit rotation dry-run and copy its printed `ROTATE PASSWORD ...`
   confirmation phrase.
4. Run apply with `--password-file` and that exact phrase.
5. Optionally verify one benchmark account with the same file, then use the
   original file with `bootstrap-sessions` to create fresh local sessions.
6. Delete temporary plaintext password files after bootstrap succeeds.

```bash
# This makes no changes and prints a target/range-bound ROTATE PASSWORD phrase.
docker compose --project-name go-judge-system <same-app-compose-arguments> \
  run --rm --no-deps -it --entrypoint /app/provision-benchmark-users auth-service \
  --config-dir /app/config --start 51 --count 50 --rotate-password --dry-run

# Use the same exact immutable Auth image tag as the running service. The
# password itself is never placed in the command line or environment.
docker compose --project-name go-judge-system <same-app-compose-arguments> \
  run --rm --no-deps -it --entrypoint /app/provision-benchmark-users auth-service \
  --config-dir /app/config --start 51 --count 50 --rotate-password --apply \
  --password-file /secure-mounted/new-benchmark-password \
  --confirm 'ROTATE PASSWORD benchmark_judge_051..benchmark_judge_100 ON <printed-target>'
```

Do not use this rotation mode for normal accounts. A missing, inactive,
suspended, role-changed, or otherwise noncanonical fixture makes the full range
fail before any password update is committed.

Rotation does **not** revoke already-issued sessions. Existing access and
refresh sessions can remain valid according to the normal Auth/session
lifecycle; bootstrap fresh benchmark sessions after rotation.

## Judge Node

The private Judge Node runs only:

```text
judge_sandbox (Compose service: go-judge)
judge_worker  (Compose service: judge-worker)
```

It reaches App services through the private network/WireGuard. Its Compose and
runtime configuration are external and node-owned:

```text
/etc/astracode/judge-node.compose.yml
/etc/astracode/judge/config.yaml
```

### Judge gRPC and testcase-cache rollout contract

The Judge Worker now calls the sandbox through native gRPC at the fixed private
Compose address `judge_sandbox:5051`. Before deploying this Worker release,
the node-owned sandbox Compose must set both of these non-secret environment
values:

```yaml
ES_ENABLE_GRPC: "true"
ES_GRPC_ADDR: "0.0.0.0:5051"
```

The existing production sandbox has gRPC disabled. Changing these values only
in the node-owned Compose does not change an already-running process: the
deployment must recreate `go-judge` (and `judge-worker`) so the sandbox starts
with the gRPC listener enabled. `scripts/deploy-judge-node.sh` already uses
`docker compose up -d --force-recreate` for exactly those two services.

The initial node-sized testcase-cache policy belongs in the node-owned Worker
configuration at `/etc/astracode/judge/config.yaml`, not in a repository
default or environment file:

```yaml
testcase_cache:
  enabled: true
  max_bytes: 25165824       # 24 MiB
  max_entries: 256
  idle_ttl: 10m
  cleanup_interval: 30s
```

This budget is derived from the current 64 MiB sandbox `/dev/shm`: the cache
may use at most 24 MiB, leaving roughly 40 MiB for submission-scoped compiled
executables, executor filesystem overhead, transient work, and safety headroom.
The byte limit is authoritative; the entry limit is a secondary guard. The
cache is derived and ephemeral, and a cache failure falls back to sending the
testcase input as a `MemoryFile` without changing judging correctness.

Do not set global `ES_FILE_TIMEOUT` for this policy. Executorserver's file
store also holds `CopyOutCached` compiled executable FileIDs. The Worker owns
their short lifecycle and deletes each executable after its submission's final
batch; testcase-cache eviction deletes only its own `astracode-tc-v1-*` files.

After recreation, verify the running sandbox has gRPC enabled without exposing
the listener publicly:

```bash
docker inspect judge_sandbox --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^ES_(ENABLE_GRPC|GRPC_ADDR)='

docker exec judge_sandbox sh -ec \
  "awk 'NR > 1 { split(\$2, address, \":\"); if (toupper(address[2]) == \"13BB\" && \$4 == \"0A\") found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6"
```

The expected listener is TCP port `5051` (`0x13BB`) and the environment must
show `ES_ENABLE_GRPC=true` and `ES_GRPC_ADDR=0.0.0.0:5051`.

`scripts/deploy-judge-node.sh` does not edit either file. For each release it
creates a secure temporary Compose override containing only these two image
fields:

```yaml
services:
  go-judge:
    image: ghcr.io/nvawntien/go-judge-system/sandbox:vX.Y.Z
  judge-worker:
    image: ghcr.io/nvawntien/go-judge-system/judge-worker:vX.Y.Z
```

It then composes the node-owned file plus the temporary image override, pulls
and recreates only `go-judge` and `judge-worker`, verifies both containers,
checks sandbox HTTP reachability without publishing a port, and confirms the
Worker listens on the `server.grpc_port` derived from its external config.

Judge state is recorded independently:

```text
/opt/astracode/.deploy/judge/current-image-tag
/opt/astracode/.deploy/judge/previous-image-tag
```

The protected rollout requires the running and planned Worker to use
`WORKER_POOL_SIZE=1`. Higher parallelism can complete a later offset while an
earlier job from the same partition is still running. The rollout sends
SIGTERM and disables container restart until Compose recreates the Worker.
SIGTERM cancels the Kafka session. Completed and marked jobs can commit,
while interrupted valid jobs without committed offsets are eligible for
redelivery. Result application still checks the attempt ID and terminal state
if a verdict was published before its offset committed.

## GitHub Environment secrets

The `production` Environment requires pinned SSH material for both hosts:

```text
PROD_APP_HOST
PROD_APP_PORT
PROD_APP_USER
PROD_APP_SSH_KEY

PROD_JUDGE_HOST
PROD_JUDGE_PORT
PROD_JUDGE_USER
PROD_JUDGE_SSH_KEY

PROD_KNOWN_HOSTS
```

`PROD_KNOWN_HOSTS` must contain pinned host keys for the App Node and the Judge
Node. The workflow creates an ephemeral SSH configuration with
`ProxyJump astracode-app`, `BatchMode yes`, `IdentitiesOnly yes`, and strict
host-key checking. It never disables host verification.

If one key is deliberately authorized on both hosts, its value may be supplied
to both logical key secrets; the workflow does not assume that arrangement.

## Deployment sequence

Set these non-secret variables in the GitHub `production` Environment for a
stable, operator-authorized testcase fixture:

```text
PROD_JUDGE_PROBE_PROBLEM_ID
PROD_JUDGE_PROBE_TIME_LIMIT_MS
PROD_JUDGE_PROBE_MEMORY_LIMIT_KIB
```

A fixture configured for one second and 512 MiB uses `1000` and `524288`.
Keep the fixture's limits and dataset stable through rollout and rollback.
The private `GetTestCase` probe prints no signed URLs or testcase content.
The deploy user needs writable `/opt/astracode/.deploy` on both nodes and
`flock` on the Judge Node. Use the documented single-container topology and
literal private IPv4 Problem and Kafka addresses. The gates reject extra local
Problem replicas, extra managed Workers, or a Kafka group that remains active.
Avoid separate deployments, configuration edits, and new consumer instances
during the maintenance window.

The running Worker must provide its startup record at
`/tmp/astracode-judge-worker-runtime.json`. The Worker writes it from its loaded
configuration and initialized consumer, using a writable `/tmp` in the
container. Preflight validates the record against
PID 1 and compares the captured Problem endpoint, Kafka broker, group, topic,
and pool size to the planned Compose settings. Startup evidence is required
even when the mounted file currently matches the plan. The Judge Node checks
the same container and its startup settings again before suspension. The App
Node verifies the consumer group reported by that Worker.

### First protected rollout from a legacy pair

Use a maintenance window. Keep the production lock, node-owned configuration,
and private network topology stable and prevent other Worker launches. In the
manual **Deploy production** workflow, select the protected target
`image_tag`, enter the installed App/Judge tag as `legacy_from`, and enter the
Judge Node's Kafka-visible private IPv4 address as `legacy_judge_peer`. Obtain
the peer from the private network inventory before dispatch. The address must
identify that Judge Node exclusively. Shared NAT or proxies cannot establish
this identity. Leave both inputs blank after the first successful protected
release.

This path supports an official legacy Worker with the direct image entrypoint,
`WORKER_POOL_SIZE=1`, and a retained current-startup log containing its
effective broker and group. The broker must report one stable dynamic
round-robin member at the approved peer, subscribed and assigned exclusively
to the planned job topic. The App tag and live fixture must match the legacy
pair, with both limit fields absent. Missing logs, ambiguous membership, a
changed member, or different settings block the transition. Recover the
evidence before retrying. A host config edit alone cannot establish identity.

After rechecking the same container and Kafka member from Judge, the workflow
disables restart and uses SIGKILL for the legacy Worker. This avoids running
the legacy cancellation path, which can acknowledge a failed DLT publication.
An uncommitted job can be redelivered, including a result published just before
the stop. The existing attempt guards handle duplicate results. Kafka may
retain the member until its session expires. App activation waits for
`Empty` and zero members on the verified group. The procedure changes neither
offsets nor topics and cannot recover a job the legacy Worker already
acknowledged before suspension.

App activates first. Both private probes must verify the new fixture limits
before the Worker can start. The new Worker must report its startup record
for the same broker, group, and topic. Submit one approved synthetic job and
verify its completion and Kafka lag before closing the maintenance window.
Interactive Run Code is unavailable while the Worker is stopped.

If bootstrap fails after suspension, the workflow keeps judging suspended.
When the previous App bundle can be restored and verified, it restores that
legacy App without restarting the legacy Worker. Inspect the recorded tag,
container ID, broker, group, and topic from the preflight output. Resolve any
ambiguous SSH or App state on both hosts, verify the actual group is empty,
then restore or activate a compatible limits-aware App bundle. Check the
positive fixture contract from both nodes before activating its matching
protected Worker with the recorded settings. Use the protected recovery
commands below. Retain the staged bundles and probe for this recovery.
Reverting to legacy judging requires a separate emergency decision because
the old Worker can still use fallback limits and acknowledge failed DLT writes.

### Normal protected rollout

The manual **Deploy production** workflow:

1. validates and checks out the requested semantic release tag;
2. checks that all six GHCR release image manifests exist;
3. builds the private gRPC probe and stages non-secret artifacts privately;
4. checks the previous tags and compares the running and planned Worker
   settings with the App Node's published private ports;
5. suspends the Worker and waits for its Kafka group to report `Empty` with zero members;
6. activates the App bundle and checks the active Problem image, exact fixture
   limits, and consumer group again;
7. starts and verifies the sandbox, probes the Problem contract from the
   Judge Node, then starts the matching Worker and verifies its health.

The App workflow streams the candidate `scripts/deploy-app-bundle.py` into host
Python before extracting the upload. That controller locks App deployment,
validates the allowlisted archive, snapshots the current non-secret bundle and
image tag, then runs activation. The serving Envoy is non-root; a networkless
initializer provisions a read-only UID-101 key copy without changing canonical
0600 permissions. Configuration validation and forced recreation are shared in
`scripts/envoy-runtime.sh`.

Official submissions wait in the durable queue during the maintenance window.
Interactive Run Code is unavailable while the Worker is stopped. Monitor
Kafka lag, retention, and DLT activity, and use an approved synthetic job
to verify the completion flow after judging resumes.

The Worker processes each input partition in offset order. If both judging
and the synchronous DLT write fail, the affected partition stops advancing for
that consumer session. Other partitions can continue. The error log includes
the source topic, partition, offset, and cause. Restore DLT publication and
restart the Worker to redeliver the unresolved message. A Kafka rebalance may
also redeliver it. Check the retained DLT record and committed offsets after
recovery. DLT records for malformed messages use
`original_value_encoding: "base64"` to keep their exact bytes. Valid JSON keeps
the existing DLT representation. A shutdown between DLT acknowledgement and
offset commit can produce duplicate DLT records with the same origin offset.

## Rollback

After managed migration adoption, use a previously verified DDL-free rollback
release compatible with the resulting schema. Routine rollback may only
restore compatible application images and configuration. Keep the database
versions in place and exclude legacy startup-DDL images. Apply the
[M1-02 hold](#m1-02-protected-promotion-hold) to these entry points.

The workflow suspends Judge and verifies the group is empty before restoring
App. An App activation failure uses the bundle transaction's own restoration.
Later failures restore the recorded previous App image/config bundle first.
The workflow verifies the previous App tag and live contract before starting
the matching previous Judge release. The requested deployment remains failed
even when recovery succeeds. Retain the App state and archives under
`/opt/astracode/.deploy/app` and the previous release images.

External stack/override/JWK and referenced environment files are fingerprinted,
never bundled or restored. Rollback refuses a changed fingerprint before
mutating configuration: an operator must explicitly restore compatible protected
node inputs (including Auth's matching signing secret), or deploy a compatible
recovery bundle. Automatic rollback must not resurrect a revoked signing key.
An ambiguous SSH outage, unknown App state, failed restoration, or unverifiable
contract requires operator recovery. A legacy App can be restored, but
missing limits prevent automatic Judge resumption. Rolling back only Problem
breaks the new Worker. Rolling back only Worker can reintroduce fallback
verdicts and requires an explicit emergency decision.

When recovering manually, confirm the Judge container is stopped with restart
disabled and verify the group is empty on the App broker. Compare runtime
images and node state files. Restore a compatible App bundle, then check the
private RPC using the staged probe from both hosts before resuming the matching
Judge release. Retry through the protected workflow once the recorded pair is
consistent. Keep judging suspended while a host or contract is unverified.
Preserve pending attempts and broker offsets. Application rollback does not
roll back the database or make older schemas compatible.

For an interrupted workflow, the previous tag is printed before suspension.
On the Judge Node, the same suspension helper is safe to retry:

```bash
ASTRACODE_PROTECTED_ROLLOUT=1 /opt/astracode/scripts/deploy-judge-node.sh --suspend "$PREVIOUS_TAG"
```

On the App Node, confirm group state with the Worker group from its node-owned
configuration. If the failed release is the active App tag and the previous
bundle is known, the staged coordinator can restore that exact reference:

```bash
docker exec judge_kafka kafka-consumer-groups.sh --bootstrap-server 127.0.0.1:9092 \
  --describe --group "$WORKER_GROUP" --state
# Proceed only with Empty and zero members.
set -o pipefail
tar -xOf "$APP_BUNDLE" scripts/deploy-app-bundle.py | \
  ASTRACODE_PROTECTED_ROLLOUT=1 python3 - --rollback "$CURRENT_APP_TAG" "$PREVIOUS_TAG"
```

If those references disagree, leave the Worker stopped and inspect both
nodes' state before another activation. Keep the staged bundle and probe for
recovery until the deployment or rollback has been verified.

## One-time server preparation

Operators must provision and permission these pre-existing paths before the
first deployment:

```text
/opt/astracode
/opt/astracode/.deploy/app
/opt/astracode/.deploy/judge
/etc/astracode/*                 # App Node ownership
/etc/astracode/judge/*           # Judge Node ownership
```

The deployment accounts need Docker access, read access to their node-owned
configuration, write access to `/opt/astracode`, and no broader privileges than
required. Private network routes and firewall rules must permit only the
intended Judge-to-App interfaces; do not publish Kafka, Problem gRPC, MinIO,
Worker gRPC, or Sandbox HTTP to the public Internet.

## Deprecated command

`scripts/deploy-production.sh` intentionally exits without deploying. It is a
deprecated combined-node entrypoint retained only to prevent accidental use;
use the protected GitHub workflow instead.
