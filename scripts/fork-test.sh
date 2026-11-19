#!/usr/bin/env bash
# Compatibility entry point for existing scripts. The test runner also supports Windows.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/fork-test.mjs "$@"
