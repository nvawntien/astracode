#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
cd "$(dirname "$0")/.."

[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_TLS_VERIFY:-}" &&
    $(docker context inspect default --format '{{.Endpoints.docker.Host}}') == unix:///var/run/docker.sock ]] ||
    { echo "PostgreSQL fixture tests require the local default Docker engine." >&2; exit 1; }
docker_cmd=(docker --context default)
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/astracode-postgres.XXXXXXXX")
fixture=
trap '[[ -z "$fixture" ]] || "${docker_cmd[@]}" stop "$fixture" >/dev/null' EXIT
image=astracode-migrations:integration
"${docker_cmd[@]}" build -f infra/postgres/migrations.Dockerfile -t "$image" .

run_suite() {
    local suite=$1 owner database password port variable state
    case "$suite" in
        TestProblemMutationPostgresConcurrency|TestTestcaseMutationPostgresConcurrency)
            owner=problem database=problem_mutation_test password=problem_fixture
            variable=ASTRACODE_PROBLEM_MUTATION_TEST_PGPORT ;;
        TestGetCurrentDetailPostgresSnapshots)
            owner=submission database=submission_detail_test password=detail_fixture
            variable=ASTRACODE_DETAIL_TEST_PGPORT ;;
        *) echo "Unknown PostgreSQL integration suite." >&2; return 1 ;;
    esac
    state="$work/$suite"
    mkdir "$state"
    local POSTGRES_PASSWORD
    POSTGRES_PASSWORD=$(openssl rand -hex 32)
    export POSTGRES_PASSWORD
    fixture=$("${docker_cmd[@]}" run -d --rm --publish 127.0.0.1::5432 \
        --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev \
        --label astracode.disposable.postgres-suite="$suite" -e POSTGRES_PASSWORD postgres:15.6-alpine)
    local ready=false
    for _ in {1..60}; do
        if "${docker_cmd[@]}" exec "$fixture" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
            ready=true
            break
        fi
        sleep .5
    done
    [[ "$ready" == true ]] || { echo "Disposable PostgreSQL did not become ready." >&2; return 1; }
    port=$("${docker_cmd[@]}" port "$fixture" 5432/tcp)
    [[ "$port" =~ ^127\.0\.0\.1:([0-9]+)$ ]] || { echo "Expected one loopback PostgreSQL port." >&2; return 1; }
    port=${BASH_REMATCH[1]}
    "${docker_cmd[@]}" exec "$fixture" createdb -U postgres "$database"
    PGPASSWORD="$POSTGRES_PASSWORD" "${docker_cmd[@]}" run --rm --network "container:$fixture" -e PGPASSWORD \
        --entrypoint goose "$image" -dir "/migrations/$owner" postgres \
        "host=127.0.0.1 user=postgres dbname=$database sslmode=disable" up 2>&1 |
        tee "$state/migration.log"
    "${docker_cmd[@]}" exec -i "$fixture" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$database" \
        -v role="$password" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'role';
COMMENT ON DATABASE :"DBNAME" IS 'AstraCode disposable integration fixture';
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO :"role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"role";
REVOKE INSERT, UPDATE, DELETE ON public.goose_db_version FROM :"role";
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO :"role";
SQL
    (
        export "$variable=$port"
        cd "services/$owner"
        go test ./internal/adapter/outbound/persistence/postgres -run "^${suite}\$" -count=1 -v
    ) | tee "$state/test.log"
    if grep -q -- '--- SKIP' "$state/test.log" || ! grep -q -- "--- PASS: ${suite} " "$state/test.log"; then
        echo "$suite was skipped or did not pass." >&2
        return 1
    fi
    "${docker_cmd[@]}" stop "$fixture" >/dev/null
    fixture=
}

if (( $# > 0 )); then
    for suite in "$@"; do run_suite "$suite"; done
else
    run_suite TestProblemMutationPostgresConcurrency
    run_suite TestTestcaseMutationPostgresConcurrency
    run_suite TestGetCurrentDetailPostgresSnapshots
fi
echo "PostgreSQL fixture evidence written to $work."
