FROM ghcr.io/pressly/goose:v3.30.0@sha256:be517314f6a530e7e8eb2b026e3607b05ca92742a791e64fb79901d9618f2236 AS goose

FROM alpine:3.21
COPY --from=goose /usr/local/bin/goose /usr/local/bin/goose
COPY services/auth/migrations/ /migrations/auth/
COPY services/problem/migrations/ /migrations/problem/
COPY services/submission/migrations/ /migrations/submission/
COPY infra/postgres/migrate.sh /migrate.sh
USER 65532:65532
ENTRYPOINT ["/bin/sh", "/migrate.sh"]
