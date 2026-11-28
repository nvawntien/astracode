#!/usr/bin/env bash
set -euo pipefail
directory=${RUNNER_TEMP:?}/astra-release-tools
mkdir -p "$directory/bin"
python3 -m venv "$directory/venv"
"$directory/venv/bin/pip" install --disable-pip-version-check PyYAML==6.0.3
if [[ "${1:-}" == --azure ]]; then
  "$directory/venv/bin/pip" install --disable-pip-version-check azure-cli==2.76.0
fi
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 120 \
  https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.7.1/kustomize_v5.7.1_linux_amd64.tar.gz \
  --output "$directory/kustomize.tar.gz"
printf '%s  %s\n' ea375e7372f9aa029129d4b2d16c66b7750b7f1213c4f66f910d981c895818d8 "$directory/kustomize.tar.gz" | sha256sum --check --status
tar -xzf "$directory/kustomize.tar.gz" -C "$directory/bin" kustomize
printf '%s\n' "$directory/venv/bin" "$directory/bin" >> "${GITHUB_PATH:?}"
