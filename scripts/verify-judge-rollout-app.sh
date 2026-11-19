#!/usr/bin/env bash
set -Eeuo pipefail

mode="$1"
problem_address="$2"
kafka_address="$3"
group="$4"
topic="$5"
shift 5

singleton() {
  local service="$1" name="$2" ids named
  ids="$(docker ps --no-trunc -q --filter "label=com.docker.compose.service=$service")"
  named="$(docker inspect --format '{{.Id}}' "$name")"
  if [[ -z "$ids" || "$ids" != "$named" ]]; then
    echo "Expected exactly one running $service container named $name." >&2
    return 1
  fi
  printf '%s\n' "$named"
}

assert_bindings() {
  local problem_port kafka_port
  problem_port="$(docker port "$problem_id" 9092/tcp)" || return 1
  kafka_port="$(docker port "$kafka_id" 9094/tcp)" || return 1
  if [[ "$problem_port" != "$problem_address" || "$kafka_port" != "$kafka_address" ]]; then
    echo "Worker endpoints must match the App Node's single private published Problem and Kafka ports." >&2
    return 1
  fi
}

check_problem() {
  local tag="$1" image running_image
  image="$(docker inspect --format '{{.Config.Image}}' "$problem_id")" || return 1
  running_image="$(docker inspect --format '{{.Image}}' "$problem_id")" || return 1
  if [[ "$image" != */problem-service:"$tag" ||
        "$running_image" != "$(docker image inspect --format '{{.Id}}' "$image")" ]]; then
    echo "The active Problem Service image does not match release $tag." >&2
    return 1
  fi
}

recheck_topology() {
  [[ "$(singleton problem-service judge_problem)" == "$problem_id" ]] || return 1
  [[ "$(singleton kafka judge_kafka)" == "$kafka_id" ]] || return 1
  assert_bindings
}

problem_id="$(singleton problem-service judge_problem)"
kafka_id="$(singleton kafka judge_kafka)"
assert_bindings

app_workers="$(docker ps -q --filter label=com.docker.compose.service=judge-worker)"
if [[ -n "$app_workers" ]]; then
  echo "An unexpected Judge Worker is running on the App Node." >&2
  exit 1
fi

if [[ "$mode" == preflight ]]; then
  exit 0
fi
if [[ "$mode" == legacy-preflight ]]; then
  tag="$1" probe="$2" peer="$3"
  shift 3
  check_problem "$tag"
  "$probe" legacy-metadata "$problem_address" "$@" >&2
  recheck_topology
  timeout 15 "$probe" kafka-member "$kafka_address" "$group" "$topic" "$peer"
  exit
fi

group_is_empty() {
  local description
  description="$(timeout 10 docker exec "$kafka_id" kafka-consumer-groups.sh \
    --bootstrap-server 127.0.0.1:9092 --timeout 5000 --describe --group "$group" --state)" || return 1
  awk -v group="$group" '$1 == group && $(NF-1) == "Empty" && $NF == "0" { found++ }
    END { exit found != 1 }' <<<"$description"
}

for ((attempt = 1; attempt <= 15; attempt++)); do
  if group_is_empty; then
    break
  fi
  if ((attempt == 15)); then
    echo "Kafka group $group did not report Empty with zero members. Keep judging suspended." >&2
    exit 1
  fi
  sleep 1
done

timeout 10 docker exec "$kafka_id" kafka-topics.sh --bootstrap-server 127.0.0.1:9092 \
  --describe --topic "$topic" >/dev/null

if [[ "$mode" == ready || "$mode" == legacy-ready ]]; then
  tag="$1" probe="$2"
  shift 2
  check_problem "$tag"
  command=metadata
  if [[ "$mode" == legacy-ready ]]; then command=legacy-metadata; fi
  "$probe" "$command" "$problem_address" "$@"
  recheck_topology
elif [[ "$mode" != idle ]]; then
  echo "Unknown App readiness check: $mode" >&2
  exit 2
fi
