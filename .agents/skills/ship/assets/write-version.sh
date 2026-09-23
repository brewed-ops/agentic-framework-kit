#!/usr/bin/env sh
# Writes <outDir>/version.json = {"commit", "builtAt"} for any stack (Python, Go, Rust, static).
# Run it right after your build:  sh scripts/write-version.sh dist
set -eu
OUT="${1:-dist}"
[ -d "$OUT" ] || { echo "write-version: $OUT/ does not exist - run it after the build" >&2; exit 1; }
COMMIT="$(git rev-parse HEAD)"
printf '{"commit":"%s","builtAt":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/version.json"
echo "write-version: $OUT/version.json -> $(printf %s "$COMMIT" | cut -c1-7)"
