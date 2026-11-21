# Envoy gateway

The runtime path is Client → Envoy 1.34.2 → Auth / Problem / Submission.
Production also serves Next.js and public MinIO avatars. The gateway never
routes internal gRPC or service health endpoints. [ROUTES.md](ROUTES.md) records
all 50 inherited API routes, authentication, backend authorization, query
allowlists and timeouts. Three inherited declarations currently return a backend
404; this migration does not implement those APIs.

## Configuration and secrets

`routes.json` is the explicit API allowlist. `generate.py` renders development
and production bootstraps plus the route inventory. Security filters are defined
once in the generator; do not edit the generated YAML directly.

```bash
python3 -m pip install -r envoy/requirements.txt
python3 envoy/generate.py
python3 envoy/generate.py --check
```

`GATEWAY_JWK_FILE` remains the Compose interpolation variable. Production keeps
its existing `/etc/astracode/symmetric.json`; it is mounted read-only at
`/source/symmetric.json` in a short-lived, networkless `envoy-jwk` initializer.
Keep the same access secret as Auth and retain canonical file mode 0600. The
[local quick start](../README.md#start-the-local-judge-stack) uses
`go run envoy/gen_jwk.go` with the Compose defaults
`environment/service.env` and `envoy/symmetric.json`. It creates a missing key
with mode 0600 or verifies that the existing path is a regular file with
mode 0600 containing the expected single-key HS256 JWKS. If you override
`SERVICE_ENV_FILE` or `GATEWAY_JWK_FILE`, use the same paths when checking the
key.

If validation fails, check the file type, permissions, and local Auth access
secret. The generator rejects symlinks in both modes. To deliberately replace
a regular local JWK file, coordinate the secret change with Auth, then run
from the repository root:

```bash
(
  set -e
  set +x
  unset JWT_ACCESS_SECRET
  set -a
  source environment/service.env
  JWK_OUTPUT_PATH=envoy/symmetric.json go run envoy/gen_jwk.go -replace
)
```

Never publish this symmetric JWK or put it into a deployment bundle. The initializer
copies it atomically into a dedicated named volume as UID/GID 101, mode 0400.
The serving Envoy runs directly as `101:101`, drops ALL capabilities and enables
no-new-privileges. It mounts only that volume read-only at `/etc/envoy/secrets`;
the canonical source's ownership/permissions never change. The initializer alone
runs as root with DAC_OVERRIDE (read existing host-owned 0600 keys) and CHOWN
(provision the runtime copy), no network and no writable host mounts. It exits
after provisioning. Docker administrators can read both copies; protect daemon
access, host backups and the key volume as secrets. SELinux/rootless Docker and
actual production ownership still require node-specific validation.

Envoy loads JWK at startup. Local key/config edits require explicit activation:

```bash
docker compose run --rm --no-deps envoy-jwk
docker compose run --rm --no-deps envoy --mode validate -c /etc/envoy/envoy.yaml
docker compose up -d --no-deps --force-recreate envoy
```

Production uses the same operations through `scripts/envoy-runtime.sh` and its
production Compose arguments. Do not rely on bind-mount content changes or
`docker compose up` alone to reload YAML, Lua or JWK. Coordinate signing-key
rotation with Auth; there is no automatic dual-key rotation protocol.

## Authentication contract

1. Native `header_mutation` first removes all four incoming identity headers and
   the principal forwarding/IP headers. The Lua filter also removes untrusted
   forwarding/client-IP headers, and `x-envoy-*` request overrides. It derives
   `X-Client-IP` from the direct socket peer. No forwarded-IP hop is trusted.
2. Protected APIs accept **exactly one** credential: one `access_token` cookie OR
   one Authorization Bearer field. Both sources together, duplicate access-token
   cookies, and duplicate/comma-coalesced Authorization fields return empty 401,
   even if the tokens are identical. Lua rejects ambiguity before verification;
   no extractor ordering can choose a different principal. Native `jwt_authn`
   verifies the HS256 JWK. Existing single-Bearer clients remain supported. Protected routes use a
   named per-route requirement; public routes do not validate stale cookies.
3. Native `claim_to_headers` maps sub/role/username/iat to X-User-ID/X-Role/
   X-Username/X-Token-Iat, including numeric iat. No whole-payload header is used.
   There is no new issuer/audience restriction; the previous validator did not
   configure one. No token cache or external authentication service is added.
4. Native RBAC requires the sanitizer's completion metadata on every forwarded
   route, and a valid verified identity on protected routes: nonempty strings
   `sub` and `username` without control characters, role in
   user/moderator/admin (the retired `contributor` role is rejected), and numeric iat in [0, 2^53) whose propagated
   header is an integer. This matches backend integer timestamp parsing.
   Missing/malformed identity is denied before upstream (401 by JWT parsing or
   403 by RBAC). If Lua errors before completion, native RBAC fails closed (403),
   including public routes. CORS local replies do not forward upstream.
5. The 60-second exp/nbf clock skew is explicit, preserving the old validator's
   measured grace period. Expired tokens outside that grace fail before handlers.
   Invalid signatures, algorithms and malformed tokens also fail with 401.
6. Services retain Redis logout-all/session invalidation, RBAC and ownership
   checks. Missing verified claims cannot fall back to incoming identity headers.

Intentional hardening: the legacy KrakenD runtime preferred Bearer over cookie,
accepted the first duplicate access-token cookie, and forwarded incomplete claims.
Pre-fix Envoy chose the cookie when both valid tokens were present and rejected
either invalid token. The migration now rejects all ambiguous protected requests
and malformed identities consistently. Ordinary Auth-issued tokens are unchanged.
This does not add a new required exp/issuer/audience policy: legacy missing-exp
acceptance is retained. Auth continues to issue exp. Clients sending both cookie
and Bearer must remove one credential. Public login/refresh and SSE ticket auth
retain their existing behavior; public requests still receive no trusted identity.

Lua route-cache clearing is disabled: sanitization changes neither the path's
route identity nor the method, and query filtering cannot select a different
route. Clearing the cache after looking up route metadata breaks direct-response
routes in the pinned runtime. Never add routing based on sanitized/claim headers
without reviewing this ordering.

Backend status/body/headers, Cookie and multiple Set-Cookie values pass through.
Refresh retains its old input-header allowlist. Normal API timeout is 3s (empty local 500 on deadline, matching the old gateway); Run
Code is 40s. SSE has no overall request timeout, keeps the 75s idle timeout,
preserves the ticket query, and relies on Submission's ticket/owner validation.
No automatic upstream retries are configured. **API-only** CORS retains localhost:3000,
credentials, methods, headers, preflight 204 and 12-hour max-age. Disallowed origins
receive no CORS grant, matching the old middleware. Website, avatars, SSE and
health receive no edge CORS grant. Non-API OPTIONS reaches its original upstream
without API 204 conversion. Production is same-origin.
Unknown API/event paths and methods return 404 rather than reaching Next.js or
an arbitrary backend. Escaped slashes are rejected to avoid path-boundary bypass.

The Compose HTTP services have no published ports. Node-owned production
overrides must retain that boundary; expose only the required internal gRPC and
storage ports on the private inter-node interface/firewall. The Envoy admin
listener binds container loopback only. A public reverse proxy in front of Envoy
must not be treated as a source of trusted client-IP headers without a separate
review; the current contract uses the immediate peer.

## Verification

```bash
go test envoy/gen_jwk.go envoy/gen_jwk_test.go
python3 envoy/generate.py --check
python3 envoy/tests/route_parity.py
python3 envoy/tests/integration.py
python3 envoy/tests/deployment.py
docker compose config --quiet
```

The black-box suite validates BOTH bootstraps with the pinned image, then starts
them with disposable echo upstreams, an isolated network and a random test JWK.
It checks every route/method, ambiguous/duplicate credentials, missing/malformed
claims, injected Lua failures, non-root key access, invalid/expired/alternate-algorithm JWTs,
claim propagation and spoofing, encoding/query filtering, multipart bytes,
backend errors, multiple cookies, CORS, SSE and production website/avatar routing.
It removes only its own test containers/network. `route_parity.py` independently
reads the 50 original KrakenD declarations at the immutable pre-migration Git
commit, rather than trusting routes.json. CI fetches that history and runs both
checks. `deployment.py` exercises real Envoy and the production bundle controller
and runtime helper against echo application containers tagged as two versions;
it tests same-tag YAML/Lua activation, JWK rotation, failed/partial activation,
paired image/config rollback and refusal of incompatible external credentials.
These echo
tests do not prove backend session revocation or browser behavior; run the
Auth black-box identity/client-IP tests against an isolated real Compose stack
for that evidence. Their integration environment variables remain opt-in.

Optional release checks: `--long-stream` holds a stream beyond 45s; `--legacy DIR`
accepts an externally captured old
Envoy bootstrap and rendered gateway JSON. This optional test is not used by CI
or runtime and uses the same random test JWK for both paths.

## Cutover and rollback

Deployment bundles include envoy.prod.yaml, edge.lua, Compose and activation
scripts; they exclude keys and node-owned environment/override files. The workflow
streams the candidate `deploy-app-bundle.py` to **Python 3.12+ on the App host**
before overwriting any configuration. Its exclusive lock protects snapshot,
activation and rollback. It checks the four running application image tags and
state for consistency, saves the previous non-secret bundle and image tag in
`$ASTRACODE_APP_STATE_DIR` (default `/opt/astracode/.deploy/app`), and retains the
candidate bundle. State and archives are owner-only; preserve them and the old
application images until the rollback window closes. Review archive contents:
service config directories must contain references, never live secrets.

`deploy-app-node.sh` provisions the runtime JWK and validates the actual mounted
configuration with the pinned Envoy binary before replacing services. It explicitly
force-recreates Envoy on every activation, including same-image YAML/Lua/key
updates. The App service list has no second
gateway. Existing external overrides must not reintroduce that service or replace
the new Envoy mounts/entrypoint. Review `docker compose ... config` on the node.

Before first adoption, verify the on-disk baseline matches the serving image,
YAML/Lua, canonical key, and node override. A snapshot of disk cannot discover a
previous unactivated edit. Save a protected independent baseline backup. The
controller fingerprints external stack/override, JWK and referenced service,
Postgres and Redis environment files without copying or logging their contents.
Node overrides must use absolute secret-file paths. Do not rotate node inputs
during activation. Pre-pull the pinned Envoy image; provision host Python 3.12+.

After activation, smoke-test public catalogue, missing-token 401, authenticated
me, refresh/logout-all, upload, SSE, website and avatar URLs. Only then retire the
old orphan container. On the App Node, first verify its Compose project/service
labels, then stop/remove only that old gateway container; do not use a blanket
orphan or volume deletion command.

On activation failure the controller restores the previous bundle and image tag,
then reruns its activation/health checks. It restores partially updated image
fleets before invoking the old script's consistency checks. Manual paired rollback:

```bash
# App Node; use the controller from the reviewed release if the old bundle predates it.
python3 /opt/astracode/scripts/deploy-app-bundle.py --rollback
```

The older `deploy-app-node.sh --rollback` is image-only and must not be used for a
configuration migration. A rollback target with changed external fingerprints is
refused before config mutation. Restore the compatible node-owned inputs explicitly
from protected operator backups (including Auth's matching signing secret), or
deploy a reviewed compatible recovery bundle. Never automatically restore a
revoked signing key or chmod the canonical secret. Failed recovery, interrupted
activation, image loss or disk/state corruption require operator recovery using
the retained bundle/tag and independent backup; this is not crash-atomic or a
distributed transaction. App/Judge and database compatibility remain release
responsibilities. No schema/data rollback is included. Repeat authentication/SSE
smoke tests; actual production cutover and recovery remain NOT VERIFIED.
