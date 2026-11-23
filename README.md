# ETH Token Bot

This Node.js bot runs Ethereum spot strategies and scans for flash-loan arbitrage on Ethereum, Arbitrum and Solana. It runs on macOS, Linux and Windows. The Ethereum spot engine supports momentum rules or a calibrated ML model. Each arbitrage worker checks loan repayment, fees and expected proceeds before submitting a trade.

Each network on the dashboard shows its last confirmed profitable automatic trade and links to the transaction. This record starts with automatic orders submitted by a release that tracks their origin and survives restarts. Manual tests appear in the activity history and count toward the Ethereum submission totals. A failed simulation is an off-chain evaluation.

`ALLOW_LIVE_TRADING=off` is the default. It disables all mainnet signing from the bot, including trades, gas top-ups, contract deployment, and MEV bundles. Paper spot and MEV scans use public state and leave the wallet unfunded. Ethereum starts disarmed by default. With `ETHEREUM_AUTO_ARM=on`, the service restores explicitly armed modes after startup readiness checks. An explicit disarm or panic saves the stop across restarts.

## 1. Install and configure

Install [Node.js 22 or later](https://nodejs.org/en/download), Git, and an Ethereum mainnet read RPC endpoint. Historical replay requires an archive-capable RPC. MEV paper simulation requires `eth_call` state overrides. For Windows PowerShell, use `npm.cmd` in place of `npm` if execution policy blocks the PowerShell npm shim.

```sh
git clone https://github.com/cutiapreta/flash-swaptrading-bot.git
cd flash-swaptrading-bot
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

The exported file contains one `0x`-prefixed private key in plaintext. The command prints the public address and destination, with the key stored in the restricted file. Keep it in encrypted offline storage. Anyone who obtains the key can spend the wallet’s funds. Share the repository and `.env.example` when handing the project to someone. Keep your `.env`, `DATA_DIR`, and private key backups local.

**To restore or import:** Before starting, set `WALLET_KEY_FILE` in `.env` to the absolute path of a protected file containing one `0x`-prefixed private key. On macOS or Linux, set `chmod 600 /absolute/path/to/wallet.key`. On Windows use an owner-only NTFS file, such as a file created by the export command. Run `npm run --silent wallet:address` and verify the address against your existing public address before funding it. If you are restoring an existing bot, also restore its data directory and wallet metadata so the bot can reconcile positions and in-flight transactions.

To reuse a Mac Keychain wallet on another platform, export it from the original checkout on the Mac, transfer the protected backup securely, and set `WALLET_KEY_FILE` on the new machine. Always verify the public address. A different key requires a separate `DATA_DIR`; keep the original wallet and state together.

## 3. Dashboard and localhost troubleshooting

The dashboard uses HTTP at `http://127.0.0.1:7777`. Use the port configured by `PORT` if you changed it. Arming and contract changes require the typed confirmation shown in the dashboard. Keep the service bound to loopback and use an authenticated gateway or a private tunnel for remote access. The AWS gateway uses a browser client certificate.

| Symptom | Check |
| --- | --- |
| Connection refused | Run `npm run build` and `npm start` from the checkout, then check the terminal output. Use the displayed loopback port. If another process is already listening, stop the duplicate or set an unused `PORT`, such as `7778`, in `.env` and restart. |
| Dashboard is open and paper scan is still starting | Check `/api/ready` and the startup status on the page. Market discovery, archive history and MEV pool discovery use the configured RPC. Use `/api/health` to check the HTTP process. |
| Chain or RPC error | Use an Ethereum mainnet endpoint. The RPC must report chain ID `1`. Keep the endpoint credentials inside `.env`. A provider without history or state overrides can limit backtests and eligibility simulations. |
| Browser is on another device, container or remote host | `127.0.0.1` points to that device or environment. Open the dashboard on the host running the bot. Keep the wallet operator interface bound to loopback. |

```sh
curl http://127.0.0.1:7777/api/health
curl http://127.0.0.1:7777/api/ready
```

On Windows PowerShell, use `curl.exe` for these commands.

## 4. Arbitrage venues and funding

The FlashArb proxy supports Uniswap v2/v3, SushiSwap v2/v3, and PancakeSwap v2/v3 WETH pairs, plus hook-free, static-fee Uniswap v4 ETH or WETH pools and two approved Curve Tricrypto-NG pools. Curve supports WETH/USDC, WETH/USDT, and WETH/WBTC routes with an external flash lender on the buy leg. Funding can come from the buy pool, Aave V3, Morpho Blue, Balancer V3, or SparkLend. `MEV_FUNDING=auto` compares the available sources. Use `pool`, `aave`, `morpho`, `balancer`, or `spark` to select one source. The scanner uses the capabilities of the selected release and reads the actual repayment and gas costs in simulations.

For an automatic Ethereum trade that buys on Curve, the scanner can also test a Morpho loan between two measured sizes. It tests that amount alongside the original sizes at the same block when the pool quotes suggest a higher payout there. Each size must pass the executor simulation and the selected trade must cover its gas and profit floor.

The searcher checks canonical factory or PoolManager state. It compares live pool depth, quotes candidate sizes at a consistent block, and rejects candidates that fail the profit floor after gas and any applicable flash-loan premium and builder tip. The V4 scanner restricts compatibility to pool types the contract can settle. Tokens from the public Ethereum token lists are indexed in paced batches. `MEV_UNIVERSE=spot` restricts the sweep to the spot and core universe, and `MEV_MAX_TRACKED_POOLS` limits active per-block reads.

For a live bundle, expand the target block in the MEV activity table to see the submission lead time, quoted gas budget and builder payment, and each builder's response time. The table reserves space for the five most recent submissions. Titan and Quasar traces can show what happened to an acknowledged bundle after it missed its target block. A bundle is marked landed after the bot verifies its on-chain receipt. [Titan tracing](https://docs.titanbuilder.xyz/bundle-tracing) · [Quasar tracing](https://docs.quasar.win/bundle-tracing)

MEV pool reads use bounded batches pinned to the same block. If a batch fails validation, the scanner can rank routes from the batches that pass. The bot checks gas for shortlisted live routes before ranking them, and keeps the configured minimum net profit on the signed transaction. The bot submits bundles directly and in parallel to Flashbots, Titan, Beaverbuild, and Quasar by default. `MEV_BUILDERS` configures bundle destinations. `SEND_RPC_URL` separately configures the spot transaction RPC, which defaults to Flashbots Protect.

When the target block has enough time left, the live search can use one extra exact gas check for an alternate simulated amount or funding source, or for a route close to covering its estimated costs. The selected bundle still has to pass a final simulation with the signed gas limit and profit floor.

Ethereum ranks routes using fresh pool state and recent execution simulations when comparable. A successful sample can carry a tested loan size and lender into the next scan. When ranking comparable two-swap routes on Ethereum, the scanner can reuse a recent gas estimate for the same pools, loan size, lender and contract. Each live order still gets its own gas estimate before signing. Repeated consistent swap failures are retried less often so other routes get simulation time. Direct submission can admit a near miss for exact gas estimation using the minimum allowed priority fee. For protected transactions, the fee estimate can use fewer blocks when that affords a higher priority fee within the existing budget and profit floor. Final gas, freshness and profit checks apply before signing. When restoring the saved live setting after a restart, the bot can recheck up to two profitable paper quotes from the current Ethereum block after it verifies the deployed proxy. It simulates them again using the live contract and pending state before signing.

Live MEV can use a different bid after 30 minutes without a confirmed landing. Set `MEV_IDLE_MIN_NET_USD` to a positive floor such as `0.01` and `MEV_IDLE_BUILDER_TIP_PCT` to an after-gas share such as `0.80`. The bid is capped to leave the configured net minimum after gas. A confirmed settlement returns the bot to its normal policy. The idle settings default to the normal values.

`MEV_IDLE_GAS_PADDING_PCT` controls the extra gas above the estimate while idle. It defaults to 25%. A smaller buffer can free room for the builder bid and can also leave less margin for changes in gas usage. The bot simulates using the exact gas limit before sending and budgets the full limit in the profit floor.

When two-swap routes through the same Ethereum v3 buy pool repeatedly fail to transfer the output token, the scanner checks the pool's token balance on a new block. It can skip a route if selling that entire balance at the exit's spot price, even with no fees or price impact, would return less WETH than the configured profit floor before repaying the loan or paying gas.

The bot's receipts record realized outcomes. A pool count or a profitable paper simulation alone does not establish realized returns. Inclusion depends on pool movement, gas, competing bids, RPC latency, and builder coverage. See [SushiSwap V3 core](https://github.com/sushiswap/v3-core), [PancakeSwap V3 addresses](https://developer.pancakeswap.finance/contracts/v3/addresses), [Uniswap v4 settlement](https://developers.uniswap.org/docs/protocols/v4/concepts/flash-accounting), [Aave V3 flash loans](https://aave.com/docs/aave-v3/smart-contracts/pool#flashloansimple), [Morpho Blue flash loans](https://docs.morpho.org/learn/concepts/flashloans/), and [Flashbots bundle troubleshooting](https://docs.flashbots.net/flashbots-auction/advanced/troubleshooting).

### Direct Ethereum transactions

Set `MEV_SUBMISSION=direct` to send signed Ethereum transactions through `RPC_URL`. Direct mode bids through the EIP-1559 priority fee. Set `MEV_DIRECT_BROADCAST_RPC_URLS` to a comma-separated list of up to two additional HTTPS mainnet RPC endpoints that accept raw public transactions. The bot sends the same signed bytes to all configured endpoints and tracks one transaction hash and nonce. Alchemy Ethereum endpoints use WebSocket head notifications to wake the HTTP scanner, with polling fallback.

Set `MAX_SWAP_NETWORK_FEE_USD` to the maximum network fee for one swap across the three chains (default $5). The signer applies the stricter of this ceiling and the applicable network limits. Ethereum and Arbitrum convert the fee from ETH. Solana values its base and priority fees in USDC using the protected first-leg quote. Account rent is tracked separately. Contract deployment and upgrade actions have their own fee confirmation.

Direct mode scans in paper mode with the bundled implementation while the gas caps are zero. To enable live direct sends, set `MEV_DIRECT_MAX_GAS_USD` and `MEV_DIRECT_DAILY_GAS_USD`, restart the bot, and explicitly arm MEV. The daily cap includes confirmed direct gas spend from the most recent 24 hourly periods and the current hour. `MEV_DIRECT_MIN_NET_USD` is the minimum after the full gas budget and lender repayment. `MEV_DIRECT_MAX_PRIORITY_GWEI` caps the priority fee per gas.

The bot simulates the exact order in the decision block and against the RPC node’s pending state, then checks the head again before broadcasting. It clamps the priority bid to the gas budget, required profit, and a 10% reserve of the simulated payout to allow for price movement. Public raw submissions target the next block and keep the wallet nonce reserved until a receipt or confirmed replacement. A public transaction mined after its deadline may still spend gas.

Set `MEV_DIRECT_PROTECTED=on` to use deadline-protected private transactions in direct mode. Set `MEV_DIRECT_PROTECTED_BLOCKS` to 1, 2 or 3 to choose how many blocks can include an ordinary automatic order. The default is 3. At 1 the order targets only the next block, so receipt and nonce reconciliation can finish two blocks earlier. A longer window gives builders more opportunities to include the same signature if the spread persists and the base fee is affordable. The signed fee cap and minimum payout apply throughout. The dashboard records how long the pool snapshot, route preparation, final checks, signing and RPC acknowledgement took for new direct orders. If the relay initially reports a pending transaction without a reason, the bot checks again on subsequent eligible block heights and records the observations in the dashboard. The on-chain order and relay use the same deadline. A supported Alchemy Ethereum endpoint provides a second entry point to the same Flashbots builder network. The bot checks chain receipts and confirmed nonce use before freeing the wallet after a missed deadline. [Flashbots private transaction API](https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint#eth_sendprivatetransaction) · [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559)

Set `MEV_DIRECT_PREMIUM_MAX_GAS_USD=20` to opt into faster bids for strong routes. Premium bids must retain at least $5 or the full padded gas budget as net profit, whichever is higher. Regular gas caps still apply to ordinary bids. Each premium bid is limited by the per-swap ceiling and the remaining premium allowance after confirmed direct gas spend. With protected submission enabled, `MEV_DIRECT_PREMIUM_TIP_BUMP_PCT` can raise the requested priority fee on eligible automatic premium orders by 0–25%. The default is 0. A setting of 10 raises a 2 gwei priority target to 2.2 gwei when both the fee budget and retained-profit checks allow it. A wallet with both live modes armed can use the existing USDC top-up when a qualifying premium route needs more ETH. After the top-up settles, the scanner evaluates a fresh route. The wallet needs enough ETH upfront for the top-up transaction itself.

The bot targets a confirmed direct fill every 30 minutes. After 25 minutes without a confirmed direct fill, it checks up to eight routes instead of the usual three, favoring extra tokens and checking more sizes when the current head still has time. Tune the extended route budget with `MEV_DIRECT_CADENCE_MAX_ROUTES`. The dashboard reports the last confirmed direct fill, queued and unrecovered block reads, and the previous 30 minutes of activity. For the best preliminary two-swap estimate in that window, it shows the source block, venues and loan size. When the bot recorded a decision for that exact offer, the dashboard shows the reason alongside the original estimate. The scanner backfills brief gaps in the background and uses current-head data for live sends. Transaction timing depends on available price spreads, gas, and Ethereum inclusion.

By default Ethereum and Arbitrum cap the principal at $1,000,000 per loan. Solana defaults to 250 USDC. To let each scanner size loans using available lender liquidity, set these values in the service environment and restart the bot.

```dotenv
MEV_MAX_LOAN_USD=unlimited
SOLANA_LOAN_USDC=unlimited
```

You can also supply a numeric limit for either setting. The scanners compare sizes using executable swap quotes. A deeper loan can return less because of price impact, and real-time lender balances can change. The network fee budgets, repayment checks and minimum profit rules still apply.


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

## 6. Deploy and upgrade the FlashArb proxy

New deployments use the FlashArb proxy. The repository keeps the original V2 and V3 sources and bytecode for deployed-contract verification, receipt recovery, and fork tests.

Paper scanning is available after startup. The default `ALLOW_LIVE_TRADING=off` blocks signing, including contract actions. Set it to `on` and restart the bot when you want to authorize a deployment or upgrade.

1. Open [the local dashboard](http://127.0.0.1:7777), wait for the wallet to be ready, and select **Deploy upgradeable FlashArb**. The dialog shows the implementation hash, the estimated fee, and the exact maximum gas charge.
2. Type `DEPLOY` to confirm. One transaction creates the proxy and its initial implementation. The bootstrapped proxy uses the bot wallet as its trading owner and upgrade admin.
3. The bot disarms Spot and MEV before signing. It selects the proxy after verifying the receipt, proxy bytecode, ERC-1967 slots, implementation bytecode, and wallet ownership. Use **Arm MEV** separately when you want live arbitrage. An existing standalone deployment remains selected until the proxy passes verification.
4. When a later bot release includes a new approved implementation, choose **Upgrade FlashArb implementation** and confirm with `UPGRADE`. One transaction creates and activates the new implementation at the same proxy address. The gas quote covers the implementation deployment and switch. An upgrade also disarms both live modes.

The current Ethereum implementation can borrow WETH from Morpho Blue and execute a cycle of three or four swaps. For these cycles, the scanner also checks SushiSwap v3 and PancakeSwap v3 pools for selected WETH, WBTC and stablecoin pairs using each venue's Ethereum quoter. The scanner quotes each leg at the same block, checks the full transaction against the proxy, and applies the configured net profit floor and fee limits before signing. The dashboard shows the pools and exact quotes checked. Proxies running an older implementation can observe these routes and continue executing supported two-swap routes.

For these Ethereum cycles, the scanner compares sizes on the same pools, including amounts above 512 WETH when Morpho has the funds. It uses modeled proceeds to select candidates for the existing 12 exact-quote slots.

Profitable trades repay the lender and forward proceeds and relevant route leftovers to the bot wallet in one transaction. Call the owner-only `sweep` function on the proxy to recover assets transferred to it outside a route.

For maintainers, keep the trading owner in persistent slot zero, the execution lock in transient slot zero, and the existing execution and settlement interfaces compatible. Keep previously supported implementation runtimes in the bot's release list so existing proxies can still operate after a software update. Rebuild with solc 0.8.26, then verify the upgrade on a pinned Ethereum fork using fake funds.

```sh
npm run build:contract -- logic-v3
npm run build
npm run wallet:local-test
FORK_BLOCK_NUMBER=26451239 npm run mev-proxy-fork-test
FORK_BLOCK_NUMBER=26468992 npm run mev-path-fork-test
```

The proxy uses standardized implementation and admin slots. [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967) · [SparkLend Ethereum deployment verification](https://docs.spark.fi/assets/Chainsecurity-SparkLend-Deployment-Verification.pdf)

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

| Setting | Purpose |
| --- | --- |
| `RPC_URL` | Ethereum mainnet read RPC. |
| `SEND_RPC_URL` | Live submission endpoint, used only when signing is explicitly enabled. |
| `ALLOW_LIVE_TRADING` | Master signing switch. Off by default. |
| `PORT`, `DATA_DIR`, `WALLET_KEY_FILE` | Local dashboard port, state directory and optional protected key import. |
| `TOKEN_MODE`, `TOKEN_LIST_URLS`, `MEV_UNIVERSE` | Spot token strategy and separate MEV list scope. |
| `MEV_V2_CONTRACT_ADDRESS` | Optional existing FlashArbV2 deployment owned by the bot wallet. |
| `MEV_FUNDING`, `MEV_MIN_POOL_WETH`, `MEV_MIN_NET_USD` | Funding selection, pool depth, and net profit floor. |
| `MEV_BUILDERS`, `MEV_BUILDER_TIP_PCT`, `MEV_MAX_TRACKED_POOLS`, `MEV_MAX_SIMS_PER_BLOCK` | Bundle destinations, builder bid, active read budget and candidate simulation budget. |

Use one running bot per wallet. Back up the wallet and its state, including `state.json`, `wallet-transaction.json`, and MEV journal files. Preserve the journals if a signed transaction cannot be reconciled. A restart restores monitoring and resets both live arming flags.

## Arbitrum One and Solana

The dashboard can run a separate Arbitrum One scanner and a Solana scanner alongside Ethereum. Each flash loan, swap cycle, and repayment happens on one network. Fund gas on the network where the transaction runs.

### Arbitrum One

Set `ARBITRUM=on` to start scanning Aave V3 WETH flash-loan routes across Uniswap v3 and hook-free v4 pools. The scanner discovers liquid pools for USDC, USDC.e, USDT, WBTC, ARB, LINK, GMX, wstETH, and rETH against WETH or native ETH. Set `ARBITRUM_RPC_URL` if you have a dedicated provider. The public fallback is the official Arbitrum One RPC. The scanner queries chain ID 42161 and uses the Arbitrum L2 block number for deadlines.

```sh
npm run build
npm run arbitrum:scan
```

For deployment, set `ARBITRUM_OWNER_ADDRESS` to the EVM bot wallet and fund it with native ETH on Arbitrum One. Preview the maximum deployment fee, then explicitly opt in to signing and run deployment. The argument is the maximum deployment fee in USD.

```sh
npm run arbitrum:quote
ALLOW_LIVE_TRADING=on npm run arbitrum:deploy -- 2
```

New deployments create an ERC-1967 proxy and its first implementation in one transaction. Set `ARBITRUM_EXECUTOR_ADDRESS` to the verified proxy address, `ARBITRUM_DEPLOYMENT_TX` to its deployment transaction hash, and `ARBITRUM_RELEASE_HASH` to the reported implementation runtime hash. Restart the service. The worker verifies the proxy bytecode, admin, trading owner and implementation bytecode before signing, then pins the expected implementation in each trade.

For a later release with a new implementation, disarm Arbitrum and wait for any pending transaction to settle. Build the new release, keep `ARBITRUM_EXECUTOR_ADDRESS` set to the proxy, and keep `ARBITRUM_RELEASE_HASH` set to the currently installed implementation for the upgrade.

```sh
npm run arbitrum:upgrade:quote
ALLOW_LIVE_TRADING=on npm run arbitrum:upgrade -- 2
```

The upgrade deploys the new implementation and activates it in one transaction at the existing proxy address. Once verified, record the new `ARBITRUM_RELEASE_HASH`, restart, and re-arm Arbitrum. The deployment and upgrade commands journal each signed transaction before broadcasting and reconcile its hash on retry. A standalone executor stays supported while migrating to the new proxy.

With `ARBITRUM_LIVE=on` and global signing enabled, the worker submits qualifying routes after a pending-state simulation. Default limits are $0.50 per transaction, $2 over 24 hours and at least $0.05 modeled net after padded fees. An included revert still costs gas.

Arbitrum uses same-block quotes at several loan sizes. Every regular scan requests exact quotes for potentially profitable paths and paths with unavailable starting prices. Exact quote requests for routes below the marginal repayment bound are scheduled at the base loan sizes across ten regular scans. When more than 96 sell quotes qualify for a retry, the scanner prioritizes exits that could repay the loan and exits with an unknown price. One rotating slot remains available for other exits. The dashboard shows how many unresolved legs exceeded the retry budget, lacked an eligible reader, or failed during the retry. The standalone scan command and manual tests request quotes for the full enabled market. The additional size probe explores amounts through 64 WETH and refines around recent competitive quotes. With a limit above $1 million or with `unlimited`, it periodically tests larger sizes up to Aave's available WETH at the quote block. Morpho multi-hop routes use the available balance of the borrowed asset at that block and rotate intermediate sizes through the funded limit. The dashboard reports the best completed quote after the lender fee and before gas.

The current Arbitrum implementation also supports three- and four-swap cycles funded by Morpho Blue in native USDC or WETH. The scanner checks Uniswap v3 pools at the 0.01%, 0.05%, 0.3% and 1% fee tiers, plus Aero Slipstream pools, among WETH, USDC, ARB and USDG. The proxy repays the loan and sends the surplus in the borrowed token to the trading wallet. The dashboard shows completed quotes and the implementation status while older releases continue scanning.

During a periodic two-swap pool refresh, an eligible multi-hop scan can start from the same L2 block while discovery runs. Both scans share the block's ETH price read. The Arbitrum state in `/api/state` includes `lastPoolRefresh`, which reports the source block, how long the refresh took, and whether multi-hop work started before it finished.

When no fixed-size quote covers the profit floor after the 10% payout reserve, the scanner uses quotes from the same pools and block to estimate an intermediate loan size. It checks at most one extra size per borrowed asset. The dashboard compares the best quotes before gas. Live execution requires 90% of the payout to cover both padded gas and the $0.05 minimum, followed by a pending-state simulation.

If an automatic Arbitrum order fails its freshness check, the dashboard shows that order's route, loan size, quote block, and the RPC head used for the check. It distinguishes an old quote from a late or future-dated RPC header. The latest such rejection stays visible until the worker restarts.

To test with fake funds, use an Arbitrum archive endpoint with state access at the selected L2 block.

```sh
npm run build:contract -- arbitrum-logic-v2
npm run build
FORK_RPC_URL='<Arbitrum archive RPC URL>' FORK_BLOCK_NUMBER='<L2 block number>' node scripts/fork-test.mjs cli-arbitrum-contract-forktest
FORK_RPC_URL='<Arbitrum archive RPC URL>' FORK_BLOCK_NUMBER=526440238 npm run arbitrum:path-fork-test
```

### Solana

Create a Solana keypair in private local storage and copy only its public address into `SOLANA_WALLET_ADDRESS`. Never use the Ethereum wallet key as a Solana seed. The scanner uses Kamino USDC and Jupiter Build instructions for two-pool SOL/USDC routes. It checks composed transactions through simulation and starts in paper mode. If Jupiter confirms that the price moved beyond the slippage limit during the final check, the live worker can check one other qualifying route before the next scan. That route must pass its own simulation and profit checks. Set `SOLANA=on` to include it in the dashboard. A dedicated `SOLANA_RPC_URL` and `JUPITER_API_KEY` are optional.

```sh
mkdir -p -m 700 data
solana-keygen new --silent --outfile data/solana-bot.json
solana-keygen pubkey data/solana-bot.json
npm run solana:scan
npm run solana:test
```


For live Solana, set `ALLOW_LIVE_TRADING=on`, `SOLANA_LIVE=on`, and `SOLANA_WALLET_KEY_FILE` to the absolute path of the owner-only Solana CLI JSON keypair. Restart and arm Solana from the dashboard. The signer must match `SOLANA_WALLET_ADDRESS`. The worker restores the stored arming choice after restart and uses the immutable Lighthouse program to enforce a post-repayment wallet profit floor. It keeps one submitted signature pending until it settles or expires.

Set `SOLANA_FAST_SCAN=on` and restart to shorten the pause from 12 seconds to 10.5 seconds when both directions of an automatic live scan return clean quotes below the profit floor. Each poll finishes before the next starts. With this option, the process allows up to 30 Jupiter Build requests per rolling minute and waits when either direction reports a provider rate limit. The Solana status API includes the next scheduled scan time and the end of any provider cooldown. Actual intervals also include quote time. Faster polling can consume more of your RPC and Jupiter allowance.

The default Solana minimum is 0.05 USDC after transaction fees and any in-transaction token-account rent. The default network fee ceiling is 0.00005 SOL per transaction and 0.002 SOL over 24 hours. The worker maintains a 0.015 SOL gas reserve. A transaction that lands and reverts can still pay its network fee.

With `SOLANA_LOAN_USDC=unlimited`, regular scans rotate through progressively larger sizes up to the latest observed Kamino USDC liquidity. Each scan checks the reserve again before requesting swap quotes. A standalone scan starts at 250 USDC. A numeric setting caps regular sizing at the configured amount. Regular scans rotate first-leg quotes across Whirlpool, Raydium CLMM, Meteora DLMM, PancakeSwap, SolFi V2 and BisonFi at small, intermediate and maximum loan sizes. For each first leg, the scanner asks Jupiter for a direct return quote across the other five entry venues plus Kipseli and ZeroFi. All seven possible exits share one quote request. If that return is unavailable or its instruction layout or size prevents assembly, the scanner can request a separate quote from the paired venue. If simulation identifies Jupiter slippage specifically on the grouped return swap, an ordinary scan can try the paired return once while the original entry quote is fresh. The logs identify the failing instruction and its program error code when the RPC provides them. A worker that already received a qualifying route can also rebuild the return after a confirmed slippage rejection in its final check. The activity log names the venues used in each returned quote. The scanner also probes near recent competitive quotes. A losing quote at the smallest regular loan size can trigger one smaller probe. Further refinement below that size requires positive quoted proceeds after the lender fee. Network fees and full execution simulation are checked before the worker can sign.

The dashboard's Arbitrum One and Solana cards show each scanner's latest block or slot, deployment or program verification, recent route logs, and transaction receipts. Set `ARBITRUM_DEPLOYMENT_TX` to show the verified Arbitrum deployment receipt and timestamp.

An explicitly authorized one-time mainnet smoke test keeps the usual maximum network fee and waits for positive swap proceeds after repayment. The test can spend that transaction's network fee. Solana also requires proceeds to cover any token-account rent. The dashboard shows whether the one-time test was queued, submitted, settled, or expired.
