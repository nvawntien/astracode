#!/usr/bin/env bash
# Safe launcher for one-POST-per-distinct-identity Submission admission tests.
set -euo pipefail

usage() { cat <<'EOF'
Usage:
  Burst mode (default):
    run-submission-admission.sh --base-url URL --users-file FILE --user-count N \
      --burst-vus N --requests-per-vu N --problem-id ID --problem-slug SLUG \
      --source-file FILE --max-duration Ns|Nm|Nh [common options]

  Arrival mode:
    run-submission-admission.sh --mode arrival --base-url URL --users-file FILE \
      --user-count N --rate N --duration Ns|Nm|Nh --pre-allocated-vus N \
      --max-vus N --problem-id ID --problem-slug SLUG --source-file FILE \
      [common options]

Common options:
  --language CPP|GO|PYTHON|JAVA
  --allow-remote --confirm-target-host HOST
  --system-config FILE
  --output DIR
  --run-id ID
EOF
}

mode=burst
base_url=
users_file=
user_count=
burst_vus=
requests_per_vu=
arrival_rate=
arrival_duration=
pre_allocated_vus=
max_vus=
problem_id=
problem_slug=
language=CPP
source_file=
max_duration=
system_config=
output=
run_id=
allow_remote=false
confirm_host=

while (($#)); do
  case "$1" in
    --mode|--base-url|--users-file|--user-count|--burst-vus|--requests-per-vu|--rate|--duration|--pre-allocated-vus|--max-vus|--problem-id|--problem-slug|--language|--source-file|--max-duration|--system-config|--output|--run-id|--confirm-target-host)
      key=$1
      shift
      (($#)) || { usage >&2; exit 2; }
      value=$1
      shift
      case "$key" in
        --mode) mode=$value ;;
        --base-url) base_url=$value ;;
        --users-file) users_file=$value ;;
        --user-count) user_count=$value ;;
        --burst-vus) burst_vus=$value ;;
        --requests-per-vu) requests_per_vu=$value ;;
        --rate) arrival_rate=$value ;;
        --duration) arrival_duration=$value ;;
        --pre-allocated-vus) pre_allocated_vus=$value ;;
        --max-vus) max_vus=$value ;;
        --problem-id) problem_id=$value ;;
        --problem-slug) problem_slug=$value ;;
        --language) language=$value ;;
        --source-file) source_file=$value ;;
        --max-duration) max_duration=$value ;;
        --system-config) system_config=$value ;;
        --output) output=$value ;;
        --run-id) run_id=$value ;;
        --confirm-target-host) confirm_host=$value ;;
      esac
      ;;
    --allow-remote)
      allow_remote=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "submission-admission: unknown argument $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v k6 >/dev/null || {
  echo 'submission-admission: k6 is required; install k6 separately' >&2
  exit 127
}

[[ $mode == burst || $mode == arrival ]] || {
  echo 'submission-admission: --mode must be burst or arrival' >&2
  exit 2
}

[[ $base_url && $users_file && $user_count && $problem_id && $problem_slug && $language && $source_file ]] || {
  echo 'submission-admission: required common arguments missing' >&2
  exit 2
}

[[ $user_count =~ ^[1-9][0-9]*$ && $problem_id =~ ^[1-9][0-9]*$ ]] || {
  echo 'submission-admission: --user-count and --problem-id must be positive integers' >&2
  exit 2
}

(( user_count <= 100000 )) || {
  echo 'submission-admission: --user-count exceeds benchmark identity safety limit' >&2
  exit 2
}

case "$mode" in
  burst)
    [[ $burst_vus && $requests_per_vu && $max_duration ]] || {
      echo 'submission-admission: burst mode requires --burst-vus, --requests-per-vu, and --max-duration' >&2
      exit 2
    }

    [[ $burst_vus =~ ^[1-9][0-9]*$ && $requests_per_vu =~ ^[1-9][0-9]*$ ]] || {
      echo 'submission-admission: burst VU values must be positive integers' >&2
      exit 2
    }

    (( burst_vus <= user_count && requests_per_vu <= user_count )) || {
      echo 'submission-admission: burst dimensions cannot exceed --user-count' >&2
      exit 2
    }

    (( burst_vus * requests_per_vu == user_count )) || {
      echo 'submission-admission: --burst-vus * --requests-per-vu must equal --user-count' >&2
      exit 2
    }

    [[ $max_duration =~ ^[1-9][0-9]*[smh]$ ]] || {
      echo 'submission-admission: --max-duration must be a bounded whole Ns, Nm, or Nh value' >&2
      exit 2
    }
    ;;

  arrival)
    [[ $arrival_rate && $arrival_duration && $pre_allocated_vus && $max_vus ]] || {
      echo 'submission-admission: arrival mode requires --rate, --duration, --pre-allocated-vus, and --max-vus' >&2
      exit 2
    }

    [[ $arrival_rate =~ ^[1-9][0-9]*$ &&
       $pre_allocated_vus =~ ^[1-9][0-9]*$ &&
       $max_vus =~ ^[1-9][0-9]*$ ]] || {
      echo 'submission-admission: arrival rate/VU values must be positive integers' >&2
      exit 2
    }

    [[ $arrival_duration =~ ^[1-9][0-9]*[smh]$ ]] || {
      echo 'submission-admission: --duration must be a bounded whole Ns, Nm, or Nh value' >&2
      exit 2
    }

    (( arrival_rate <= 100000 &&
       pre_allocated_vus <= 100000 &&
       max_vus <= 100000 )) || {
      echo 'submission-admission: arrival load parameters exceed safety limit' >&2
      exit 2
    }

    (( pre_allocated_vus <= max_vus )) || {
      echo 'submission-admission: --pre-allocated-vus cannot exceed --max-vus' >&2
      exit 2
    }

    (( max_vus <= user_count )) || {
      echo 'submission-admission: --max-vus cannot exceed --user-count' >&2
      exit 2
    }

    case "${arrival_duration: -1}" in
      s) duration_seconds=${arrival_duration%s} ;;
      m) duration_seconds=$(( ${arrival_duration%m} * 60 )) ;;
      h) duration_seconds=$(( ${arrival_duration%h} * 3600 )) ;;
      *)
        echo 'submission-admission: invalid --duration' >&2
        exit 2
        ;;
    esac

    scheduled_iterations=$(( arrival_rate * duration_seconds ))

    (( scheduled_iterations <= user_count )) || {
      echo "submission-admission: arrival workload schedules ${scheduled_iterations} iterations but only ${user_count} unique identities were requested" >&2
      exit 2
    }
    ;;
esac

[[ $problem_slug =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo 'submission-admission: --problem-slug is invalid' >&2
  exit 2
}

[[ $language =~ ^(CPP|GO|PYTHON|JAVA)$ ]] || {
  echo 'submission-admission: --language is unsupported' >&2
  exit 2
}

[[ -f $users_file ]] || {
  echo 'submission-admission: --users-file must be an existing regular file' >&2
  exit 2
}

[[ -f $source_file ]] || {
  echo 'submission-admission: --source-file must be an existing regular file' >&2
  exit 2
}

[[ -z $system_config || -f $system_config ]] || {
  echo 'submission-admission: --system-config must be a regular file' >&2
  exit 2
}

python3 - "$users_file" "$user_count" <<'PY'
import json
import sys
try:
    with open(sys.argv[1], encoding='utf-8') as handle:
        data = json.load(handle)
    users = data['users']
    count = int(sys.argv[2])
    valid = data.get('schema_version') == 1 and isinstance(users, list) and len(users) >= count
    valid = valid and all(isinstance(item, dict) and isinstance(item.get('alias'), str) and item['alias'] and isinstance(item.get('cookies'), dict) and isinstance(item['cookies'].get('access_token'), str) and item['cookies']['access_token'] for item in users[:count])
except Exception:
    valid = False
if not valid:
    raise SystemExit(2)
PY
[[ $? -eq 0 ]] || { echo 'submission-admission: credential file schema or requested sessions are invalid' >&2; exit 2; }

parsed=$(python3 - "$base_url" <<'PY'
from urllib.parse import urlparse
import sys
u=urlparse(sys.argv[1]); print(f"{u.scheme}|{u.hostname or ''}|{u.path}|{u.query}|{u.fragment}|{u.username or ''}")
PY
)
IFS='|' read -r scheme host url_path query fragment username <<<"$parsed"
[[ $host && -z $query && -z $fragment && -z $username && ( -z $url_path || $url_path == / ) ]] || { echo 'submission-admission: invalid base URL' >&2; exit 2; }
loopback=false; [[ $host == localhost || $host == 127.0.0.1 || $host == ::1 ]] && loopback=true
if [[ $loopback == false ]]; then
  [[ $scheme == https && $allow_remote == true && $confirm_host == "$host" ]] || { echo 'submission-admission: remote targets require HTTPS, --allow-remote, and exact --confirm-target-host' >&2; exit 2; }
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
run_id=${run_id:-SUBMISSION-R$(date -u +%Y%m%dT%H%M%SZ)}
[[ $run_id =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'submission-admission: --run-id is invalid' >&2; exit 2; }
output=${output:-"$root/tools/benchmark/api/bench-results/$run_id"}
[[ ! -e $output ]] || { echo 'submission-admission: output directory already exists' >&2; exit 2; }
mkdir -p -m 700 "$output"
if [[ -n $system_config ]]; then system_config=$(cd "$(dirname "$system_config")" && pwd)/$(basename "$system_config"); fi
users_file=$(cd "$(dirname "$users_file")" && pwd)/$(basename "$users_file")
source_file=$(cd "$(dirname "$source_file")" && pwd)/$(basename "$source_file")
git_sha=$(git -C "$root" rev-parse HEAD); git_dirty=false; git -C "$root" diff --quiet || git_dirty=true
exec k6 run \
  -e "MODE=$mode" \
  -e "BASE_URL=${base_url%/}" -e "USERS_FILE=$users_file" -e "USER_COUNT=$user_count" \
  -e "BURST_VUS=$burst_vus" -e "REQUESTS_PER_VU=$requests_per_vu" \
  -e "ARRIVAL_RATE=$arrival_rate" -e "ARRIVAL_DURATION=$arrival_duration" \
  -e "PRE_ALLOCATED_VUS=$pre_allocated_vus" -e "MAX_VUS=$max_vus" \
  -e "PROBLEM_ID=$problem_id" -e "PROBLEM_SLUG=$problem_slug" -e "LANGUAGE=$language" \
  -e "SOURCE_FILE=$source_file" -e "MAX_DURATION=$max_duration" -e "SYSTEM_CONFIG_PATH=$system_config" \
  -e "OUTPUT_DIR=$output" -e "RUN_ID=$run_id" -e "STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -e "GIT_SHA=$git_sha" -e "GIT_DIRTY=$git_dirty" \
  "$(dirname "${BASH_SOURCE[0]}")/submission-admission.js"
