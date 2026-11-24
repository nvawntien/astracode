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
pin=$(bash tools/migrations/build.sh "$work/migrator")
plan=$("$work/migrator" stage --tool-sha256 "$pin" --snapshot "$work/bundle.json")
bundle=$(jq -er '. | select(.dirty == false).digest' <<<"$plan") ||
    { echo "PostgreSQL fixture tests require committed migration and catalog inputs." >&2; exit 1; }

run_suite() {
    local suite=$1 owner database password port variable state instance
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
    unset POSTGRES_PASSWORD
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
    "${docker_cmd[@]}" cp "$work/migrator" "$fixture:/tmp/astracode-migrate"
    instance=$(cat /proc/sys/kernel/random/uuid)
    local migration_password
    migration_password=$(openssl rand -hex 32)
    printf '{"migrator":"%s","runtime":"%s"}\n' "$migration_password" "$password" |
        "${docker_cmd[@]}" exec -i "$fixture" /tmp/astracode-migrate bootstrap \
            --environment fixture --owner "$owner" --instance "$instance" |
        jq -s . > "$state/enrollment.json"
    printf '{"%s":"%s"}\n' "$owner" "$migration_password" |
        "$work/migrator" apply --tool-sha256 "$pin" --bundle "$bundle" --snapshot "$work/bundle.json" \
            --port "$port" --state-dir "$state" --enrollment "$state/enrollment.json" --receipt "$state/receipt.json" |
        tee "$state/migration.log"
    (
        export "$variable=$port" ASTRACODE_TEST_FIXTURE_RECEIPT="$state/receipt.json"
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
