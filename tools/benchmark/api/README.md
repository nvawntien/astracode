# AstraCode API benchmark

This is a separate, GET-only k6 workload for representative public problem reads:
`GET /api/v1/problems/<slug>`. It measures API/Gateway/service capacity, not
Judge execution. `judge-bench` remains the submission-to-terminal Judge
pipeline benchmark.

`k6` is an operator runtime dependency and is not needed by Go or Python tests.
The launcher rejects remote HTTP, unconfirmed remote hosts, unbounded duration,
missing request caps, and paths outside the verified public problem-read shape.

```bash
tools/benchmark/api/run.sh --base-url https://<host> --allow-remote \
  --confirm-target-host <host> --path /api/v1/problems/<slug> \
  --rate <rps> --duration <duration> --preallocated-vus <n> --max-vus <n> \
  --max-requests <cap> --system-config tools/benchmark/system-config.json
```

Each successful k6 run writes immutable `run.json` and `summary.json` under
`tools/benchmark/api/bench-results/`. They contain safe allowlisted metadata
only; no credentials or environment dumps are accepted.

## Submission admission: one POST per pre-issued identity

`submission-admission.js` is a separate **admission-only** workload. It does
not modify the GET-only `api.js` / `run.sh` benchmark above.

It supports two separate modes:

- `burst` (default): each VU owns one deterministic slice and sends it with
  `http.batch()`.
- `arrival`: `constant-arrival-rate`, where each *started* iteration maps its
  zero-based `iterationInTest` to exactly one identity. Dropped iterations do
  not execute and therefore do not reuse an identity.

It reads the existing private credential-file schema once through k6
`SharedArray`. The launcher assigns each VU one deterministic contiguous slice
of identities and runs one `per-vu-iterations` iteration per VU. Inside that
one iteration it issues the slice with `http.batch()`. The required invariant
is checked before k6 starts:

```text
burst-vus × requests-per-vu = user-count
```

Therefore each selected identity still makes exactly one authenticated:

```text
POST /api/v1/submissions
```

The POST has redirects disabled and is never retried. HTTP 201 is the only
accepted response. The workload deliberately does **not** issue an event-ticket
POST, open SSE, reconcile with GET, or wait for any Judge/terminal pipeline
work. It is not a Judge Core, E2E, terminal throughput, or 100K-RPS claim.

The launcher accepts only an existing credential file with schema version `1`
and enough non-empty access-token sessions. It never prints cookies, access
tokens, refresh tokens, or request bodies. Remote targets require HTTPS plus
`--allow-remote --confirm-target-host`; output directories must be new.

```bash
tools/benchmark/api/run-submission-admission.sh \
  --base-url https://<host> --allow-remote --confirm-target-host <host> \
  --users-file tools/benchmark/judge/users-100k.local.json \
  --user-count <n> --burst-vus <n> --requests-per-vu <n> \
  --problem-id <id> --problem-slug <slug> \
  --language CPP --source-file /safe/approved-benchmark.cpp \
  --max-duration 30s --system-config tools/benchmark/system-config.json
```

The launcher explicitly configures k6 `batch` and `batchPerHost` to
`requests-per-vu`; it does not leave k6's `20` / `6` defaults in place. The
batch invocation clock spread is recorded as local `Date.now()` timing around
each `http.batch()` call, not as an on-wire dispatch claim.

Artifacts contain only aggregate admission evidence: intended, attempted,
HTTP-201 accepted, 429, other 4xx, 5xx, transport failures, acceptance rate,
fixed safe transport-error classifications, dropped iterations, achieved
request rate, k6 HTTP phase/iteration distributions, batch/VU
configuration, and Git SHA/dirty metadata. They never include credential
values, raw transport errors, URLs, request bodies, or source contents.

Arrival-mode summaries retain the configured target RPS/duration, scheduled
identities, and attempted/accepted counts normalized by the target duration.
`achieved_rps` remains k6's aggregate HTTP rate and can be affected by long
tails or graceful stop; it is not a fabricated capacity value.

Example future operator shapes (do not run without an approved window):

```bash
# R2: 50 VUs × 40 distinct identities = 2,000 one-shot POSTs.
tools/benchmark/api/run-submission-admission.sh ... \
  --user-count 2000 --burst-vus 50 --requests-per-vu 40

# R5: 100 VUs × 50 distinct identities = 5,000 one-shot POSTs.
tools/benchmark/api/run-submission-admission.sh ... \
  --user-count 5000 --burst-vus 100 --requests-per-vu 50
```
