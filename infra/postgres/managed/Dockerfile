FROM ghcr.io/pressly/goose:v3.30.0@sha256:be517314f6a530e7e8eb2b026e3607b05ca92742a791e64fb79901d9618f2236 AS goose
FROM postgres:15.6-alpine@sha256:8a8d55343d6fc456cb183453e3094ff140b984157b36b48f817dd581654f2aec
COPY --from=goose /usr/local/bin/goose /usr/local/bin/goose
COPY services/auth/migrations/ /migrations/auth/
COPY services/problem/migrations/ /migrations/problem/
COPY services/submission/migrations/ /migrations/submission/
COPY infra/postgres/managed/astra-migrate /usr/local/bin/astra-migrate
WORKDIR /migrations
RUN set -eu; sha256sum */*.sql > sha256sums; \
    for service in auth problem submission; do \
      count=0; for file in "$service"/*.sql; do \
        count=$((count + 1)); version=$(printf '%05d' "$count"); \
        case "$file" in "$service/$version"_*.sql) ;; *) exit 1 ;; esac; \
      done; printf '%s\n' "$count" > "$service.version"; \
    done
COPY infra/postgres/managed/catalog.sql infra/postgres/managed/package-prefixes.sh /platform/
RUN chown postgres /migrations && su-exec postgres /platform/package-prefixes.sh && chown -R root:root /migrations
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/astra-migrate"]
