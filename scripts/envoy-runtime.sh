#!/usr/bin/env bash
# Sourced after the caller defines compose(). Never changes the canonical JWK.
validate_envoy_runtime() {
  compose run --rm --no-deps envoy-jwk || return 1
  compose run --rm --no-deps envoy --mode validate -c /etc/envoy/envoy.yaml || return 1
}

activate_envoy_runtime() {
  # Bind-mount content is not part of Compose's service configuration hash.
  # Always reload bootstrap, Lua and the provisioned key, including same-tag deploys.
  compose up -d --no-deps --force-recreate --pull never --timeout "${COMPOSE_STOP_TIMEOUT:-30}" envoy || return 1
}
