# Contracts

Machine-readable interfaces between AstraCode components. The rules are defined in
[ADR-0005](../adr/0005-api-and-event-conventions.md); this page indexes the files and summarises the rules.

## Index

| Interface | Location | Contents |
|---|---|---|
| Domain events | `events/` (created by M1-06) | One JSON Schema of `data` per event type and version (`<type>.json`). The first event types come with M1-06. |
| REST APIs | `openapi/` (created by the first change that documents an endpoint) | One OpenAPI 3.1 file per service (`<service>.yaml`), filled in as changes add or change endpoints. |
| gRPC | [`proto/`](../../../proto/) | Source of truth; generated Go in `pkg/pb/`. |
| Judge command messages (legacy) | [`pkg/judge/`](../../../pkg/judge/) | `JobMessage`, `ResultMessage`. They keep their format and accept only NON-BREAKING changes. |

## Rules in brief

- **HTTP body:** `{status, code, msg, data}`. Validation errors may add `errors: [{field, code, msg}]`. Business codes
  live only in `pkg/response/codes.go`, and the HTTP status of a code is its first three digits. Clients rely on the
  HTTP status first and must handle gateway errors with an empty body.
- **Data:** snake_case fields, RFC 3339 UTC timestamps, `lower_snake_case` enums, UUID strings for new entities,
  `page`/`limit`/`total`/`total_pages` pagination (cursor allowed for unbounded lists).
- **Events:** CloudEvents 1.0 structured JSON. `type` = `astracode.<domain>.<event-name>.v<N>`. One topic per
  producing service (`astracode.<service>.events`), keyed by `subject`. Consumers deduplicate by `id` and ignore
  unknown fields and types. `data` refers to people only by `user_id` and holds no personal data, secrets, source
  code, testcase data or premium content. Each event is at most 64 KB.
- **Correlation:** `X-Request-ID` from Envoy travels as gRPC metadata `x-request-id` and as the event attribute
  `correlationid`.
- **gRPC errors:** canonical codes mapped from the HTTP classes. Callers translate the code and never forward the
  callee's message. Only `Unavailable` and `DeadlineExceeded` are retried.

## BREAKING or NON-BREAKING

Every contract change is labelled in its change and PR.

| Interface | NON-BREAKING | BREAKING ships as |
|---|---|---|
| REST `/api/v1` | New endpoint, response field, optional input or business code | Same PR and release as the website update; `/api/v2` only for clients outside this repository |
| Events | New optional field or new event type | New `.vN+1` type, published alongside the old one for at least one release |
| gRPC | New field, RPC or enum value | New `v2` package; removed fields declared `reserved` |
| Judge messages | New optional field | Migration to the event envelope, with its own rollout plan |

See ADR-0005 §4 for the full definitions.
