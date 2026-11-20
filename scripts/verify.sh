#!/usr/bin/env bash
# scripts/verify.sh — standard local checkout checks.
# Usage:  scripts/verify.sh          full verification
#         QUICK=1 scripts/verify.sh  skip race, benchmark, website tests and build
# Requires network access on first run (Go modules, npm packages).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

REQUIRED_GO="1.25.8"
GO_MODULES=(pkg services/auth services/problem services/submission workers/judge)
if [ "${QUICK:-0}" != "1" ]; then
  GO_MODULES+=(tools/benchmark/judge)
fi

step() { printf '\n==> %s\n' "$1"; }

website_dependencies_healthy() {
  [ -x node_modules/.bin/tsc ] &&
    [ -x node_modules/.bin/vitest ] &&
    [ -x node_modules/.bin/next ] &&
    npm ls --all --include=dev --include=optional --silent >/dev/null &&
    node <<'NODE'
const { existsSync, readFileSync } = require('node:fs');
const { isDeepStrictEqual } = require('node:util');
const manifest = require('./package.json');
const { packages } = require('./package-lock.json');

for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  if (!isDeepStrictEqual(manifest[field], packages[''][field])) process.exit(1);
}

// npm ls accepts semver-compatible versions. Read the installed manifests to
// check the exact lockfile versions, allowing absent optional packages.
for (const [path, entry] of Object.entries(packages)) {
  if (!path || (entry.optional && !existsSync(path))) continue;
  const installed = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
  if (installed.version !== entry.version) process.exit(1);
}
NODE
}

step "Tool versions"
if ! go version | grep -q "go${REQUIRED_GO}"; then
  echo "WARN: expected Go ${REQUIRED_GO}, found: $(go version)"
fi
node --version
openspec --version || echo "WARN: openspec CLI not installed (npm install -g @fission-ai/openspec)"

step "Local env files (copied from templates if missing; all git-ignored)"
for f in postgres redis service; do
  [ -f "environment/${f}.env" ] || cp "environment/${f}.env.example" "environment/${f}.env"
done
[ -f website/.env.local ] || cp website/.env.example website/.env.local

step "Go modules"
for module in "${GO_MODULES[@]}"; do
  echo "--- ${module}"
  (
    cd "${module}"
    go test ./...
    go vet ./...
    if [ "${QUICK:-0}" != "1" ]; then
      go test -race ./...   # judge worker tests open local sockets; sandboxed agents may need permission
    fi
  )
done

if [ "${QUICK:-0}" != "1" ]; then
  step "Judge benchmark collector syntax"
  bash -n tools/benchmark/judge/scripts/collect-container-stats.sh
  bash -n tools/benchmark/judge/scripts/collect-kafka-lag.sh
fi

step "Website"
(
  cd website
  if ! website_dependencies_healthy; then
    echo "Repairing website dependencies from package-lock.json"
    npm ci --include=dev --include=optional
    if ! website_dependencies_healthy; then
      echo "ERROR: website dependencies are still missing or inconsistent after npm ci" >&2
      exit 1
    fi
  fi
  npm run typecheck
  if [ "${QUICK:-0}" != "1" ]; then
    npm test
    npm run build
  fi
)

step "Compose configuration"
docker compose config --quiet

step "OpenSpec"
has_specs=$(find openspec/specs -name spec.md 2>/dev/null | head -n 1 || true)
has_changes=$(find openspec/changes -mindepth 1 -maxdepth 1 -type d ! -name archive 2>/dev/null | head -n 1 || true)
if [ -n "${has_specs}" ] || [ -n "${has_changes}" ]; then
  openspec validate --all --strict --no-interactive
else
  echo "SKIP: no specs or active changes yet"
fi

step "All checks passed"
