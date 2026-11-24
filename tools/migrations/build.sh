#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || "$1" != /* ]]; then
    echo "Usage: bash tools/migrations/build.sh /absolute/output/path" >&2
    exit 2
fi
case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "The migration runner supports Linux amd64 and arm64." >&2; exit 2 ;;
esac
if [[ "$(uname -s)" != Linux ]]; then
    echo "The migration runner requires Linux." >&2
    exit 2
fi

output=$1
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
name=astracode-migrate-linux-$arch
GOWORK=off GOTOOLCHAIN=go1.26.11 GOFLAGS= GOEXPERIMENT= GOAMD64=v1 GOARM64=v8.0 \
    CGO_ENABLED=0 GOOS=linux GOARCH=$arch \
    go build -mod=readonly -trimpath -buildvcs=false -pgo=off -ldflags=-buildid= \
    -o "$tmp/$name" ./cmd/astracode-migrate
expected=$(awk -v name="$name" '$2 == name {print $1}' artifacts.sha256)
if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then
    echo "No pinned checksum for $name." >&2
    exit 1
fi
(cd "$tmp" && printf '%s  %s\n' "$expected" "$name" | sha256sum --check --status)
install -m 0700 "$tmp/$name" "$output"
printf '%s\n' "$expected"
