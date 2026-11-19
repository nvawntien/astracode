#!/usr/bin/env bash
set -Eeuo pipefail

cat >&2 <<'EOF'
scripts/deploy-production.sh is deprecated and intentionally does not deploy.

Use the GitHub Deploy production workflow. It suspends the Judge Worker,
activates and verifies the App contract, then starts the matching Judge release.
See docs/DEPLOYMENT.md for paired recovery and emergency rollback.
EOF
exit 64
