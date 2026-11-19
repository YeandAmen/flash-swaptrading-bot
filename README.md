# ETH Token Bot

Ethereum mainnet pe ERC-20 tokens ko **Uniswap v3** pe USDC ke against trade karne wala bot. Ye tumhare Mac pe 24/7 chalta hai, aur dashboard **http://localhost:7777** pe dikhta hai.

> Koi bhi strategy profit ki guarantee nahi deti. Sirf utna paisa lagao jitna poora doob jaye to bhi chalega.

## Kya chal raha hai
- Bot ek macOS **LaunchAgent** ke roop mein chalta hai: login pe khud start hota hai, crash ho to restart hota hai, aur chalte waqt Mac ko sleep nahi hone deta (`caffeinate`).
- **Paper trading** ($50 virtual) hamesha asli prices ke saath chalti hai.
- **Live trading** sirf tab hoti hai jab tum dashboard pe **Arm live trading** karke `LIVE` type karo.

## Sab tokens (TOKEN_MODE=all)
Bot sirf 6 fixed tokens nahi dekhta. Ye **saare listed Ethereum tokens** scan karta hai (CoinGecko + Uniswap token lists, ~5,400 tokens), lekin trade sirf wahi hote hain jo ye checks pass karein:
1. **Liquidity:** token ka Uniswap v3 pool (WETH ya USDC ke saath) kam se kam $30k gehra ho. Abhi ~200 tokens ye pass karte hain. Jinka gehra pool USDC ke saath hai, wo seedha USDC→token trade hote hain (1 hop, kam gas).
2. **Honeypot / hidden tax:** buy→sell ka simulation chain pe hota hai (koi transaction nahi bhejta). Token bech na sake, ya round-trip loss pool fees se 2% zyada ho, to reject. Ye check **har buy se theek pehle dobara** chalta hai.
3. **History:** naye tokens ke paas kam se kam 14 din ki price history honi chahiye. Isse fresh pump-and-dump se bachav hota hai.
4. **Stablecoins / pegged assets** (USDT, DAI, stETH…) skip hote hain, kyunki unme trend nahi hota.
5. **Long-tail limit:** chhote tokens mein equity ka max 50% hi lagta hai.

Universe har 24 ghante refresh hota hai. Uniswap v2-only tokens aur jo token lists mein nahi hain, wo scan nahi hote.

## Gas apne aap (auto gas top-up)
Jab wallet mein ETH kam ho (< 0.0015 ETH), bot **USDC se ~$3 ka ETH khud kharid leta hai**. Ye ek hi transaction hoti hai: USDC→WETH swap aur unwrap, Flashbots se private.
- Din mein max 4 top-ups, aur do top-ups ke beech kam se kam 15 minute.
- Har nayi buy ke baad bhi ~$3 USDC gas ke liye bacha ke rakhta hai.
- **Pehli baar thoda ETH (~0.001) tumhe bhejna padega**, kyunki pehli top-up transaction ke liye bhi gas chahiye.
- Top-up ko loss nahi gina jata (USDC bas "gas wallet" mein shift hota hai). Jo gas sach mein jalti hai, wahi P&L mein ghatai jaati hai.

## Live start karne ke steps
1. **Private key ka backup lo.** Terminal mein ye chalao aur key safe jagah save karo. Kisi ko mat dikhana.
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
4. **Walk-forward test:** har 3 din ke data pe model sirf purane data se dobara train hota hai, aur agle din ke unseen data pe test hota hai (ITB ke `predict_rolling` jaisa).
5. **Gate (`ML_MODE=auto`):** AI tabhi buy decide karta hai jab unseen data pe uska AUC ≥ 0.55 ho **aur** wo rules aur USDC hold karne, dono se behtar raha ho. Warna rules chalte hain. `ML_MODE=on` forcibly on karta hai, `off` band.
6. Model har 6 ghante mein dobara train hota hai. Dashboard ke "AI signal model" card mein AUC, alag-alag thresholds ke results aur sabse strong features dikhte hain.

## Ek saath kai tokens
Bot ek saath **3 tokens tak** hold kar sakta hai (`MAX_POSITIONS`), har ek mein max 45% equity (`MAX_POSITION_PCT`). Har position ka apna stop-loss, target aur trailing stop hota hai. Har ghante max ek nayi entry.

## Bot ka dimaag (rules)
- **Market filter:** ETH apne 200-hour EMA ke upar ho aur wo EMA khud upar ja raha ho. Tabhi koi bhi buy hota hai. Bear market mein bot USDC mein baitha rehta hai.
- **Token chunna:** uptrend (price > EMA20 > EMA50, aur EMA200 ke upar), 3-din ka volatility-adjusted momentum ≥ 0.75σ, RSI 45–72, aur daily volatility ≥ 1.5%. Sabse strong token chuna jata hai.
- **Cost check:** asli Uniswap quote aur gas se round-trip cost nikalta hai. Target move cost ka 3 guna na ho to trade nahi.
- **Exits:** stop-loss (1.5× daily vol), take-profit (2.5R), trailing stop, trend tootne pe exit, time stop. Ye disarm ya halt hone pe bhi chalte rehte hain.
- **Risk limits:**
  - Har trade mein ~2.5% equity risk
  - Din mein 6% loss pe nayi buying band
  - 25% drawdown pe halt
  - 3 failed transactions ke baad bhi halt
- **Execution:**
  - Exact-amount approvals
  - Fresh quote, 0.5% max slippage aur simulation har trade se pehle
  - Flashbots Protect (MEV/sandwich protection)
  - Har transaction pehle journal mein likhi jaati hai, taaki crash ke baad chain se reconcile ho sake

**Backtest (pichle ~57 din, 84 tokens):** gas ~0.3 gwei pe ETH −32.6% gira, bot −6.3% pe raha (3 trades, max drawdown 7.4%). Survivorship bias hai (aaj ki token list use hoti hai), aur ye profit ka saboot nahi hai.

**Gas ka asar ($50 pe):** backtest aur bot dono abhi ki gas price use karte hain. Gas ~1 gwei ho to ek $20 trade ka round trip ~$1.2 (~6%) padta hai, jo 3% cost limit se zyada hai, isliye bot trade nahi karta (backtest bhi 0 trades dikhata hai). Gas 0.2–0.4 gwei ho tab trades hote hain. Zyada capital ho to gas ka hissa chhota ho jata hai.

## Commands
```bash
npm run service:status      # chal raha hai ya nahi
npm run service:logs        # last 60 log lines
npm run service:restart     # code/settings badalne ke baad (build + restart)
npm run service:uninstall   # bot band karke LaunchAgent hatao
npm run scan                # token universe + safety checks dobara chalao (read-only)
npm run backtest            # strategy ko history pe chalao
npm run fork-test           # live path ka test, mainnet fork pe nakli paise se
```

## GitHub (private repo)
Code yahan save hai: **https://github.com/cutiapreta/eth-token-bot** (private). `.env` (Alchemy key) aur `data/` kabhi commit nahi hote (`.gitignore`). Private key Keychain mein hai, repo mein nahi.

Is Mac pe SSH key (`~/.ssh/id_ed25519`) GitHub se judi hai, to aage changes save karne ke liye:
```bash
git add -A && git commit -m "kya badla" && git push
```

## Settings (`.env`)
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
| `src/executor.ts` | paper aur live swaps, gas top-up |
| `src/server.ts` + `public/` | localhost dashboard |
| `data/` | state, trades, logs, price history, token universe |
