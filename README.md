# ETH Token Bot

Ethereum mainnet pe ERC-20 tokens ko **Uniswap v3** pe USDC ke against trade karne wala bot. Ye tumhare Mac pe 24/7 chalta hai, aur dashboard **http://localhost:7777** pe dikhta hai.

> Koi bhi strategy profit ki guarantee nahi deti. Sirf utna paisa lagao jitna poora doob jaye to bhi chalega.

## Kya chal raha hai
- Bot ek macOS **LaunchAgent** ke roop mein chalta hai: login pe khud start hota hai, crash ho to restart hota hai, aur chalte waqt Mac ko sleep nahi hone deta (`caffeinate`).
- **Paper trading** ($50 virtual) hamesha asli prices ke saath chalti hai.
- **Live spot aur MEV** har startup par disarmed hain. Mainnet signing ke liye `.env` mein `ALLOW_LIVE_TRADING=on` aur dashboard se explicit arm dono chahiye.

## Local setup

Use Node.js 22 or later (`nvm use` with the checked-in `.nvmrc`). Copy `.env.example` to `.env`, enter an Ethereum mainnet read RPC in `RPC_URL`, then run `npm ci && npm run build && npm start`. Keep `ALLOW_LIVE_TRADING=off` for paper operation. Backfill uses archive `eth_call`, and paper safety/MEV simulation uses RPC state overrides.

At `http://localhost:7777`, sign in as `operator` with the password returned by `npm run --silent service:token`. The password is generated on first server startup and stored under the bot's data directory with owner-only permissions. The dashboard binds to loopback. `npm run service:status` checks both HTTP reachability and completion of a recent market cycle. If upgrading an existing LaunchAgent, reinstall it with the supported Node version to pick up the managed logging entry point.

`ALLOW_LIVE_TRADING=off` disables every broadcast, including automatic spot exits, Panic sells, gas top-ups, MEV deployment and bundles. With live signing allowed, spot exits run while spot is armed. Panic can request liquidation while spot is disarmed, after any in-flight transaction settles. Disarm stops new automated spot and MEV actions. Previously submitted transactions can still settle.

Keep a backup of the data directory and use one running bot per wallet. The wallet stays blocked if a signed transaction cannot be reconciled by hash. Preserve `state.json`, `wallet-transaction.json`, and `mev.json` while checking the transaction and provider status. Restart after repairing a storage failure so the bot can reconcile the existing journal.

## Sab tokens (TOKEN_MODE=all)
Bot sirf 6 fixed tokens nahi dekhta. Ye **saare listed Ethereum tokens** scan karta hai (CoinGecko + Uniswap token lists, ~5,400 tokens), lekin trade sirf wahi hote hain jo ye checks pass karein:
1. **Liquidity:** token ka Uniswap v3 pool (WETH ya USDC ke saath) kam se kam $30k gehra ho. Abhi ~200 tokens ye pass karte hain. Jinka gehra pool USDC ke saath hai, wo seedha USDC→token trade hote hain (1 hop, kam gas).
2. **Honeypot / hidden tax:** buy→sell ka simulation chain pe hota hai (koi transaction nahi bhejta). Token bech na sake, ya round-trip loss pool fees se 2% zyada ho, to reject. Ye check **har buy se theek pehle dobara** chalta hai.
3. **History:** naye tokens ke paas kam se kam 14 din ki price history honi chahiye. Isse fresh pump-and-dump se bachav hota hai.
4. **Stablecoins / pegged assets** (USDT, DAI, stETH…) skip hote hain, kyunki unme trend nahi hota.
5. **Long-tail limit:** nayi buy se pehle sabhi chhote token positions ka combined exposure check hota hai, default max 50% equity.

Universe har 24 ghante refresh hota hai. Uniswap v2-only tokens aur jo token lists mein nahi hain, wo scan nahi hote.

## Gas apne aap (auto gas top-up)
Jab wallet mein ETH kam ho (< 0.0015 ETH), bot **USDC se ~$3 ka ETH khud kharid leta hai**. Ye ek hi transaction hoti hai: USDC→WETH swap aur unwrap, Flashbots se private.
- Din mein max 4 top-ups, aur do top-ups ke beech kam se kam 15 minute.
- Har nayi buy ke baad bhi ~$3 USDC gas ke liye bacha ke rakhta hai.
- **Pehli baar thoda ETH (~0.001) tumhe bhejna padega**, kyunki pehli top-up transaction ke liye bhi gas chahiye.
- Top-up ko loss nahi gina jata (USDC bas "gas wallet" mein shift hota hai). Jo gas sach mein jalti hai, wahi P&L mein ghatai jaati hai.

## Live start karne ke steps
1. Paper aur local fork pe verify karne ke baad hi `.env` mein `ALLOW_LIVE_TRADING=on` set karo. **Private key ka backup lo.** Terminal mein ye chalao aur key safe jagah save karo. Kisi ko mat dikhana.
   ```bash
   security find-generic-password -s eth-token-bot -a bot-wallet -w
   ```
2. Bot wallet pe **Ethereum mainnet (ERC-20 network)** se bhejo: **USDC**, aur pehli baar **~0.001 ETH**.
3. Dashboard pe **Arm live trading** karo (`LIVE` type karke).

## AI signal model (intelligent-trading-bot se inspired)
[asavinov/intelligent-trading-bot](https://github.com/asavinov/intelligent-trading-bot) jaisi pipeline, TypeScript mein:
1. **Features:** har token-hour ke 21 features: 1h–7d returns (volatility se normalised), volatility, EMA20/50/200 se doori, RSI, 72h/168h high-low se doori, ETH ke against strength, aur ETH ka market regime.
2. **Labels:** kya price agle 48 ghante mein +1R (stop jitna upar) pehle chhuega ya −1R pehle.
3. **Model:** L2 logistic regression, sab tokens ka data milake (`src/ml.ts`).
4. **Walk-forward test:** har 3 din pe model dobara train hota hai. Training sirf un purane token-hours pe hoti hai jinke 48-hour outcomes tab tak known the.
5. **Gate (`ML_MODE=auto`):** earlier walk-forward predictions se threshold choose hota hai, phir final chronological holdout pe wahi threshold test hota hai. Auto mode requires enough completed trades, holdout AUC ≥ 0.55 by default, and performance ahead of both the rules and holding USDC. `ML_MODE=on` trained model ko force kar sakta hai. `off` rules use karta hai.
6. Model har 6 ghante mein dobara train hota hai. Dashboard final holdout metrics, earlier threshold calibration aur sabse strong features dikhata hai.

## Ek saath kai tokens
Bot ek saath **3 tokens tak** hold kar sakta hai (`MAX_POSITIONS`), har ek mein max 45% equity (`MAX_POSITION_PCT`). Har position ka apna stop-loss, target aur trailing stop hota hai. Har ghante max ek nayi entry.

## Bot ka dimaag (rules)
- **Market filter:** ETH apne 200-hour EMA ke upar ho aur wo EMA khud upar ja raha ho. Tabhi koi bhi buy hota hai. Bear market mein bot USDC mein baitha rehta hai.
- **Token chunna:** uptrend (price > EMA20 > EMA50, aur EMA200 ke upar), 3-din ka volatility-adjusted momentum ≥ 0.75σ, RSI 45–72, aur daily volatility ≥ 1.5%. Sabse strong token chuna jata hai.
- **Cost check:** asli Uniswap quote aur gas se round-trip cost nikalta hai. Target move cost ka 3 guna na ho to trade nahi.
- **Exits:** stop-loss (1.5× daily vol), take-profit (2.5R), trailing stop, trend tootne pe exit, time stop. Live exits ko armed spot, running process, fresh price aur gas chahiye.
- **Risk limits:**
  - Har trade mein ~2.5% equity risk
  - Din mein 6% loss pe nayi buying band
  - 25% drawdown pe halt
  - 3 failed transactions ke baad bhi halt
- **Execution:**
  - Exact-amount approvals
  - Fresh quote, 0.5% max slippage aur simulation har trade se pehle
  - Flashbots Protect by default (`SEND_RPC_URL`)
  - Har transaction pehle journal mein likhi jaati hai, taaki crash ke baad chain se reconcile ho sake

**Backtest:** signals and exits use a measured hourly close, then fill one hour later when that close was measured. Today's token universe, fees and gas price are used with assumed slippage. The simulator keeps forward-filled features across gaps, and holdout AUC uses only labels with observed hourly outcomes throughout the horizon.

**Gas ka asar ($50 pe):** backtest aur bot dono abhi ki gas price use karte hain. Gas ~1 gwei ho to ek $20 trade ka round trip ~$1.2 (~6%) padta hai, jo 3% cost limit se zyada hai, isliye bot trade nahi karta (backtest bhi 0 trades dikhata hai). Gas 0.2–0.4 gwei ho tab trades hote hain. Zyada capital ho to gas ka hissa chhota ho jata hai.

## MEV arbitrage (flash swaps + Flashbots bundles)
Trading ke saath bot har block (12 sec) ek MEV arbitrage scanner bhi chalata hai:
- Jin tokens ke 2 ya zyada WETH pools hain (Uniswap v3 ke fee tiers, Uniswap v2, SushiSwap), un sabki price ek hi RPC call mein padhi jaati hai.
- Agar ek token ek pool mein sasta aur doosre mein mehenga hai (dono pool fees ke baad bhi), to math se best size nikalta hai, phir asli contract ko `eth_call` mein chala ke exact profit check karta hai.
- **Armed** ho to private **Flashbots bundle** bhejta hai: sasta khareedo, mehenga becho, ek hi transaction mein. Ye flash swap hai, yaani apna capital nahi lagta (USDC use nahi hota). Profit ETH mein wallet mein aata hai.
- The contract (`contracts/FlashArb.sol`) reverts below the submitted profit floor. The searcher sets that floor using padded estimated gas at the target block's fee ceiling, the builder tip, and the configured minimum net profit. An included transaction that reverts can still consume gas. Builder acceptance and on-chain inclusion are tracked separately.
- **Sirf arbitrage.** Bot kabhi kisi ka front-run ya sandwich nahi karta.

Shuru mein ye **paper mode** mein hai: scan aur simulate karta hai, bhejta kuch nahi. Live signing enabled ho to dashboard pe **"Arm MEV"** dabao aur `MEV` type karo. Bot existing contract ko verify karta hai. Pehli deployment gas leti hai. Wallet ka main **Disarm** button MEV ko bhi band karta hai.

**Sach:** MEV duniya ki sabse competitive cheez hai. Professional searchers ke paas apne nodes aur builders ke saath setup hota hai, wo gaps milliseconds mein le jaate hain. Ghar ke Mac se jeet kam milegi, shayad bilkul nahi. Dashboard dikhata hai kitne blocks scan hue, is ghante sabse bada price gap kitna tha, kitne simulate hue aur kitne profitable the.

Settings: `MEV=off` (scanner band), `MEV_BUILDER_TIP_PCT=0.5` (after-gas profit ka kitna hissa builder ko bid), `MEV_MIN_NET_USD=0.05`, `MEV_MIN_POOL_WETH=2`, `MEV_BUILDERS=...`. Set `MEV_CONTRACT_ADDRESS` to adopt an existing FlashArb on an empty data directory. Arming checks the deployed bytecode and wallet ownership, and rejects a conflict with the saved address. Contract badlo to `npm run build:contract` (solc 0.8.26 chahiye).

## Commands
```bash
npm run service:status      # chal raha hai ya nahi
npm run service:logs        # last 60 log lines
npm run --silent service:token # localhost dashboard password
npm run service:restart     # code/settings badalne ke baad (build + restart)
npm run service:uninstall   # bot band karke LaunchAgent hatao
npm run scan                # token universe + safety checks dobara chalao (read-only)
npm run backtest            # strategy ko history pe chalao
npm run wallet:local-test   # disposable local Anvil chain; no upstream provider
```

For fork suites, install Anvil, build with `npm run build`, and pass the upstream **read-only** archive endpoint explicitly. Choose `FORK_BLOCK_NUMBER` to repeat a test at a pinned mainnet block. Each suite creates a loopback Anvil, a throwaway key and temporary state. Transactions run on the fork with fake funds.

```bash
FORK_RPC_URL='https://your-archive-provider' npm run fork-test
FORK_RPC_URL='https://your-archive-provider' npm run wallet:fork-test
FORK_RPC_URL='https://your-archive-provider' npm run mev-fork-test
```

## GitHub (private repo)
Code yahan save hai: **https://github.com/cutiapreta/eth-token-bot** (private). `.env` (Alchemy key) aur `data/` kabhi commit nahi hote (`.gitignore`). Private key Keychain mein hai, repo mein nahi.

Is Mac pe SSH key (`~/.ssh/id_ed25519`) GitHub se judi hai, to aage changes save karne ke liye:
```bash
git add -A && git commit -m "kya badla" && git push
```

## Settings (`.env`)
- **Mainnet signing:** `ALLOW_LIVE_TRADING` (`off` by default)
- **Risk:** `RISK_PER_TRADE_PCT`, `MAX_SLIPPAGE_BPS`, `MAX_ENTRY_GAS_GWEI`, `DAILY_LOSS_LIMIT_PCT`, `MAX_DRAWDOWN_PCT`, `MIN_GAS_ETH`, `APPROVAL_MODE`
- **Positions / AI:** `MAX_POSITIONS` (default 3), `MAX_POSITION_PCT` (0.45), `ML_MODE` (`auto`/`on`/`off`), `ML_MIN_AUC` (0.55)
- **Tokens:**
  - `TOKEN_MODE` (`all` ya `core`)
  - `MIN_POOL_USD` (default 30000)
  - `MAX_TOKENS` (default 300)
  - `MIN_HISTORY_DAYS` (default 14)
  - `MAX_ROUNDTRIP_TAX_PCT` (default 0.02)
  - `LONGTAIL_MAX_ALLOC_PCT` (default 0.5)
- **Gas:** `GAS_TOPUP` (`on`/`off`), `GAS_TOPUP_BELOW_ETH`, `GAS_TOPUP_USD`, `GAS_TOPUP_MAX_PER_DAY`
- **MEV:** `MEV` (`on`/`off`), `MEV_BUILDER_TIP_PCT`, `MEV_MIN_NET_USD`, `MEV_MIN_POOL_WETH`, `MEV_MAX_SIMS_PER_BLOCK`, `MEV_BUILDERS`, `MEV_CONTRACT_ADDRESS`
- **Baaki:** `LOOP_SECONDS`, `PAPER_START_USD`, `HISTORY_DAYS`

Galat value hogi to bot start hi nahi hoga (safety ke liye). Koi bhi setting badalne ke baad `npm run service:restart` chalao.

## Dhyan rakho
- Mac on aur charger pe rehna chahiye. Lid band hua to bot ruk jayega.
- Private key macOS Keychain mein hai (service `eth-token-bot`). Backup zaroor lo.
- Dashboard sirf isi Mac se khulta hai (127.0.0.1).
- Chhote tokens zyada risky hote hain. Safety checks honeypot aur tax pakadte hain, lekin rug-pull (team ka liquidity nikal lena) future mein ho sakta hai.
- Crypto profit pe India mein tax lagta hai. Apne CA se confirm kar lena.

## Files
| Path | Kya hai |
|---|---|
| `src/engine.ts` | main loop, decisions, deposit detection, gas top-up, risk limits |
| `src/strategy.ts` | indicators, entry/exit rules |
| `src/ml.ts` | AI features, labels, logistic regression, walk-forward |
| `src/backtest.ts` | multi-position simulator, research + AI gate |
| `src/tokens.ts` | token lists se candidates |
| `src/safety.ts` | honeypot / hidden-tax simulation |
| `src/market.ts` | pool discovery, prices, history |
| `src/executor.ts` | paper aur live swaps, gas top-up, contract deploy, MEV ke saath nonce gate |
| `src/mev/` | MEV arbitrage: pools dhundhna (`pools.ts`), har block scan + simulate (`searcher.ts`), Flashbots bundles (`bundles.ts`) |
| `contracts/FlashArb.sol` | flash-swap arbitrage contract (sirf owner chala sakta hai, kuch hold nahi karta) |
| `src/server.ts` + `public/` | localhost dashboard |
| `data/` | state, trades, logs, price history, token universe |
