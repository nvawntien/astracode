#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

die() { echo "$*" >&2; exit 1; }

if [[ $# != 3 ]]; then
    die "Usage: bash scripts/local-stack.sh DOCKER_CONTEXT astracode-dev-NAME {plan|up|go|seed-tags}"
fi
context=$1 project=$2 action=$3
[[ "$project" =~ ^astracode-dev-[a-z0-9][a-z0-9-]*$ ]] || die "Choose an explicit astracode-dev-NAME project."
case "$action" in
    plan|up|go|seed-tags) ;;
    *) die "Unknown operation. Select a new isolated project for fresh data. This launcher does not reset databases." ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_TLS_VERIFY:-}" ]] || die "Use an explicit local Docker context."
endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')
case "$endpoint" in
    unix:///var/run/docker.sock|unix:///run/user/"$(id -u)"/docker.sock) ;;
    *) die "The selected context is outside the supported local Docker sockets." ;;
esac
docker_cmd=(docker --context "$context")
compose=("${docker_cmd[@]}" compose -p "$project" -f docker-compose.yml -f docker-compose.local.yml)
context_key=$(printf '%s\n%s\n' "$context" "$endpoint" | sha256sum | cut -d' ' -f1)
state=$(realpath -m "${XDG_STATE_HOME:-$HOME/.local/state}/astracode/migrations/$context_key/$project")
[[ "$state" != "$root/"* ]] || die "Migration state must live outside the checkout."
mkdir -p "$state"
[[ -O "$state" && $(stat -c '%a' "$state") == 700 ]] || die "Migration state must be owner-only."
exec 9>"$state/activation.lock"
flock -w 60 9 || die "Another local activation is in progress."

run_dir=$(mktemp -d "$state/run.XXXXXXXX")
export ASTRA_MIGRATION_STATE="$state" ASTRA_MIGRATION_RUN_DIR="$run_dir"
export ASTRA_MIGRATION_RUN="${run_dir##*/}"
export ASTRA_MIGRATION_UID="$(id -u)" ASTRA_MIGRATION_GID="$(id -g)"
export ASTRA_MIGRATION_TOOL_SHA="$(bash tools/migrations/build.sh "$run_dir/migrator")"
[[ -n "$ASTRA_MIGRATION_TOOL_SHA" ]] || die "The pinned migrator could not be built."
stage() {
    "$run_dir/migrator" stage --root "$root" --tool-sha256 "$ASTRA_MIGRATION_TOOL_SHA" --snapshot "$1"
}
plan=$(stage "$run_dir/bundle.json")
export ASTRA_MIGRATION_BUNDLE="$(jq -er .digest <<<"$plan")"
if [[ "$action" == plan ]]; then
    echo "$plan"
    exit 0
fi
if [[ $(jq -er '.dirty|tostring' <<<"$plan") == true &&
    "${ASTRACODE_APPROVE_DIRTY_BUNDLE:-}" != "$ASTRA_MIGRATION_BUNDLE" ]]; then
    die "Dirty migration inputs require ASTRACODE_APPROVE_DIRTY_BUNDLE=$ASTRA_MIGRATION_BUNDLE"
fi
case "${ASTRACODE_RECONCILE_MIGRATIONS:-false}" in
    true|false) ;;
    *) die "Set ASTRACODE_RECONCILE_MIGRATIONS to true or false." ;;
esac

export POSTGRES_ENV_FILE="$root/environment/postgres.env" REDIS_ENV_FILE="$root/environment/redis.env"
export SERVICE_ENV_FILE="$root/environment/service.env" GATEWAY_JWK_FILE="$root/envoy/symmetric.json"
for file in "$POSTGRES_ENV_FILE" "$REDIS_ENV_FILE" "$SERVICE_ENV_FILE"; do
    [[ -f "$file" ]] || die "Set up the ignored local env files using the examples."
done
volume_name="${project}_postgres_data"
engine=$("${docker_cmd[@]}" info --format '{{.ID}}')
read_volume_binding() {
    local volume_id
    volume_id=$("${docker_cmd[@]}" volume inspect --format '{{.Driver}}:{{.Scope}}:{{index .Labels "com.docker.compose.project"}}:{{index .Labels "com.docker.compose.volume"}}:{{len .Options}}:{{.CreatedAt}}' "$volume_name") ||
        return 1
    [[ "$volume_id" == "local:local:$project:postgres_data:0:"* ]] || return 1
    printf '%s:%s\n' "$engine" "$volume_id"
}
if "${docker_cmd[@]}" volume inspect "$volume_name" >/dev/null 2>&1; then
    binding=$(read_volume_binding) || die "Unexpected local PostgreSQL volume."
    [[ -f "$state/docker-binding" && $(<"$state/docker-binding") == "$binding" ]] ||
        die "Existing PostgreSQL volume is outside the trusted enrollment. Select a fresh project."
elif [[ -f "$state/docker-binding" ]]; then
    die "The enrolled PostgreSQL volume is missing. Select a fresh project."
fi

for owner in auth problem submission; do
    [[ -f "$state/$owner-runtime.env" ]] || : > "$state/$owner-runtime.env"
done
: > "$run_dir/receipt.json"
"${compose[@]}" up -d --wait postgres
container=$("${compose[@]}" ps -q postgres)
[[ "$container" =~ ^[a-f0-9]{64}$ ]] || die "Expected exactly one healthy PostgreSQL container."
volume=$("${docker_cmd[@]}" inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$container")
[[ "$volume" == "volume:$volume_name" ]] || die "PostgreSQL is not using the selected project's data volume."
docker_labels=$("${docker_cmd[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}:{{index .Config.Labels "com.docker.compose.service"}}:{{.Config.Image}}' "$container")
[[ "$docker_labels" == "$project:postgres:postgres:15.6-alpine" ]] || die "Unexpected PostgreSQL container owner or image."
binding=$(read_volume_binding) || die "Unexpected local PostgreSQL volume."

persist() {
    sync -f "$1"
    mv -f -- "$1" "$2"
    sync -f "$state"
}
if [[ -f "$state/docker-binding" ]]; then
    [[ $(<"$state/docker-binding") == "$binding" ]] || die "The enrolled Docker engine or PostgreSQL volume has changed."
else
    printf '%s\n' "$binding" > "$state/docker-binding.next"
    persist "$state/docker-binding.next" "$state/docker-binding"
fi
if [[ ! -f "$state/instance" ]]; then
    cp /proc/sys/kernel/random/uuid "$state/instance.next"
    persist "$state/instance.next" "$state/instance"
fi
instance=$(<"$state/instance")

if [[ ! -f "$state/enrollment.json" ]]; then
    admin=$("${docker_cmd[@]}" exec "$container" sh -c 'printf "%s" "$POSTGRES_USER"')
    binary="/tmp/astracode-migration-$ASTRA_MIGRATION_RUN"
    "${docker_cmd[@]}" cp "$run_dir/migrator" "$container:$binary"
    for owner in auth problem submission; do
        if [[ ! -f "$state/$owner-credentials" ]]; then
            { openssl rand -hex 32; openssl rand -hex 32; } > "$state/$owner-credentials.next"
            persist "$state/$owner-credentials.next" "$state/$owner-credentials"
        fi
        mapfile -t passwords < "$state/$owner-credentials"
        [[ "${passwords[0]}" =~ ^[a-f0-9]{64}$ && "${passwords[1]}" =~ ^[a-f0-9]{64}$ ]] || die "Invalid enrollment credentials."
        if [[ ! -f "$state/$owner-target.json" ]]; then
            printf '{"migrator":"%s","runtime":"%s"}\n' "${passwords[@]}" |
                "${docker_cmd[@]}" exec -i "$container" "$binary" bootstrap --owner "$owner" \
                --instance "$instance" --admin "$admin" > "$state/$owner-target.next"
            persist "$state/$owner-target.next" "$state/$owner-target.json"
        fi
        printf 'DATABASE_USER=%s_app\nDATABASE_PASSWORD=%s\n' "$owner" "${passwords[1]}" > "$state/$owner-runtime.next"
        persist "$state/$owner-runtime.next" "$state/$owner-runtime.env"
    done
    "${docker_cmd[@]}" exec "$container" rm -f "$binary"
    jq -s . "$state/auth-target.json" "$state/problem-target.json" "$state/submission-target.json" > "$state/enrollment.next"
    IFS= read -r auth < "$state/auth-credentials"
    IFS= read -r problem < "$state/problem-credentials"
    IFS= read -r submission < "$state/submission-credentials"
    printf '{"auth":"%s","problem":"%s","submission":"%s"}\n' "$auth" "$problem" "$submission" > "$state/migration-passwords.next"
    persist "$state/migration-passwords.next" "$state/migration-passwords.json"
    persist "$state/enrollment.next" "$state/enrollment.json"
fi

verify_checkout() {
    [[ $(stage "$run_dir/recheck.json" | jq -er .digest) == "$ASTRA_MIGRATION_BUNDLE" ]] ||
        die "The migration inputs changed during launch. Start a fresh run."
}
verify_receipt() {
    jq -e --arg run "$ASTRA_MIGRATION_RUN" --arg bundle "$ASTRA_MIGRATION_BUNDLE" --arg instance "$instance" \
        '.run == $run and .bundle == $bundle and .instance == $instance and
         [.targets[].owner] == ["auth","problem","submission"]' "$run_dir/receipt.json" >/dev/null
}

if [[ "$action" == up ]]; then
    [[ -f "$GATEWAY_JWK_FILE" ]] || die "Generate the local Envoy JWK before launching the Compose stack."
    "${compose[@]}" --profile dev --profile worker build
    verify_checkout
    "${compose[@]}" --profile dev --profile worker up --no-build -d --wait
    verify_receipt
    exit 0
fi

export ASTRACODE_MIGRATION_RUN="$ASTRA_MIGRATION_RUN" ASTRACODE_MIGRATION_BUNDLE="$ASTRA_MIGRATION_BUNDLE"
export ASTRACODE_MIGRATION_RECEIPT="$run_dir/receipt.json"
"$run_dir/migrator" apply --state-dir "$state" --snapshot "$run_dir/bundle.json" \
    --tool-sha256 "$ASTRA_MIGRATION_TOOL_SHA" --bundle "$ASTRA_MIGRATION_BUNDLE" \
    --enrollment "$state/enrollment.json" --port "${ASTRA_DEV_POSTGRES_PORT:-5432}" \
    --approve-dirty "${ASTRACODE_APPROVE_DIRTY_BUNDLE:-}" --reconcile="${ASTRACODE_RECONCILE_MIGRATIONS:-false}" \
    --run "$ASTRA_MIGRATION_RUN" --receipt "$ASTRACODE_MIGRATION_RECEIPT" < "$state/migration-passwords.json"
verify_receipt
verify_checkout

auth_grpc_port=${ASTRA_DEV_AUTH_GRPC_PORT:-9091}
problem_grpc_port=${ASTRA_DEV_PROBLEM_GRPC_PORT:-9092}
run_go() (
    owner=$1
    shift
    set -a
    source "$SERVICE_ENV_FILE"
    source "$state/$owner-runtime.env"
    set +a
    export DATABASE_HOST=127.0.0.1 DATABASE_PORT="${ASTRA_DEV_POSTGRES_PORT:-5432}"
    export REDIS_HOST=127.0.0.1 REDIS_PORT="${ASTRA_DEV_REDIS_PORT:-6379}"
    export MINIO_ENDPOINT="127.0.0.1:${ASTRA_DEV_MINIO_PORT:-9000}"
    export KAFKA_BROKERS="127.0.0.1:${ASTRA_DEV_KAFKA_PORT:-9094}"
    export SMTP_HOST=127.0.0.1 SMTP_PORT="${ASTRA_DEV_SMTP_PORT:-1025}"
    export AUTH_GRPC_ADDRESS="127.0.0.1:$auth_grpc_port" PROBLEM_GRPC_ADDRESS="127.0.0.1:$problem_grpc_port"
    case "$owner" in
        auth) export SERVER_PORT="${ASTRA_DEV_AUTH_HTTP_PORT:-8081}" SERVER_GRPC_PORT="$auth_grpc_port" ;;
        problem) export SERVER_PORT="${ASTRA_DEV_PROBLEM_HTTP_PORT:-8082}" SERVER_GRPC_PORT="$problem_grpc_port" ;;
        submission) export SERVER_PORT="${ASTRA_DEV_SUBMISSION_HTTP_PORT:-8083}" ;;
    esac
    export ASTRACODE_LOCAL_CONFIG="$root/services/$owner/config"
    cd "$root/services/$owner"
    exec "$@"
)

if [[ "$action" == seed-tags ]]; then
    run_go problem go run ./cmd/seed-tags -config "$root/services/problem/config"
    exit 0
fi
"${compose[@]}" --profile dev up -d --wait redis minio kafka mailhog
"${compose[@]}" up --exit-code-from kafka-init --no-deps kafka-init
for owner in auth problem submission; do
    (cd "services/$owner" && go build -o "$run_dir/$owner" ./cmd/server)
done
verify_checkout
pids=()
trap '((${#pids[@]} == 0)) || kill "${pids[@]}" 2>/dev/null || true' EXIT
for owner in auth problem submission; do
    run_go "$owner" "$run_dir/$owner" 9>&- &
    pids+=("$!")
done
for port in "${ASTRA_DEV_AUTH_HTTP_PORT:-8081}" "${ASTRA_DEV_PROBLEM_HTTP_PORT:-8082}" "${ASTRA_DEV_SUBMISSION_HTTP_PORT:-8083}"; do
    for _ in {1..60}; do
        curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null && break
        sleep .5
    done
    curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null || die "Direct Go service on port $port did not start."
done
flock -u 9
wait -n
