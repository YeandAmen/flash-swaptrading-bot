# Go trading backend

This fork's Go backend scans Ethereum V2 pools, ranks paper
arbitrage estimates, and optionally simulates the retained Solidity proxy.
An optional DeepSeek analyst explains reports through OpenRouter. All Solidity
files and the original TypeScript application are retained unchanged.

Optional live Ethereum V2 execution now includes encrypted-wallet signing,
gas limits, pending-state simulation, a durable nonce journal and receipt-based
settlement. **Live mode is off by default and always starts disarmed.** Read
[LIVE_TRADING.md](LIVE_TRADING.md) before configuring it. Paper scans need no
wallet or funds. Deployment, upgrades, spot execution, Arbitrum and Solana still
use the original backend; this is not full feature parity with the original bot.

## Run without credentials

Requires Go 1.25 or newer. From this directory:

```sh
go run ./cmd/bot --demo
```

Open http://127.0.0.1:7780. Demo mode uses clearly labelled synthetic reserves;
it does not read a blockchain or indicate a real opportunity. `--demo --once`
prints the fixture report and exits. The readiness endpoint stays false in demo
mode because it has no fresh mainnet data.

## Scan Ethereum

```sh
export RPC_URL='https://your-ethereum-mainnet-rpc.example'
export ALLOW_LIVE_TRADING=off
go run ./cmd/bot
```

The Go program reads exported environment variables; it does not automatically
load `.env`. See [.env.example](.env.example) for supported settings. A provider
must support `eth_call` with EIP-1898 block-hash identifiers. Wrong chain IDs,
stale heads, and changed snapshot blocks are rejected. Requests use deadlines
and at most four concurrent pool readers. The default tokens are USDC, WBTC and
LINK; default principal sizes are 0.01, 0.1 and 1 WETH.

Discovery queries the canonical Uniswap V2, SushiSwap V2 and PancakeSwap V2
factories and validates each pool's token pair. All reads in a scan use one
block hash. Both directions and each configured size are compared with exact
integer constant-product formulas. The buy-pool flash-swap route has its trading
fee included in the quote; no additional external loan is assumed.

The screening net is final WETH output, less a quote buffer, principal and a gas
budget. The budget is `GAS_BUDGET_UNITS * (2 * block base fee + priority fee)`.
These are conservative screening assumptions, not an exact gas estimate, USD
conversion, promise of inclusion or realized return. Reserves alone cannot
capture transfer-tax tokens and other unusual token behavior. Routes remain
`quote_only` unless the full contract simulation passes.

`go run ./cmd/bot --once` prints a single scan report. The service provides:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | HTTP process health |
| `GET /api/ready` | Fresh successful mainnet scan; never enables signing |
| `GET /api/state` | Latest immutable in-memory report and freshness |
| `POST /api/analyze` | Optional paid, user-triggered model explanation |
| `POST /api/live/arm` | Explicit arming, only when live settings and signer are configured |
| `POST /api/live/disarm` | Stop future signing/submissions; continue pending reconciliation |
| `POST /api/live/acknowledge` | Acknowledge a reviewed settled fault without resetting spend |

The service binds only to a loopback IP and checks Host and mutation Origin
headers. It is a local operator tool; do not expose it through a public proxy.
Restarting clears reports and the per-process model cooldown.

## Simulate against an existing FlashArb deployment

Set both `FLASH_ARB_PROXY` and `FLASH_ARB_OWNER` to public addresses. For up to
three shortlisted candidates the scanner verifies, at the snapshot block:

1. Exact proxy runtime matches the retained upstream compiler artifact.
2. EIP-1967 implementation runtime matches retained FlashArb Logic V4.
3. The configured owner matches the contract's owner.
4. `executePinned` succeeds via `eth_call` with the fixed gas limit, zero builder
   tip and a minimum profit covering the entire gas budget plus `MIN_NET_WEI`.

The order uses BuyPool funding and expires at the snapshot block, because this
is a historical-state simulation. It is not signed or sent by the scanner.
The optional live executor separately repeats verification, estimates and pads
gas, simulates final calldata at the snapshot and pending state, checks current
head/nonce/balance and journals a signed next-block order before submission.
Contracts using other logic releases are rejected.

## Add DeepSeek through OpenRouter

The integration uses OpenRouter's Chat Completions endpoint. Its default model is
`deepseek/deepseek-chat-v3-0324`; `OPENROUTER_MODEL` can select another available
DeepSeek model. The default ID was present in the OpenRouter catalog when this
integration was developed. Availability and model behavior can change.

Enter your key through a hidden local prompt, never through chat or Git:

```sh
python3 scripts/setup-key.py
export OPENROUTER_API_KEY_FILE="$PWD/.secrets/openrouter.key"
go run ./cmd/bot --demo
```

The script creates a new owner-only file under an ignored directory and refuses
to overwrite an existing key. Alternatively, inject `OPENROUTER_API_KEY` with
your secret manager. Do not configure both key sources. Existing key files must
be regular files with owner-only permissions. The development host and CI use
Unix permissions; Windows key-file permission handling is not implemented.

Click **Analyze latest scan** to send the report to OpenRouter. Requests have
a 45-second timeout, a 900-token completion cap, bounded report sizes, no automatic
retries and a one-minute per-process cooldown. This limits individual requests;
it is not a hard dollar spending cap. Use an OpenRouter key credit limit for one.
The model receives public report data, not RPC credentials or wallet keys.
Provider errors are not echoed and the UI renders model output as plain text.

Model output has no path into amounts, routes, thresholds, Solidity calldata or
execution. It may explain rejected opportunities and suggest research topics;
its conclusions still need verification. Model API tests use a mock provider.
A real paid provider call requires your configured key and available credits.

## Verify

```sh
python3 scripts/check-artifacts.py
go vet ./...
go test -race -cover ./...
go test ./internal/market -run '^$' -fuzz FuzzAmountOutInvariant -fuzztime 5s
go build -o bin/bot ./cmd/bot
```

The local EVM integration additionally needs Anvil and `solc` 0.8.26 or newer:

```sh
python3 scripts/integration.py
```

It starts an isolated, unforked chain 31337 on a temporary loopback port, installs
mock token/pool infrastructure, deploys the actual retained proxy and Logic V4
bytecode, and compares a Go quote with a full Solidity flash-swap simulation.
It also checks rejection of an excessive profit floor and that simulation does
not persist pool changes. A second test signs, submits and mines an actual local
arbitrage transaction, compares the wallet's ETH increase to recorded net after
gas, and checks disarmed restart recovery. No mainnet RPC, saved wallet or real
funds are used.
Fixtures do not reproduce all mainnet token, pool, liquidity or MEV behavior.

Tests cover quote rounding/invariants, fees, negative economics, configuration
guards, block pinning, reorg rejection, stale data, ownership, runtime checks,
model cooldown/errors and HTTP access controls. CI runs the standard Go checks
and the isolated Anvil integration with a checksum-pinned Solidity compiler.
Live tests cover durable pre-send reservations, duplicate prevention, uncertain
send recovery, identical-byte retries, expired nonce holds, confirmations,
reorganized receipts, unverified payouts, gas losses, limits, keystore policy
and an emergency stop during an in-flight submission.

## Migration stages

| Capability | This release | Further work |
| --- | --- | --- |
| Ethereum V2 paper scanning | Implemented | Broader tokens and benchmark against original |
| Retained Solidity proxy simulation | Implemented for Logic V4 | More funding sources |
| DeepSeek report analyst | Implemented, optional | Evaluate usefulness against labelled outcomes |
| Ethereum V2 live signing and settlement | Implemented; off and disarmed by default | Relay inclusion measurement, operator cancellation tooling |
| V3/V4, Curve, Aero pools | Original backend only | Port protocol math and quote/execution parity tests |
| Spot strategy and statistical ML | Original backend only | Independent strategy migration and validation |
| Arbitrum and Solana | Original backend only | Dedicated network adapters and integration tests |

A language change alone does not establish higher speed or profitability.
Compare quote correctness, scan latency, RPC requests per block and eventual
realized net results against the original before claiming improvement.

Upstream: https://github.com/cutiapreta/flash-swaptrading-bot at commit
`15bb175c86213dc5b24a557a0d60273e329d753c`. Solidity retains its original SPDX
headers; this fork does not assign a new license to upstream code.
