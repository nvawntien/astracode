// AstraCode Submission admission benchmark. It is intentionally separate from
// api.js: every selected authenticated identity makes one Submission POST. It
// does not observe tickets, SSE, terminal verdicts, or Judge drain.
import http from 'k6/http';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const baseURL = requiredEnv('BASE_URL');
const outputDir = requiredEnv('OUTPUT_DIR');
const mode = (__ENV.MODE || 'burst').trim().toLowerCase();
if (mode !== 'burst' && mode !== 'arrival') {
  throw new Error('MODE must be burst or arrival');
}

const userCount = positiveInteger(requiredEnv('USER_COUNT'), 'USER_COUNT');

const burstVUs = mode === 'burst'
  ? positiveInteger(requiredEnv('BURST_VUS'), 'BURST_VUS')
  : null;
const requestsPerVU = mode === 'burst'
  ? positiveInteger(requiredEnv('REQUESTS_PER_VU'), 'REQUESTS_PER_VU')
  : null;
const maxDuration = mode === 'burst'
  ? requiredEnv('MAX_DURATION')
  : null;

const arrivalRate = mode === 'arrival'
  ? positiveInteger(requiredEnv('ARRIVAL_RATE'), 'ARRIVAL_RATE')
  : null;
const arrivalDuration = mode === 'arrival'
  ? requiredEnv('ARRIVAL_DURATION')
  : null;
const arrivalDurationSeconds = mode === 'arrival'
  ? boundedDurationSeconds(arrivalDuration, 'ARRIVAL_DURATION')
  : null;
const preAllocatedVUs = mode === 'arrival'
  ? positiveInteger(requiredEnv('PRE_ALLOCATED_VUS'), 'PRE_ALLOCATED_VUS')
  : null;
const maxVUs = mode === 'arrival'
  ? positiveInteger(requiredEnv('MAX_VUS'), 'MAX_VUS')
  : null;

const problemID = positiveInteger(requiredEnv('PROBLEM_ID'), 'PROBLEM_ID');
const language = requiredEnv('LANGUAGE');
// This admission payload is immutable for the entire run. Keeping it in init
// context avoids JSON serialization in every arrival/burst hot-path request.
const submissionBody = JSON.stringify({
  problem_id: problemID,
  language,
  source_code: open(requiredEnv('SOURCE_FILE')),
});
const submissionURL = `${baseURL}/api/v1/submissions`;
const submissionHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};
const systemConfig = loadSystemConfig(__ENV.SYSTEM_CONFIG_PATH);

if (mode === 'burst' && burstVUs * requestsPerVU !== userCount) {
  throw new Error('BURST_VUS * REQUESTS_PER_VU must equal USER_COUNT');
}

if (mode === 'arrival' && preAllocatedVUs > maxVUs) {
  throw new Error('PRE_ALLOCATED_VUS cannot exceed MAX_VUS');
}

const intendedRequests = mode === 'burst'
  ? userCount
  : arrivalRate * arrivalDurationSeconds;

if (intendedRequests > userCount) {
  throw new Error('arrival workload requires more unique identities than USER_COUNT');
}

const users = new SharedArray('submission-admission-users', () => {
  const parsed = JSON.parse(open(requiredEnv('USERS_FILE')));
  if (!parsed || parsed.schema_version !== 1 || !Array.isArray(parsed.users) || parsed.users.length < userCount) {
    throw new Error('credential file does not satisfy requested user count');
  }
  return parsed.users.slice(0, userCount).map((user, index) => {
    if (!user || typeof user.alias !== 'string' || !user.alias || !user.cookies || typeof user.cookies.access_token !== 'string' || !user.cookies.access_token) {
      throw new Error(`credential entry ${index + 1} is invalid`);
    }
    // Do not retain refresh tokens in the k6 workload. Each request receives
    // only the corresponding identity's access cookie.
    return { alias: user.alias, accessToken: user.cookies.access_token };
  });
});

export const options = {
  scenarios: mode === 'burst'
    ? {
        one_submission_batch_per_vu: {
          executor: 'per-vu-iterations',
          vus: burstVUs,
          iterations: 1,
          maxDuration,
        },
      }
    : {
        one_submission_per_arrival: {
          executor: 'constant-arrival-rate',
          rate: arrivalRate,
          timeUnit: '1s',
          duration: arrivalDuration,
          preAllocatedVUs,
          maxVUs,
          gracefulStop: '30s',
        },
      },

  // Burst mode explicitly avoids k6 batch defaults. Arrival mode performs
  // exactly one HTTP request per iteration and therefore needs no batch knobs.
  ...(mode === 'burst'
    ? {
        batch: requestsPerVU,
        batchPerHost: requestsPerVU,
      }
    : {}),

  // handleSummary requests p(99), so make k6 retain it.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
  thresholds: {}, // reporting/generator integrity only; no capacity claim SLO.
};

const attempted = new Counter('submission_attempted');
const accepted = new Counter('submission_accepted_201');
const rateLimited = new Counter('submission_http_429');
const other4xx = new Counter('submission_other_4xx');
const server5xx = new Counter('submission_server_5xx');
const transportFailures = new Counter('submission_transport_failures');
const acceptanceRate = new Rate('submission_acceptance_rate');
// Keep transport evidence finite. A high-rate generator must not create a
// status/error-code metric object for every possible numeric value.
const errorClassCounters = {
  request_timeout: new Counter('submission_error_class_request_timeout'),
  dns_failure: new Counter('submission_error_class_dns_failure'),
  tls_failure: new Counter('submission_error_class_tls_failure'),
  connection_reset: new Counter('submission_error_class_connection_reset'),
  eof: new Counter('submission_error_class_eof'),
  tcp_connect_failure: new Counter('submission_error_class_tcp_connect_failure'),
  other_transport: new Counter('submission_error_class_other_transport'),
};
// Date.now() is sampled immediately before http.batch() in each VU. It is an
// observable local batch-invocation spread, not a claim about on-wire timing.
const batchInvocationEpochMS = new Trend('submission_batch_invocation_epoch_ms');

export default function () {
  if (mode === 'arrival') {
    runArrival();
    return;
  }
  runBurst();
}

function runBurst() {
  // k6 VU identifiers are one-based. One VU owns exactly one contiguous,
  // deterministic identity slice and has exactly one iteration.
  const start = (__VU - 1) * requestsPerVU;
  const requests = new Array(requestsPerVU);

  for (let offset = 0; offset < requestsPerVU; offset += 1) {
    const user = users[start + offset];
    if (!user) throw new Error('missing deterministic credential for VU slice');

    requests[offset] = {
      method: 'POST',
      url: submissionURL,
      body: submissionBody,
      params: {
        redirects: 0,
        headers: submissionHeaders,
        cookies: { access_token: user.accessToken },
      },
    };
  }

  attempted.add(requests.length);
  batchInvocationEpochMS.add(Date.now());

  let responses;
  try {
    responses = http.batch(requests);
  } catch (_) {
    for (let index = 0; index < requests.length; index += 1) {
      recordResponse(null);
    }
    return;
  }

  for (let index = 0; index < requests.length; index += 1) {
    recordResponse(responses[index]);
  }
}

function runArrival() {
  // iterationInTest is unique and zero-based across the scenario. A dropped
  // iteration never executes this function, so no credential is retried or
  // reused to compensate for generator-side drops.
  const index = exec.scenario.iterationInTest;

  if (!Number.isSafeInteger(index) || index < 0 || index >= intendedRequests) {
    throw new Error('arrival iteration index is outside deterministic credential range');
  }

  const user = users[index];
  if (!user) {
    throw new Error('missing deterministic credential for arrival iteration');
  }

  attempted.add(1);

  let response;
  try {
    response = http.post(
      submissionURL,
      submissionBody,
      {
        redirects: 0,
        headers: submissionHeaders,
        cookies: { access_token: user.accessToken },
      },
    );
  } catch (_) {
    recordResponse(null);
    return;
  }

  recordResponse(response);
}

function recordResponse(response) {
  const status = response && Number.isInteger(response.status) ? response.status : 0;
  const isAccepted = status === 201;
  acceptanceRate.add(isAccepted);
  if (isAccepted) {
    accepted.add(1);
  } else if (status === 0) {
    transportFailures.add(1);
    errorClassCounters[normalizedTransportError(response)].add(1);
  } else if (status === 429) {
    rateLimited.add(1);
  } else if (status >= 400 && status < 500) {
    other4xx.add(1);
  } else if (status >= 500 && status < 600) {
    server5xx.add(1);
  }
}

function normalizedTransportError(response) {
  if (response && Number(response.error_code) === 1050) return 'request_timeout';
  // k6 exposes an error string for diagnostics. Inspect it only to derive a
  // finite safe class; the raw value is never emitted in any artifact.
  const error = String((response && response.error) || '').toLowerCase();
  if (error.includes('dns') || error.includes('no such host')) return 'dns_failure';
  if (error.includes('tls') || error.includes('x509') || error.includes('certificate')) return 'tls_failure';
  if (error.includes('connection reset') || error.includes('reset by peer')) return 'connection_reset';
  if (error.includes('unexpected eof') || error.endsWith('eof')) return 'eof';
  if (error.includes('connect') || error.includes('connection refused') || error.includes('dial')) return 'tcp_connect_failure';
  return 'other_transport';
}

function metric(data, name, field, fallback = null) {
  const value = data.metrics[name] && data.metrics[name].values;
  return value && value[field] !== undefined ? value[field] : fallback;
}

function duration(data, name) {
  return {
    p50: metric(data, name, 'med'), p90: metric(data, name, 'p(90)'),
    p95: metric(data, name, 'p(95)'), p99: metric(data, name, 'p(99)'),
    max: metric(data, name, 'max'),
  };
}

function fixedCounterDistribution(data, counters) {
  const distribution = {};
  for (const [key, counter] of Object.entries(counters)) {
    const count = metric(data, counter, 'count', 0);
    if (count > 0) distribution[key] = count;
  }
  return distribution;
}

export function handleSummary(data) {
  const countedAttempted = metric(data, 'submission_attempted', 'count', 0);
  const countedAccepted = metric(data, 'submission_accepted_201', 'count', 0);
  const dispatchFirst = metric(data, 'submission_batch_invocation_epoch_ms', 'min');
  const dispatchLast = metric(data, 'submission_batch_invocation_epoch_ms', 'max');

  const acceptancePercent = countedAttempted > 0
    ? (countedAccepted * 100) / countedAttempted
    : null;

  const transportConfig = mode === 'burst'
    ? {
        configured_vus: burstVUs,
        requests_per_vu: requestsPerVU,
        batch: requestsPerVU,
        batch_per_host: requestsPerVU,
        iterations_per_vu: 1,
      }
    : {
        target_rps: arrivalRate,
        time_unit: '1s',
        duration: arrivalDuration,
        duration_seconds: arrivalDurationSeconds,
        scheduled_iterations: intendedRequests,
        pre_allocated_vus: preAllocatedVUs,
        max_vus: maxVUs,
        requests_per_iteration: 1,
      };

  const run = {
    schema_version: 'astracode.submission-admission.run.v3',
    benchmark_type: 'submission-admission',
    run_id: __ENV.RUN_ID,
    started_at: __ENV.STARTED_AT,
    ended_at: new Date().toISOString(),
    repository: {
      git_sha: __ENV.GIT_SHA,
      dirty: __ENV.GIT_DIRTY === 'true',
    },
    target: {
      endpoint: '/api/v1/submissions',
      problem_id: problemID,
      problem_slug: __ENV.PROBLEM_SLUG,
      language,
    },
    workload: {
      mode,
      executor: mode === 'burst'
        ? 'per-vu-iterations'
        : 'constant-arrival-rate',
      intended: intendedRequests,
      credential_pool_users: userCount,
      ...transportConfig,
      one_post_per_identity: true,
      redirects_disabled: true,
      observation: 'admission-only',
      ...(mode === 'burst'
        ? {
            batch_dispatch_clock_spread_precision:
              'local Date.now() sampled immediately before http.batch()',
          }
        : {
            arrival_schedule:
              'iterations scheduled by k6 constant-arrival-rate; one POST per started iteration',
          }),
    },
    system_config: systemConfig,
  };

  const summary = {
    schema_version: 'astracode.submission-admission.summary.v3',
    benchmark_type: 'submission-admission',
    run_id: __ENV.RUN_ID,

    mode,
    executor: mode === 'burst'
      ? 'per-vu-iterations'
      : 'constant-arrival-rate',

    intended: intendedRequests,
    scheduled: intendedRequests,
    credential_pool_users: userCount,

    target_rps: mode === 'arrival' ? arrivalRate : null,
    target_duration_seconds: mode === 'arrival'
      ? arrivalDurationSeconds
      : null,

    attempted: countedAttempted,
    accepted: countedAccepted,
    acceptance_percent: acceptancePercent,

    http_429: metric(data, 'submission_http_429', 'count', 0),
    other_4xx: metric(data, 'submission_other_4xx', 'count', 0),
    server_5xx: metric(data, 'submission_server_5xx', 'count', 0),
    transport_failures: metric(data, 'submission_transport_failures', 'count', 0),

    transport_error_classification:
      fixedCounterDistribution(data, {
        request_timeout: 'submission_error_class_request_timeout',
        dns_failure: 'submission_error_class_dns_failure',
        tls_failure: 'submission_error_class_tls_failure',
        connection_reset: 'submission_error_class_connection_reset',
        eof: 'submission_error_class_eof',
        tcp_connect_failure: 'submission_error_class_tcp_connect_failure',
        other_transport: 'submission_error_class_other_transport',
      }),

    http_req_failed: metric(data, 'http_req_failed', 'rate'),
    dropped_iterations: metric(data, 'dropped_iterations', 'count', 0),

    // k6's aggregate HTTP request rate is retained for compatibility. For
    // arrival mode also report counts normalized to the configured scheduling
    // window so long tail/graceful-stop time cannot be mistaken for target RPS.
    achieved_rps: metric(data, 'http_reqs', 'rate'),

    attempted_per_target_second:
      mode === 'arrival' && arrivalDurationSeconds > 0
        ? countedAttempted / arrivalDurationSeconds
        : null,

    accepted_per_target_second:
      mode === 'arrival' && arrivalDurationSeconds > 0
        ? countedAccepted / arrivalDurationSeconds
        : null,

    acceptance_rate: metric(data, 'submission_acceptance_rate', 'rate'),

    http_req_duration_ms: duration(data, 'http_req_duration'),
    http_req_blocked_ms: duration(data, 'http_req_blocked'),
    http_req_connecting_ms: duration(data, 'http_req_connecting'),
    http_req_tls_handshaking_ms: duration(data, 'http_req_tls_handshaking'),
    http_req_sending_ms: duration(data, 'http_req_sending'),
    http_req_waiting_ms: duration(data, 'http_req_waiting'),
    http_req_receiving_ms: duration(data, 'http_req_receiving'),
    iteration_duration_ms: duration(data, 'iteration_duration'),

    batch_dispatch_clock_spread_ms:
      mode === 'burst' && dispatchFirst !== null && dispatchLast !== null
        ? dispatchLast - dispatchFirst
        : null,

    batch_dispatch_clock_spread_note:
      mode === 'burst'
        ? 'local Date.now() span between VU http.batch() invocations; not an on-wire dispatch measurement'
        : 'not applicable to constant-arrival-rate mode',

    vus: transportConfig,
  };

  return {
    [`${outputDir}/run.json`]: JSON.stringify(run, null, 2),
    [`${outputDir}/summary.json`]: JSON.stringify(summary, null, 2),
  };
}

function requiredEnv(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

function boundedDurationSeconds(raw, name) {
  const match = /^([1-9][0-9]*)([smh])$/.exec(raw || '');
  if (!match) throw new Error(`invalid ${name}`);

  const amount = Number(match[1]);
  const multiplier = match[2] === 's'
    ? 1
    : match[2] === 'm'
      ? 60
      : 3600;

  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new Error(`invalid ${name}`);
  }

  return seconds;
}

function loadSystemConfig(path) {
  if (!path) return null;
  const value = JSON.parse(open(path));
  const top = ['label', 'release', 'app', 'judge'];
  if (!exactKeys(value, top) || !exactKeys(value.app, ['nodes', 'cpu_cores_per_node', 'memory_mib_per_node']) || !exactKeys(value.judge, ['nodes', 'cpu_cores_per_node', 'memory_mib_per_node', 'worker_pool_size', 'worker_memory_limit_mib', 'sandbox_memory_limit_mib'])) throw new Error('invalid strict system config');
  if (typeof value.label !== 'string' || !value.label || typeof value.release !== 'string' || !value.release) throw new Error('invalid system config label/release');
  for (const section of [value.app, value.judge]) for (const key in section) if (!Number.isInteger(section[key]) || section[key] <= 0) throw new Error('invalid positive system config value');
  return value;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
