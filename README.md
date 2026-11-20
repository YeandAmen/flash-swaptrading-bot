# ETH Token Bot

A local Ethereum mainnet dashboard for Uniswap v3 spot strategies and two-pool arbitrage. It runs on Node.js on macOS, Linux, or Windows. The spot engine can use momentum rules or a calibrated ML model. The MEV engine scans supported pools using a consistent Ethereum block and simulates candidates before considering a transaction.

`ALLOW_LIVE_TRADING=off` is the default. It disables all mainnet signing from the bot, including trades, gas top-ups, contract deployment, and MEV bundles. Paper spot and MEV scans use public state and leave the wallet unfunded. Both live modes start disarmed after every restart.

## 1. Install and configure

Install [Node.js 22 or later](https://nodejs.org/en/download), Git, and an Ethereum mainnet read RPC endpoint. Historical replay requires an archive-capable RPC. MEV paper simulation requires `eth_call` state overrides. For Windows PowerShell, use `npm.cmd` in place of `npm` if execution policy blocks the PowerShell npm shim.

```sh
git clone https://github.com/cutiapreta/eth-token-bot.git
cd eth-token-bot
npm ci
cp .env.example .env
```

On Windows PowerShell, replace the `cp` line with `Copy-Item .env.example .env`. Open `.env` locally and set `RPC_URL` to your Ethereum mainnet RPC URL. Keep `ALLOW_LIVE_TRADING=off`. Leave `MEV=on` for paper arbitrage scanning. The default dashboard port is `7777`.

```sh
npm run build
npm start
```

Open [http://127.0.0.1:7777](http://127.0.0.1:7777). The dashboard and paper controls open directly on this computer. The dashboard binds to IPv4 loopback, so the address refers to the computer running the process. Keep the terminal open during a foreground run. Stop with `Ctrl+C`. After code edits, build again before restarting.

## 2. Wallet creation, backup, and restore

**The bot creates its wallet automatically on first startup.** To initialize it before starting the dashboard or check the existing public address, run the address command after building and configuring `.env`.

```sh
npm run --silent wallet:address
```

Check the same public address on the dashboard. The wallet record in `DATA_DIR/wallet.json` binds that data directory to the original address. `DATA_DIR` defaults to `data` under the checkout.

| Platform | Default private key storage |
| --- | --- |
| macOS | Login Keychain, service `eth-token-bot`, account `bot-wallet`. The protected local fallback is `~/.eth-token-bot/wallet.key`. Installations already using that file keep the same key. |
| Linux and Windows | `DATA_DIR/wallet.key`. The bot creates it with `0600` permissions on Linux and an owner-only access list on Windows. Use a local NTFS data directory on Windows. |

The address command, dashboard, and server logs show public information. Export the private key to a new file outside the checkout only when you need an offline backup or need to import the original key into a deployment signer.

**macOS or Linux**

```sh
mkdir -p "$HOME/wallet-backups"
chmod 700 "$HOME/wallet-backups"
npm run --silent wallet:export -- "$HOME/wallet-backups/eth-token-bot.key"
```

**Windows PowerShell**

```powershell
$walletBackup = Join-Path $env:USERPROFILE 'wallet-backups'
New-Item -ItemType Directory -Force -Path $walletBackup | Out-Null
npm run --silent wallet:export -- (Join-Path $walletBackup 'eth-token-bot.key')
```

The exported file contains one `0x`-prefixed private key in plaintext. The command prints the public address and destination, with the key stored in the restricted file. Keep it in encrypted offline storage. Anyone who obtains the key can spend the wallet’s funds. Share the repository and `.env.example` when handing the project to someone. Keep your `.env`, `DATA_DIR`, private key backups, and dashboard credential local.

**To restore or import:** Before starting, set `WALLET_KEY_FILE` in `.env` to the absolute path of a protected file containing one `0x`-prefixed private key. On macOS or Linux, set `chmod 600 /absolute/path/to/wallet.key`. On Windows use an owner-only NTFS file, such as a file created by the export command. Run `npm run --silent wallet:address` and verify the address against your existing public address before funding it. If you are restoring an existing bot, also restore its data directory and wallet metadata so the bot can reconcile positions and in-flight transactions.

To reuse a Mac Keychain wallet on another platform, export it from the original checkout on the Mac, transfer the protected backup securely, and set `WALLET_KEY_FILE` on the new machine. Always verify the public address. A different key requires a separate `DATA_DIR`; keep the original wallet and state together.

## 3. Dashboard and localhost troubleshooting

The dashboard uses HTTP at `http://127.0.0.1:7777`. Use the port configured by `PORT` if you changed it. Opening the dashboard and using paper controls requires no sign-in. Sensitive live wallet actions require the local operator credential. The bot generates this credential on the first startup with live signing enabled.

```sh
npm run --silent dashboard:password
```

Use `operator` if a live action asks for a username. The password is distinct from the wallet key and is stored at `DATA_DIR/dashboard-token`.

| Symptom | Check |
| --- | --- |
| Connection refused | Run `npm run build` and `npm start` from the checkout, then check the terminal output. Use the displayed loopback port. If another process is already listening, stop the duplicate or set an unused `PORT`, such as `7778`, in `.env` and restart. |
| A browser shows an old sign-in popup | Confirm that the process serving the port is the updated bot. Restart it, then open `http://127.0.0.1:7777` in a fresh private window to clear cached HTTP credentials. |
| Dashboard is open and paper scan is still starting | Check `/api/ready` and the startup status on the page. Market discovery, archive history and MEV pool discovery use the configured RPC. Use `/api/health` to check the HTTP process. |
| Chain or RPC error | Use an Ethereum mainnet endpoint. The RPC must report chain ID `1`. Keep the endpoint credentials inside `.env`. A provider without history or state overrides can limit backtests and eligibility simulations. |
| Browser is on another device, container or remote host | `127.0.0.1` points to that device or environment. Open the dashboard on the host running the bot. Keep the wallet operator interface bound to loopback. |

```sh
curl http://127.0.0.1:7777/api/health
curl http://127.0.0.1:7777/api/ready
```

On Windows PowerShell, use `curl.exe` for these commands.

## 4. Arbitrage venues and funding

FlashArbV2 supports Uniswap v2/v3, SushiSwap v2/v3, and PancakeSwap v3 WETH pairs, plus supported hook-free, static-fee Uniswap v4 ETH or WETH pools. Eligible routes can use pool funding, Aave V3 WETH flash loans, or Morpho Blue WETH flash loans. `MEV_FUNDING=auto` compares available sources. Use `pool`, `aave`, or `morpho` to select one source. Aave charges a repayment premium. Morpho Blue has no lender premium and can lend up to its available balance.

The searcher checks canonical factory or PoolManager state. It compares live pool depth, quotes candidate sizes at a consistent block, and rejects candidates that fail the profit floor after gas and any applicable flash-loan premium and builder tip. The V4 scanner restricts compatibility to pool types the contract can settle. Tokens from the public Ethereum token lists are indexed in paced batches. `MEV_UNIVERSE=spot` restricts the sweep to the spot and core universe, and `MEV_MAX_TRACKED_POOLS` limits active per-block reads.

For a live bundle, expand the target block in the MEV activity table to see the submission lead time, quoted gas budget and builder payment, and each builder's response time. The table reserves space for the five most recent submissions. Titan and Quasar traces can show what happened to an acknowledged bundle after it missed its target block. A bundle is marked landed after the bot verifies its on-chain receipt. [Titan tracing](https://docs.titanbuilder.xyz/bundle-tracing) · [Quasar tracing](https://docs.quasar.win/bundle-tracing)

MEV pool reads use bounded batches pinned to the same block. If a batch fails validation, the scanner can rank routes from the batches that pass. The bot checks gas for shortlisted live routes before ranking them, and keeps the configured minimum net profit on the signed transaction. The bot submits bundles directly and in parallel to Flashbots, Titan, Beaverbuild, and Quasar by default. `MEV_BUILDERS` configures bundle destinations. `SEND_RPC_URL` separately configures the spot transaction RPC, which defaults to Flashbots Protect.

When the target block has enough time left, the live search can use one extra exact gas check for an alternate simulated amount or funding source, or for a route close to covering its estimated costs. The selected bundle still has to pass a final simulation with the signed gas limit and profit floor.

Live MEV can use a different bid after 30 minutes without a confirmed landing. Set `MEV_IDLE_MIN_NET_USD` to a positive floor such as `0.01` and `MEV_IDLE_BUILDER_TIP_PCT` to an after-gas share such as `0.80`. The bid is capped to leave the configured net minimum after gas. A confirmed settlement returns the bot to its normal policy. The idle settings default to the normal values.

`MEV_IDLE_GAS_PADDING_PCT` controls the extra gas above the estimate while idle. It defaults to 25%. A smaller buffer can free room for the builder bid and can also leave less margin for changes in gas usage. The bot simulates using the exact gas limit before sending and budgets the full limit in the profit floor.

The bot's receipts record realized outcomes. A pool count or a profitable paper simulation alone does not establish realized returns. Inclusion depends on pool movement, gas, competing bids, RPC latency, and builder coverage. See [SushiSwap V3 core](https://github.com/sushiswap/v3-core), [PancakeSwap V3 addresses](https://developer.pancakeswap.finance/contracts/v3/addresses), [Uniswap v4 settlement](https://developers.uniswap.org/docs/protocols/v4/concepts/flash-accounting), [Aave V3 flash loans](https://aave.com/docs/aave-v3/smart-contracts/pool#flashloansimple), [Morpho Blue flash loans](https://docs.morpho.org/learn/concepts/flashloans/), and [Flashbots bundle troubleshooting](https://docs.flashbots.net/flashbots-auction/advanced/troubleshooting).

## 5. Test with fake funds

Install [Foundry](https://getfoundry.sh/introduction/installation) and confirm `anvil --version` works. The test runner starts an isolated Anvil instance on a temporary loopback port and generates a throwaway wallet. All signed test transactions go to that local instance. `FORK_RPC_URL` is the upstream for state reads only. The runner does not load `.env` or use the bot's configured wallet or data directory.

```sh
npm run build
npm run wallet:local-test
```

**macOS or Linux**

```sh
export FORK_RPC_URL='https://your-ethereum-archive-rpc.example'
npm run fork-test
npm run wallet:fork-test
FORK_BLOCK_NUMBER=26451239 npm run mev-v2-fork-test
```

**Windows PowerShell**

```powershell
$env:FORK_RPC_URL = 'https://your-ethereum-archive-rpc.example'
npm run fork-test
npm run wallet:fork-test
$env:FORK_BLOCK_NUMBER = '26451239'
npm run mev-v2-fork-test
Remove-Item Env:FORK_BLOCK_NUMBER
```

Ethereum block `26451239` contains the canonical PancakeSwap v3 and Uniswap v4 pools used by the V2 fixture. Choose another archive snapshot by setting `FORK_BLOCK_NUMBER`. Use the `ANVIL` environment variable for a locally installed executable outside your `PATH`.

## 6. Deploy FlashArbV3 from the dashboard

Paper scanning is available after startup. If the live controls are disabled, check `ALLOW_LIVE_TRADING` in `.env`. The default `off` blocks every broadcast, including contract deployment. Both live modes start disarmed on every restart.

1. To allow a real mainnet deployment, set `ALLOW_LIVE_TRADING=on` in `.env` and restart the bot. Use `npm run service:restart` for the installed macOS service, or stop and restart `npm start` for a foreground run.
2. Open [the local dashboard](http://127.0.0.1:7777), wait for the wallet to be ready, and select **Deploy FlashArbV3**. The dialog shows the estimated fee and the maximum gas charge you authorize. If the balance is low, it shows the minimum ETH needed at current gas prices.
3. Type `DEPLOY` and authorize the action with the password from `npm run --silent dashboard:password`. The bot rechecks the gas cap and disarms both modes before signing. It selects V3 after verifying the deployed bytecode and wallet ownership at the confirmed receipt block. An existing V2 stays in the local deployment history.
4. **Arm MEV** separately when you want live arbitrage. Spot trading has its own arming control. To return to paper-only operation, set `ALLOW_LIVE_TRADING=off` and restart.

The dashboard reuses a verified V2 deployment. To adopt a manually deployed copy, set `MEV_V2_CONTRACT_ADDRESS` to the FlashArbV2 address owned by the bot wallet and restart. The bot verifies its runtime and owner before use.

### Manual FlashArbV3 deployment and fork tests

FlashArbV3 adds Balancer V3 WETH funding to the existing swap routes and lending options. It executes the two swaps, repays the lender and returns the contract's proceeds to its deploying wallet in the same transaction. The owner and runtime checks apply to the configured V3 address. [Balancer V3 flash loans](https://docs.balancer.fi/concepts/vault/flash-loans.html)

```sh
npm run build:contract -- v3
npm run build
FORK_BLOCK_NUMBER=26451239 npm run mev-v3-fork-test
npm run --silent mev:v3:bytecode
```

The fork suite signs fake-funded transactions and submits them to the local Anvil node via Ethereum JSON-RPC. The last command prints creation bytecode for deployment from the bot wallet. The constructor takes no arguments. After deploying and settling any outstanding bot transactions, configure the new address as `MEV_V3_CONTRACT_ADDRESS` with any V2 address setting removed, then restart. Use `MEV_FUNDING=auto` to compare all four funding sources or `MEV_FUNDING=balancer` for Balancer V3. Live MEV continues to use the configured private bundle destinations.

Successful routes settle the loan and forward net proceeds and relevant route leftovers to the owner. An owner-only recovery path handles assets transferred to the contract outside a route. For manual deployment, use `npm run --silent mev:v2:bytecode` to obtain the public creation data and deploy from the bot wallet on Ethereum mainnet. If you change the Solidity source, rebuild it with `npm run build:contract` using `solc` 0.8.26, then run `npm run build`.

## Commands and key settings

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript. |
| `npm run typecheck` | Check types without rebuilding. |
| `npm start` | Run the local dashboard, spot loop, and configured MEV scanner. |
| `npm run scan` | Read-only spot universe scan. |
| `npm run mev:scan -- 3` | Read-only paper MEV scan for three blocks. |
| `npm run backtest` | Backtest rules and perform a walk-forward ML evaluation locally. |
| `npm run --silent wallet:address` | Initialize or show the public bot address. |
| `npm run --silent wallet:export -- <absolute-path>` | Export the existing key to a new owner-only file outside the checkout. |
| `npm run --silent dashboard:password` | Read the local operator credential for live actions. |

| Setting | Purpose |
| --- | --- |
| `RPC_URL` | Ethereum mainnet read RPC. |
| `SEND_RPC_URL` | Live submission endpoint, used only when signing is explicitly enabled. |
| `ALLOW_LIVE_TRADING` | Master signing switch. Off by default. |
| `PORT`, `DATA_DIR`, `WALLET_KEY_FILE` | Local dashboard port, state directory and optional protected key import. |
| `TOKEN_MODE`, `TOKEN_LIST_URLS`, `MEV_UNIVERSE` | Spot token strategy and separate MEV list scope. |
| `MEV_V2_CONTRACT_ADDRESS` | Optional existing FlashArbV2 deployment owned by the bot wallet. |
| `MEV_FUNDING`, `MEV_MIN_POOL_WETH`, `MEV_MIN_NET_USD` | V2 funding selection, depth and profit floors. |
| `MEV_BUILDERS`, `MEV_BUILDER_TIP_PCT`, `MEV_MAX_TRACKED_POOLS`, `MEV_MAX_SIMS_PER_BLOCK` | Bundle destinations, builder bid, active read budget and candidate simulation budget. |

Use one running bot per wallet. Back up the wallet and its state, including `state.json`, `wallet-transaction.json`, and MEV journal files. Preserve the journals if a signed transaction cannot be reconciled. A restart restores monitoring and resets both live arming flags.
