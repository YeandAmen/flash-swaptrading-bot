#!/usr/bin/env bash
# Runs the live-trading code path against a local anvil fork of Ethereum mainnet with fake funds.
# Never touches the real bot wallet or real money.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC_URL="$(grep -E '^RPC_URL=' .env | head -1 | cut -d= -f2-)"
ANVIL="${ANVIL:-$(command -v anvil || echo "$HOME/.foundry/bin/anvil")}"
TMP="$(mktemp -d)"
PORT=8546
TEST="${1:-cli-forktest}"
case "$TEST" in cli-forktest|cli-mev-forktest) ;; *) echo "unknown test $TEST"; exit 1;; esac
ANVIL_PID=""
# (the temp dir only holds a throwaway fork-only key and test state; macOS cleans its temp folder)
cleanup() { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

"$ANVIL" --fork-url "$RPC_URL" --chain-id 1 --port $PORT --silent &
ANVIL_PID=$!
up=0
for _ in $(seq 1 60); do
  if curl -s -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:$PORT; then up=1; break; fi
  sleep 0.5
done
[ "$up" = 1 ] || { echo "anvil did not start"; exit 1; }

# throwaway key for the test wallet
node -e "import('viem/accounts').then(a=>process.stdout.write(a.generatePrivateKey()))" > "$TMP/test.key"
chmod 600 "$TMP/test.key"

RPC_URL=http://127.0.0.1:$PORT SEND_RPC_URL=http://127.0.0.1:$PORT FORK_MODE=1 \
WALLET_KEY_FILE="$TMP/test.key" DATA_DIR="$TMP/data" LOOP_SECONDS=5 \
  node "${DIST:-dist}/${TEST}.js"
