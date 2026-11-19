#!/usr/bin/env bash
set -Eeuo pipefail

# Judge Compose and config are node-owned operational files. Deployment only
# creates a temporary image override; it never rewrites either external file.
readonly JUDGE_COMPOSE="${ASTRACODE_JUDGE_COMPOSE:-/etc/astracode/judge-node.compose.yml}"
readonly JUDGE_CONFIG="${ASTRACODE_JUDGE_CONFIG:-/etc/astracode/judge/config.yaml}"
readonly IMAGE_ROOT="${ASTRACODE_JUDGE_IMAGE_ROOT:-ghcr.io/nvawntien/go-judge-system}"
readonly STATE_DIR="${ASTRACODE_JUDGE_STATE_DIR:-/opt/astracode/.deploy/judge}"
readonly CURRENT_TAG_FILE="$STATE_DIR/current-image-tag"
readonly PREVIOUS_TAG_FILE="$STATE_DIR/previous-image-tag"
readonly JUDGE_SERVICES=(go-judge judge-worker)
readonly SANDBOX_GRPC_READY_ATTEMPTS="${ASTRACODE_SANDBOX_GRPC_READY_ATTEMPTS:-30}"
readonly SANDBOX_GRPC_READY_INTERVAL_SECONDS="${ASTRACODE_SANDBOX_GRPC_READY_INTERVAL_SECONDS:-1}"

usage() {
  echo "Use the protected production workflow for Judge activation and paired rollback." >&2
}

valid_tag() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]
}

release_tag_from_image() {
  local image_ref="${1%@*}"
  local tag

  if [[ "$image_ref" != *:* ]]; then
    return 1
  fi

  tag="${image_ref##*:}"
  valid_tag "$tag" || return 1
  printf '%s\n' "$tag"
}

detect_current_release() {
  local state_tag=""
  local container image tag runtime_tag=""

  for container in judge_worker judge_sandbox; do
    if ! image="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null)"; then
      echo "Cannot inspect running Judge release container: $container" >&2
      return 1
    fi

    if ! tag="$(release_tag_from_image "$image")"; then
      echo "Container $container does not use a valid semantic release image: $image" >&2
      return 1
    fi

    if [[ -n "$runtime_tag" && "$runtime_tag" != "$tag" ]]; then
      echo "Running Judge release containers disagree on their image tag: $runtime_tag != $tag" >&2
      return 1
    fi
    runtime_tag="$tag"
  done

  if [[ -z "$runtime_tag" ]]; then
    echo "Cannot determine the currently active Judge release." >&2
    return 1
  fi

  if [[ -e "$CURRENT_TAG_FILE" ]]; then
    if [[ ! -r "$CURRENT_TAG_FILE" ]]; then
      echo "Deployment state file is unreadable: $CURRENT_TAG_FILE" >&2
      return 1
    fi
    state_tag="$(tr -d '\r\n' <"$CURRENT_TAG_FILE")"
    if ! valid_tag "$state_tag"; then
      echo "Deployment state file does not contain a valid semantic release tag: $CURRENT_TAG_FILE" >&2
      return 1
    fi
    if [[ "$state_tag" != "$runtime_tag" ]]; then
      echo "Deployment state drift: Judge state=$state_tag runtime=$runtime_tag" >&2
      return 1
    fi
  fi

  printf '%s\n' "$runtime_tag"
}

require_readable_file() {
  local path="$1"
  local description="$2"
  if [[ ! -r "$path" ]]; then
    echo "Missing or unreadable $description: $path" >&2
    exit 1
  fi
}

operation="${1:-}"
if [[ "$operation" == --preflight || "$operation" == --suspend || "$operation" == --activate ]]; then
  if [[ ${ASTRACODE_PROTECTED_ROLLOUT:-0} != 1 ]]; then
    usage
    exit 2
  fi
fi
case "$operation" in
  --preflight) [[ $# -eq 3 ]] || exit 2 ;;
  --suspend) [[ $# -eq 2 || $# -eq 5 ]] || exit 2 ;;
  --activate) [[ $# -eq 8 ]] || exit 2 ;;
  *)
    if [[ ${ASTRACODE_JUDGE_DEPLOY_DRY_RUN:-0} != 1 &&
          ! (${ASTRACODE_JUDGE_DEPLOY_TEST_LIB:-0} == 1 && "${BASH_SOURCE[0]}" != "$0") ]]; then
      usage
      exit 2
    fi
    ;;
esac
requested="${2:-$operation}"
if [[ -z "$requested" ]]; then
  usage
  exit 2
fi

if ! valid_tag "$requested"; then
  echo "Refusing non-release or mutable image tag: $requested" >&2
  exit 2
fi
if [[ "$operation" != --suspend ]]; then
  require_readable_file "$JUDGE_COMPOSE" "Judge Compose file"
  require_readable_file "$JUDGE_CONFIG" "Judge configuration"
fi

mkdir -p "$STATE_DIR"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/astracode-judge-deploy.XXXXXX")"
readonly tmp_dir
readonly image_override="$tmp_dir/images.yml"
trap 'rm -rf "$tmp_dir"' EXIT

write_image_override() {
  cat >"$image_override" <<EOF
services:
  go-judge:
    image: ${IMAGE_ROOT}/sandbox:${requested}
  judge-worker:
    image: ${IMAGE_ROOT}/judge-worker:${requested}
EOF
  chmod 0600 "$image_override"
}

compose() {
  docker compose \
    -f "$JUDGE_COMPOSE" \
    -f "$image_override" \
    "$@"
}

container_is_running() {
  local service="$1"
  local container_id running health
  container_id="$(compose ps -q "$service")" || return 1
  if [[ -z "$container_id" ]]; then
    echo "Required Judge service has no container: $service" >&2
    return 1
  fi

  running="$(docker inspect --format '{{.State.Running}}' "$container_id")" || return 1
  if [[ "$running" != "true" ]]; then
    echo "Required Judge service is not running: $service" >&2
    return 1
  fi

  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id")" || return 1
  if [[ -n "$health" && "$health" != "healthy" ]]; then
    echo "Required Judge service is not healthy: $service ($health)" >&2
    return 1
  fi
}

read_grpc_port() {
  local port
  port="$(awk '$1 == "grpc_port:" { print $2; exit }' "$JUDGE_CONFIG")"
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]] || ((port > 65535)); then
    echo "Unable to read a valid server.grpc_port from $JUDGE_CONFIG" >&2
    return 1
  fi
  printf '%s\n' "$port"
}

verify_listening_tcp_port() {
  local container_id="$1"
  local port="$2"
  local port_hex
  printf -v port_hex '%04X' "$port"
  docker exec "$container_id" sh -ec \
    "awk -v port='$port_hex' 'NR > 1 { split(\$2, address, \":\"); if (toupper(address[2]) == port && \$4 == \"0A\") found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6"
}

wait_for_listening_tcp_port() {
  local container_id="$1"
  local port="$2"
  local attempt
  if [[ ! "$SANDBOX_GRPC_READY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || [[ ! "$SANDBOX_GRPC_READY_INTERVAL_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    echo "Invalid sandbox gRPC readiness retry configuration" >&2
    return 1
  fi
  for ((attempt = 1; attempt <= SANDBOX_GRPC_READY_ATTEMPTS; attempt++)); do
    if verify_listening_tcp_port "$container_id" "$port"; then
      return 0
    fi
    if ((attempt < SANDBOX_GRPC_READY_ATTEMPTS)); then
      sleep "$SANDBOX_GRPC_READY_INTERVAL_SECONDS"
    fi
  done
  echo "Sandbox gRPC port did not become ready: port=$port attempts=$SANDBOX_GRPC_READY_ATTEMPTS" >&2
  return 1
}

# Shell tests source only the readiness functions. Normal execution never sets
# this flag, so deployment behavior and ownership checks remain unchanged.
if [[ "${ASTRACODE_JUDGE_DEPLOY_TEST_LIB:-0}" == "1" && "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

verify_sandbox_http() {
  local sandbox_id
  sandbox_id="$(compose ps -q go-judge)" || return 1
  # Executorserver has no repository-defined health path. Accepting either a
  # success or an HTTP error response still proves its local HTTP listener is
  # reachable without publishing port 5050. wget uses status 8 for HTTP 4xx/5xx.
  docker exec "$sandbox_id" sh -ec \
    'wget -S -T 5 -O /dev/null http://127.0.0.1:5050/ >/dev/null 2>&1 || test "$?" -eq 8'
}

verify_sandbox_grpc() {
  local sandbox_id
  sandbox_id="$(compose ps -q go-judge)" || return 1
  # executorserver v1.7.1 does not expose grpc_health_v1. A listening private
  # TCP socket is the strongest dependency-free readiness primitive available.
  wait_for_listening_tcp_port "$sandbox_id" 5051
}

verify_services() {
  local worker_id grpc_port
  container_is_running go-judge || return 1
  container_is_running judge-worker || return 1
  verify_sandbox_http || return 1
  verify_sandbox_grpc || return 1

  worker_id="$(compose ps -q judge-worker)" || return 1
  grpc_port="$(read_grpc_port)" || return 1
  wait_for_listening_tcp_port "$worker_id" "$grpc_port"
}

worker_id() {
  local ids named
  ids="$(docker ps --all --no-trunc -q --filter label=com.docker.compose.service=judge-worker)" || return 1
  if [[ -z "$ids" ]]; then
    return 0
  fi
  named="$(docker inspect --format '{{.Id}}' judge_worker)" || return 1
  if [[ "$ids" != "$named" ]]; then
    echo "Expected exactly one managed Judge Worker container." >&2
    return 1
  fi
  printf '%s\n' "$named"
}

worker_stopped() {
  local id state
  id="$(worker_id)" || return 1
  [[ -n "$id" ]] || return 0
  state="$(docker inspect --format '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}' "$id")" || return 1
  [[ "$state" == "exited no" || "$state" == "created no" ]]
}

suspend_worker() {
  local id
  id="${1:-}"
  if [[ -z "$id" ]]; then
    id="$(worker_id)" || return 1
  fi
  if [[ -n "$id" ]] && ! worker_stopped; then
    # Keep the old container stopped even across a Docker daemon restart.
    # Compose recreation restores the node-owned policy when judging resumes.
    docker update --restart=no "$id" >/dev/null || return 1
    docker stop --signal SIGTERM --timeout "${COMPOSE_STOP_TIMEOUT:-30}" "$id" >/dev/null || return 1
  fi
  if ! worker_stopped; then
    echo "Worker suspension could not be verified." >&2
    return 1
  fi
}

planned_settings() {
  compose config --format json | "$1" worker-settings "$JUDGE_CONFIG" planned
}

running_settings() {
  local id="$1" probe="$2" started settings
  if [[ "$(docker inspect --format '{{.State.Running}}' "$id")" != true ]]; then
    echo "Cannot verify startup settings: Judge Worker is not running." >&2
    return 1
  fi
  started="$(docker inspect --format '{{.State.StartedAt}}' "$id")" || return 1
  if ! settings="$(timeout 10 docker exec "$id" cat \
      /proc/sys/kernel/random/boot_id /proc/1/stat /tmp/astracode-judge-worker-runtime.json \
      | "$probe" worker-settings "$JUDGE_CONFIG" running)"; then
    echo "Cannot verify Judge Worker startup settings. Keep the current release and investigate runtime identity." >&2
    return 1
  fi
  if [[ -z "$started" || "$(docker inspect --format '{{.State.StartedAt}}' "$id")" != "$started" ||
        "$(docker inspect --format '{{.State.Running}}' "$id")" != true ]]; then
    echo "Judge Worker restarted or stopped while verifying its startup settings." >&2
    return 1
  fi
  printf '%s\n%s\n' "$settings" "$started"
}

suspend_verified_worker() {
  local probe="$1" expected_id="$2" expected="$3" id evidence started
  id="$(worker_id)" || return 1
  if [[ -z "$id" || "$id" != "$expected_id" ]]; then
    echo "Judge Worker container changed after rollout preflight." >&2
    return 1
  fi
  evidence="$(running_settings "$id" "$probe")" || return 1
  if [[ "${evidence%$'\n'*}" != "$expected" ]]; then
    echo "Judge Worker runtime settings changed after rollout preflight." >&2
    return 1
  fi
  started="${evidence##*$'\n'}"
  suspend_worker "$id" || return 1
  if [[ "$(worker_id)" != "$id" || "$(docker inspect --format '{{.State.StartedAt}}' "$id")" != "$started" ]]; then
    echo "Judge Worker identity changed during suspension. Kafka group identity is uncertain." >&2
    return 1
  fi
}

activate() {
  local probe="$1" settings="$2" problem planned id evidence
  shift 2
  if ! worker_stopped; then
    echo "Judge activation requires confirmed Worker suspension." >&2
    return 1
  fi
  planned="$(planned_settings "$probe")" || return 1
  if [[ "$planned" != "$settings" ]]; then
    echo "Judge configuration changed after rollout preflight." >&2
    return 1
  fi
  compose config --quiet || return 1
  compose pull "${JUDGE_SERVICES[@]}" || return 1
  compose up -d --wait --wait-timeout 120 --no-deps --force-recreate --timeout "${COMPOSE_STOP_TIMEOUT:-30}" go-judge || return 1
  verify_sandbox_http || return 1
  verify_sandbox_grpc || return 1

  # Recheck through the Judge Node's configured private endpoint immediately
  # before starting the process that joins the Kafka group.
  problem="${settings%% *}"
  "$probe" metadata "$problem" "$@" || return 1
  compose up -d --wait --wait-timeout 120 --no-deps --force-recreate --timeout "${COMPOSE_STOP_TIMEOUT:-30}" judge-worker || return 1
  compose ps "${JUDGE_SERVICES[@]}" || return 1
  verify_services || return 1
  id="$(worker_id)" || return 1
  evidence="$(running_settings "$id" "$probe")" || return 1
  if [[ "${evidence%$'\n'*}" != "$settings" ]]; then
    echo "Activated Judge Worker runtime settings differ from the verified settings." >&2
    return 1
  fi
}

write_state() {
  local path="$1"
  local value="$2"
  printf '%s\n' "$value" >"$path.tmp" || return 1
  mv "$path.tmp" "$path"
}

persist_release() {
  local previous="$1"
  if [[ "$previous" != "$requested" ]]; then
    write_state "$PREVIOUS_TAG_FILE" "$previous" || return 1
  fi
  write_state "$CURRENT_TAG_FILE" "$requested"
}

write_image_override

if [[ "${ASTRACODE_JUDGE_DEPLOY_DRY_RUN:-0}" == "1" ]]; then
  cat "$image_override"
  exit 0
fi

exec 9>"$STATE_DIR/rollout.lock"
if ! flock -n 9; then
  echo "A Judge operation is already running or its lock is unavailable." >&2
  exit 1
fi

case "$operation" in
  --preflight)
    previous="$(detect_current_release)"
    id="$(worker_id)"
    [[ -n "$id" ]] || { echo "No running Judge Worker to verify." >&2; exit 1; }
    evidence="$(running_settings "$id" "$3")"
    actual="${evidence%$'\n'*}"
    planned="$(planned_settings "$3")"
    if [[ "$actual" != "$planned" ]]; then
      echo "Running and planned Worker endpoints, group or topic disagree." >&2
      exit 1
    fi
    printf '%s\n%s\n%s\n' "$previous" "$actual" "$id"
    ;;
  --suspend)
    if [[ $# -eq 5 ]]; then
      suspend_verified_worker "${@:3}"
    else
      suspend_worker
    fi
    ;;
  --activate)
    previous="$3"
    valid_tag "$previous"
    echo "Deploying verified Judge release $requested"
    if ! activate "${@:4}" || ! persist_release "$previous"; then
      echo "Judge activation failed for $requested." >&2
      suspend_worker || echo "Could not verify Worker suspension. Operator intervention is required." >&2
      exit 1
    fi
    echo "Judge Node $requested is healthy."
    ;;
esac
