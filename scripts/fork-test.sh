#!/usr/bin/env bash
# Runs integration tests with a throwaway wallet on an isolated Anvil instance.
set -euo pipefail
cd "$(dirname "$0")/.."

suite="${1:-cli-forktest}"
mode="${2:-}"
case "$suite:$mode" in
  cli-forktest:|cli-mev-forktest:|cli-wallet-forktest:|cli-wallet-forktest:--standalone) ;;
  *) echo "Unknown test or mode: $suite $mode" >&2; exit 1 ;;
esac

anvil_bin="${ANVIL:-$(command -v anvil || true)}"
if [[ -z "$anvil_bin" || ! -x "$anvil_bin" ]]; then
  echo "Anvil is required. Install Foundry or set ANVIL to the Anvil executable." >&2
  exit 1
fi
test_node="$(command -v node)"
test_path="$PATH"
test_file="${DIST:-dist}/$suite.js"
if [[ ! -f "$test_file" ]]; then
  echo "Run npm run build before running the fork tests." >&2
  exit 1
fi

anvil_args=(--host 127.0.0.1 --port 0 --chain-id 1 --accounts 0 --color never)
if [[ "$mode" != "--standalone" ]]; then
  if [[ ! "${FORK_RPC_URL:-}" =~ ^https?:// ]]; then
    echo "Set FORK_RPC_URL to an Ethereum mainnet archive RPC URL for Anvil's read-only upstream." >&2
    exit 1
  fi
  anvil_args+=(--fork-url "$FORK_RPC_URL" --no-storage-caching)
  if [[ -n "${FORK_BLOCK_NUMBER:-}" ]]; then
    if [[ ! "$FORK_BLOCK_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
      echo "FORK_BLOCK_NUMBER must be a positive decimal block number." >&2
      exit 1
    fi
    anvil_args+=(--fork-block-number "$FORK_BLOCK_NUMBER")
  fi
fi

umask 077
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/eth-token-fork.XXXXXXXX")"
anvil_pid=""
cleanup() {
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" 2>/dev/null || true
    wait "$anvil_pid" 2>/dev/null || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

env -i PATH="$test_path" "$anvil_bin" "${anvil_args[@]}" > "$test_dir/anvil.log" 2>&1 &
anvil_pid=$!
port=""
for ((i = 0; i < 120; i++)); do
  if ! kill -0 "$anvil_pid" 2>/dev/null; then break; fi
  port="$(sed -n 's/^Listening on 127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' "$test_dir/anvil.log")"
  if [[ -n "$port" ]]; then break; fi
  sleep 0.5
done
if [[ -z "$port" ]]; then
  echo "Anvil did not start. Check Anvil and access to the fork upstream." >&2
  exit 1
fi

loopback="http://127.0.0.1:$port"
env -i PATH="$test_path" "$test_node" --input-type=module -e \
  "import { generatePrivateKey } from 'viem/accounts'; process.stdout.write(generatePrivateKey());" > "$test_dir/test.key"

env -i PATH="$test_path" RPC_URL="$loopback" SEND_RPC_URL="$loopback" \
  FORK_MODE=1 ALLOW_LIVE_TRADING=off WALLET_KEY_FILE="$test_dir/test.key" \
  DATA_DIR="$test_dir/data" LOOP_SECONDS=5 TOKEN_MODE=core "$test_node" "$test_file"
