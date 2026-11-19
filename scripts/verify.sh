#!/usr/bin/env bash
# scripts/verify.sh — one command to verify a checkout (humans, agents, CI).
# Usage:  scripts/verify.sh          full verification
#         QUICK=1 scripts/verify.sh  skip race tests and website build (session start)
# Requires network access on first run (Go modules, npm packages).

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

REQUIRED_GO="1.25.8"
# go.work also lists tools/benchmark/judge; add it here once its checks are confirmed to pass.
GO_MODULES=(pkg services/auth services/problem services/submission workers/judge)

step() { printf '\n==> %s\n' "$1"; }

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

step "Website"
(
  cd website
  [ -d node_modules ] || npm ci
  npm run typecheck
  if [ "${QUICK:-0}" != "1" ]; then
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