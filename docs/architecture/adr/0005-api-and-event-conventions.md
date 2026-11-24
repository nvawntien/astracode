# ADR-0005 — API and event conventions

| Field | Value |
|---|---|
| Status | Proposed |
| Date | 2026-11-24 |
| Milestone | M0-10 |
| Requirement | Contract rules in `AGENTS.md` (BREAKING / NON-BREAKING); NFR-R04, NFR-O01, NFR-S13 |
| Implementation | M1-06 (first event contracts), M1-13 (relay), M0-14 (correlation in logs); every change that adds or changes an interface |
| Owner | Orchestrator |
| Review | Service owners |

This ADR fixes the **shape** shared by every AstraCode interface: HTTP responses and errors, domain event envelopes,
topics, data formats, versioning and the meaning of BREAKING / NON-BREAKING, and where contract files live. It
defines no specific endpoint or event. M1-06 and each feature change define those within these rules. Service
boundaries and the dependency map are in [ADR-0007](0007-service-boundaries-and-data-ownership.md) (Proposed).
Identity headers and entitlement propagation are in ADR-0007 §4.

## Context

- **HTTP.** Every Gin service answers through `pkg/response` with `{status, code, msg, data}`. `code` is a five-digit
  business code from one registry ([codes.go](../../../pkg/response/codes.go)). The registry follows the pattern
  "first three digits = HTTP status" (`40001`, `40900`, `42900`). [`GetHTTPStatus`](../../../pkg/response/errors.go)
  does not fully enforce it:
  - Its fallback maps the whole `40000–40999` range to 400, so a new `404xx` code would return 400.
  - `CodeInternalError` (`50001`) maps to 400.

  There is no field-level validation detail. List endpoints use `page`, `limit`, `total` and `total_pages`. JSON fields
  are snake_case.
- **Client.** The website is the only API client and lives in this repository. It reads `code` and `msg`, and falls
  back to `httpStatus × 100` when the body cannot be parsed ([api.ts](../../../website/src/lib/api.ts)). Errors
  produced by the gateway, such as a missing or invalid token, return 401 with an empty body
  ([gateway notes](../../../envoy/README.md)).
- **Events.** The only Kafka contracts are the judge command messages
  ([`JobMessage`](../../../pkg/judge/job_message.go), [`ResultMessage`](../../../pkg/judge/result_message.go)). They are
  plain JSON without an envelope, event ID or version, keyed by submission ID, and made idempotent by `attempt_id`.
  ADR-0007 introduces domain events from several producers to several consumers.
- **gRPC.** Packages are versioned `…/v1` in `proto/`. Handlers return canonical gRPC status codes. No compatibility
  tooling (such as buf) exists, and `AGENTS.md` forbids inventing toolchains without establishing them first.
- **Correlation.** Envoy generates and logs `X-Request-ID` ([envoy.yaml](../../../envoy/envoy.yaml)). Services neither
  read nor propagate it.
- **Contracts.** `AGENTS.md` requires every contract change to be marked BREAKING or NON-BREAKING, but neither term is
  defined. `docs/architecture/contracts/` is empty.

## Options

| Topic | Options considered | Chosen |
|---|---|---|
| HTTP error body | Keep the current envelope and extend it · RFC 9457 `application/problem+json` | **Keep and extend.** RFC 9457 is more standard, but it is BREAKING for every handler and for the website, and adds no capability we need. |
| Event envelope | Own envelope · **CloudEvents 1.0 structured JSON** | **CloudEvents.** Same effort as an own envelope, with a published specification, libraries and recognizable field names. |
| Judge messages | Wrap them in the new envelope · leave them as they are | **Leave them** as legacy command contracts. Wrapping them is BREAKING on the judging path and its protected rollout, for no new consumer. |
| Topics | One topic per event type · **one topic per producing service** | **Per producing service.** Fewer topics on a single-node Kafka; consumers filter by type. |
| REST versioning | Every BREAKING change → `/api/v2` · **BREAKING allowed in v1 when the website changes in the same PR and release** | **The latter**, while the website is the only client. |
| Contract files | Hand-written Markdown · machine-readable schemas | **Machine-readable**: JSON Schema for events, OpenAPI 3.1 for REST (incremental), `proto/` for gRPC. |

## Decision

### 1. HTTP responses and errors

1. Every HTTP response from a service uses `{status, code, msg, data}`. `status` is `success` or `error`; `data` is
   omitted on errors.
2. A validation error may add `errors: [{field, code, msg}]`. `field` is the JSON path of the input field. This is
   additive and NON-BREAKING.
3. Business codes are registered only in `pkg/response/codes.go`. **The HTTP status of a code is its first three
   digits** (`40405` → 404). Services do not define codes locally.
4. Clients rely on the HTTP status first. They must handle unknown business codes by their HTTP status, and must
   accept errors with an empty or non-JSON body, which the gateway can produce.
5. `msg` is safe to show to a user. It never contains stack traces, SQL, internal hostnames, tokens or personal data
   of another user.

### 2. Data conventions (HTTP, gRPC messages and event data)

| Item | Convention |
|---|---|
| JSON field names | `snake_case` |
| Timestamps | RFC 3339 in UTC with `Z` (`2026-11-24T09:00:00Z`) |
| Enum values | `lower_snake_case` strings |
| IDs | New entities use UUID strings. Existing entities keep their current types. |
| Lists | Pages with `page`, `limit`, `total`, `total_pages`. A list that grows without bound (for example a notification inbox) may use a cursor (`next_cursor`) instead. |

### 3. Domain events

**Envelope.** A domain event is a Kafka message whose value is a CloudEvents 1.0 structured-mode JSON object:

| Attribute | Content |
|---|---|
| `specversion` | `"1.0"` |
| `id` | UUID, unique per event. Consumers deduplicate by it (NFR-R04; ADR-0007 §2). |
| `source` | `astracode/<service>`, for example `astracode/problem-service` |
| `type` | `astracode.<domain>.<event-name>.v<N>`, for example `astracode.problem.moderation-decided.v1`. Event names are kebab-case past-tense facts. |
| `subject` | ID of the aggregate the event is about |
| `time` | When the fact happened (the commit time of the state change), RFC 3339 UTC |
| `datacontenttype` | `"application/json"` |
| `correlationid` | Extension attribute: the correlation ID of the request that caused the event (§5). It may be empty for events caused by scheduled jobs. |
| `data` | The event payload |

**Payload.**

- `data` carries the facts that consumers need, so that they do not call the producer back (event-carried state).
- It refers to people only by `user_id`. It never contains email addresses, names, passwords, tokens, source code,
  testcase data or premium content such as full statements or readings.
- An event is at most 64 KB.

**Topics and keys.**

- Each producing service publishes all its domain events to one topic: `astracode.<service>.events`, for example
  `astracode.problem.events`.
- The message key is the `subject`, so events about one aggregate stay in order.
- Consumers ignore event types they do not handle.
- Partition counts and retention are operational settings, not contract.

**Judge messages.** `judge.submission.jobs`, `judge.submission.results` and the DLT keep their current format as
legacy command contracts. They may only change in NON-BREAKING ways (§4). A future BREAKING change to them moves them to
this envelope.

### 4. Versioning and compatibility

A change to any contract is labelled **NON-BREAKING** or **BREAKING** in its change and PR, using these definitions.

| Interface | NON-BREAKING | BREAKING | How a BREAKING change ships |
|---|---|---|---|
| REST (`/api/v1`) | New endpoint; new response field; new optional input; new business code | Removing or renaming a field; changing a type, unit or meaning; a new required input; changing the HTTP status of an existing case; removing an endpoint | Inside v1 only if the website is updated in the same PR and the same release. `/api/v2` is introduced only when a client outside this repository exists. |
| Events (`type … .vN`) | New optional field in `data`; new event type | Removing or renaming a field; changing a type or meaning; making a field required | New `type` version `.vN+1`. The producer publishes both versions for at least one release, until every consumer has moved to the new one. Consumers ignore unknown fields. |
| gRPC (`proto/…/v1`) | New field; new RPC; new enum value that callers can treat as unknown | Reusing or renumbering a field; changing a field type; removing a field or RPC | New package `v2`. Removed fields and their numbers are declared `reserved`. Until tooling is adopted, compliance is checked in review. |
| Judge messages | New optional field | Any other change | Moves the message to the event envelope (§3), in a change with its own rollout plan |

A change to gateway routes or identity headers follows the REST rules. ADR-0007 already classifies the
`X-User-Premium-Until` header as NON-BREAKING.

### 5. Correlation ID

- The correlation ID is the `X-Request-ID` that Envoy sets at the edge.
- Services put it in the request context and forward it as gRPC metadata `x-request-id`.
- Producers write it to `correlationid` in each event. Consumers restore it into the context while handling the
  event. A service that receives a request without an ID creates one.
- Logs carry it (NFR-O01, M0-14).

### 6. gRPC errors

- Services return canonical gRPC codes. The mapping follows the HTTP classes:

  | HTTP class | gRPC code |
  |---|---|
  | 400 | `InvalidArgument` |
  | 401 | `Unauthenticated` |
  | 403 | `PermissionDenied` |
  | 404 | `NotFound` |
  | 409 | `AlreadyExists` or `FailedPrecondition` |
  | 429 | `ResourceExhausted` |
  | 503 | `Unavailable` |
  | Other server errors | `Internal` |

- Messages carry no sensitive data.
- The caller translates the code into its own HTTP error. It never forwards the callee's message to the end user.
- Only `Unavailable` and `DeadlineExceeded` may be retried, with a bounded number of attempts inside the caller's
  deadline.

### 7. Where contracts live

| Interface | File | Created when |
|---|---|---|
| Events | `docs/architecture/contracts/events/<type>.json`: one JSON Schema of `data` per event type and version | The change that adds the event (first: M1-06) |
| REST | `docs/architecture/contracts/openapi/<service>.yaml`: OpenAPI 3.1 | Incrementally: a change that adds or changes endpoints of a service adds those endpoints. Existing endpoints are described when they are next changed. |
| gRPC | `proto/` (source of truth); generated Go in `pkg/pb/` | Unchanged |
| Index and rules | `docs/architecture/contracts/README.md` | This ADR |

### Out of scope

- Idempotency keys for HTTP writes.
- Rate-limit response headers.
- Tooling to generate or check OpenAPI or protobuf compatibility.

A change that needs one of them proposes it.

## Trade-offs

- Keeping the existing envelope avoids rewriting every handler and the website. It is not a public standard, and the
  `errors` extension is AstraCode-specific.
- CloudEvents adds a few attributes per message, but makes deduplication, routing by type and tracing uniform for
  every consumer.
- One topic per producer keeps the topic count low, but consumers receive event types they skip. At AstraCode volumes
  this cost is negligible.
- Allowing BREAKING REST changes within v1 relies on the website and services being released together. This holds
  while the website is the only client; the rule changes when that stops being true.
- Without compatibility tooling, protobuf and schema rules depend on review discipline.

## Consequences

| Change | What it must do because of this ADR |
|---|---|
| M1-06 `add-notification-event-contract` | Defines the first event types as JSON Schemas under `contracts/events/`, using the envelope, naming and topics above. |
| M1-13 `fix-outbox-relay-delivery` | The shared relay publishes CloudEvents with `subject` as key and preserves `correlationid`. |
| M0-14 `observability-baseline` | Logs carry the correlation ID; services propagate `X-Request-ID` (§5). |
| First change that adds a business code | Makes `GetHTTPStatus` follow rule 1.3 (status = first three digits) and fixes the `CodeInternalError` mapping, as a NON-BREAKING correction. |
| Every change touching an interface | Labels it BREAKING or NON-BREAKING by §4 and updates the contract files in §7. |

`docs/architecture/contracts/README.md` indexes the contracts and summarises these rules. ADR-0007 refers to this ADR
for envelope, versioning and compatibility.
