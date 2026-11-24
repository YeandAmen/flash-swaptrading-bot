# Real Ethereum state tests

These commands exercise actual mainnet pool bytecode and state without sending
a transaction upstream. They are separate from the mock-pool integration tests.

## Fork replay

```sh
python3 scripts/mainnet-fork.py --report data/mainnet-fork-report.json
```

Requires Go and Anvil. It defaults to a public Ethereum mainnet read endpoint;
`FORK_RPC_URL` can supply another HTTPS endpoint without printing it. Use
`--block NUMBER` for a specific snapshot if the provider retains that state.

The runner pins an actual Ethereum header, starts Anvil chain 31337, and places
a local read-only proxy between Anvil and upstream. The proxy explicitly rejects
broadcast methods. Test keys are newly generated and only funded on the local
fork. User wallet files and live settings are not passed to the test process.

The test discovers Uniswap V2 and SushiSwap V2 WETH/USDC pairs through their real
canonical factories. It verifies the pinned header, pair tokens and nonempty
real bytecode, records reserves and code hashes, then measures quotes in the
untouched snapshot. A local deployment of the retained FlashArb proxy/Logic V4
is checked against its retained runtime artifacts.

A second scenario creates a price difference by depositing fake local ETH into
the real WETH contract and swapping through one real V2 pool on the fork. No
pool code, storage slots or token balances are directly overridden. The test
checks that an unreachable payout floor reverts specifically as `unprofitable`,
then stops account impersonation and uses the Go executor to cryptographically
sign and submit an arbitrage transaction to the local chain. Verified event
payout minus receipt gas must exactly equal the wallet's actual ETH increase.

**The controlled spread is created on the fork.** Its resulting profit is not a
naturally observed mainnet opportunity, and its setup cost is excluded from the
arbitrage-only net. This scenario validates execution with real protocol code;
it does not establish a profitable price-manipulation strategy or inclusion on
mainnet. The report explicitly separates untouched snapshot observations and
the controlled execution scenario, with local-only transaction hashes.

## Measured mainnet shadow run

```sh
go build -o bin/bot ./cmd/bot
python3 scripts/shadow-run.py --extended --samples 8 --period 12 \
  --report data/shadow-report.json
```

The runner copies a fixed binary and records its SHA-256. It forces
`ALLOW_LIVE_TRADING=off`, removes wallet/model/live settings from its child
environment, runs bounded one-shot scans and records failures as well as
successes. `SHADOW_RPC_URL` can provide a different read endpoint. No wallet,
deployment, model request or broadcast is performed.

Extended mode scans USDC plus the five non-WETH core tokens in the retained
upstream configuration: WBTC, LINK, UNI, AAVE and LDO. It tests nine principal
sizes from 0.001 to 10 WETH. Not every factory necessarily has every pair.
Reports include unique blocks, existing pools, quote evaluations, warnings,
qualifying quotes, process duration, and whether the latest head had advanced
when each scan finished.

The scanner records its best rejected quote as diagnostic data. A rejected quote
is never admitted to live execution. Both buffered net and the highest gross
quote are exposed so fees, gas and the configured minimum can be distinguished.
Empty candidate lists alone are not execution or profitability results.

## RPC batching

Canonical factory discovery and pool state reads are grouped in batches of at
most 24 calls, with at most four batches in flight. Every call uses the same
block hash and each result is validated independently. Transport failure falls
back to bounded individual reads and is reported. Invalid token pairs and
individual RPC errors are still rejected. Header and reorg checks remain in
place. Batching reduces HTTP round trips; it does not necessarily reduce the
provider's metered call count.

Compare before/after runs only as observations from their measured windows.
Network conditions and pool state can differ. A short window cannot establish
long-run profitability, and a qualifying quote still needs full simulation,
fresh-state checks and actual builder/network inclusion.
