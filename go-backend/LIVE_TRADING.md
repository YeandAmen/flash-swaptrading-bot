# Guarded Ethereum V2 execution

The Go backend can sign and submit BuyPool-funded arbitrage through an existing
FlashArb proxy running the retained Logic V4. It supports the same Uniswap V2,
SushiSwap V2 and PancakeSwap V2 routes as the Go scanner. Solidity sources are
unchanged. DeepSeek has no signing, arming, configuration or execution authority.

Live trading is **off by default**. Setting `ALLOW_LIVE_TRADING=on` enables
loading the signer but does not arm it. Every process starts disarmed, including
after a restart or previously armed session. Demo and live modes cannot be
combined. The `--once` command only scans and never initializes live execution.

## Wallet and deployment prerequisites

Use a dedicated trading wallet and an existing compatible proxy whose `owner`
is that wallet. This release does not deploy or upgrade contracts; the retained
original deployment tooling remains available. A deployment of the correct
proxy and Logic V4 is checked by exact runtime bytes and ownership at startup
and again before each order. Other implementations are rejected.

To create a new encrypted Ethereum V3 keystore locally:

```sh
go run ./cmd/wallet -out .secrets/wallet.json
```

The command prompts twice without echo, uses the standard geth scrypt settings,
refuses existing files, and prints only the public address and output path.
Back up the encrypted keystore and password separately. It does not fund the
wallet, deploy a proxy or enable trading. Existing V3 JSON keystores can also be
used when they match the proxy owner.

A background service additionally needs the password through a private file:

```sh
python3 scripts/setup-wallet-password.py --out /absolute/private/directory/wallet.password
```

This password file is plaintext and must be protected like a private key. Both
credential files must be regular, owner-only files (`chmod 600`); their parent
directories should be private. An OS secret manager can provision the password
file at service start. The key is decrypted in the Go process while running;
this is software signing, not a hardware wallet or protection from a compromised
operator account. The wallet, password and private key are never exposed by the
HTTP API, logged, passed to DeepSeek or committed to Git.

## Configure explicit limits

See [.env.example](.env.example). Export all settings from your local shell or
service manager; the Go backend does not automatically read `.env`:

- `RPC_URL`: Ethereum mainnet reads, including block-hash calls and pending simulation.
- `FLASH_ARB_PROXY` and `FLASH_ARB_OWNER`: public deployment and owner addresses.
- `WALLET_KEYSTORE_FILE` and `WALLET_PASSWORD_FILE`: private file paths above.
- `LIVE_MAX_GAS_WEI`: maximum complete gas envelope for one transaction.
- `LIVE_DAILY_GAS_WEI`: rolling 24-hour actual gas spending plus any pending reserve.
- `LIVE_MAX_PRINCIPAL_WEI`: maximum flash-swap input principal in WETH wei.
- `LIVE_MAX_FEE_PER_GAS_WEI`: maximum EIP-1559 fee cap per gas in wei.
- `MIN_NET_WEI`: required payout remaining after the full signed gas envelope.
- `LIVE_CONFIRMATIONS`: canonical confirmation depth, default 3, minimum 2.
- `GO_DATA_DIR`: persistent private journal directory, default `data/go-live`.
- `SEND_RPC_URL`: submission endpoint, default `https://rpc.flashbots.net/fast`.
- `ALLOW_LIVE_TRADING=on`: permits loading the signer; still starts disarmed.

All four live spending/principal limits are required positive integers. No
nonzero spending defaults are supplied. One ETH is `1000000000000000000` wei;
one gwei is `1000000000` wei. The flash principal comes from the buy pool, but
the wallet must hold enough ETH for the full gas envelope. Deployment requires
its own funding through the deployment tool. Set a shorter `SCAN_INTERVAL` if
needed for head timing, while accounting for your provider's request allowance.

The default send endpoint uses Flashbots Protect through `eth_sendRawTransaction`.
Changing it to a public RPC exposes transactions to the public mempool. There is
no automatic fallback to another endpoint. Read and send RPCs must both report
Ethereum chain ID 1. A mined revert, including an expired public order, can still
spend gas; the signed envelope is budgeted before broadcast.

## Arm, stop and review

Start `go run ./cmd/bot`, wait for a fresh successful scan, then use the local
dashboard. Type `ARM LIVE` followed by a space and the exact checksummed public
owner address and click **Arm live**. This authorizes automatic submissions of
qualifying routes within the configured limits for that process session.

**Disarm** stops future signing, new submissions and retries. It waits for a
submission section already in progress to return; an RPC send has an eight-second
timeout within the evaluation deadline. It cannot revoke a transaction already
received by a node or builder. Pending transactions continue to be reconciled
while disarmed. Reverted or unverified settlements disarm the bot and persist a
fault. After reviewing a settled fault, type `ACKNOWLEDGE` and the exact owner
address to clear that fault. This leaves the bot disarmed and preserves spending
history. An unresolved nonce cannot be acknowledged away.

Local control endpoints use the same Host/Origin and `X-Bot-UI: 1` protection as
the model endpoint:

| Endpoint | Effect |
| --- | --- |
| `POST /api/live/arm` | Requires a fresh scan and JSON `confirmation` with the arming phrase |
| `POST /api/live/disarm` | Stops future signing/submissions; no confirmation phrase |
| `POST /api/live/acknowledge` | Acknowledges a reviewed fault only if no nonce is unresolved |
| `GET /api/state` | Shows arming, fault, pending hash/reserve and last verified settlement |

Keep the service on loopback. These controls are not a public, authenticated
multi-user trading API.

## Order and recovery rules

Each candidate must pass all of the following before signing:

1. Current chain and head match the scanner snapshot; head time is recent.
2. Verified proxy/implementation bytes and owner match the retained deployment.
3. Principal and fee cap fit the explicit limits.
4. RPC gas estimation succeeds; a 25% gas buffer fits `GAS_BUDGET_UNITS`.
5. Full padded gas cost fits the per-order and rolling daily allowances.
6. The exact final calldata, fee fields and gas limit pass both block-hash and
   pending-state `eth_call`, with a payout floor covering full gas plus minimum net.
7. Confirmed and pending nonces match the journal's expected next nonce, wallet
   balance covers the full initial gas envelope, and the head is unchanged again.
8. A policy-limited signer accepts only a zero-value, chain-1 `executePinned`
   call with the approved implementation, configured token, V2 route and limits.
9. The signed bytes, nonce, hash and complete gas reserve are durably journaled
   before broadcast. The contract deadline is the next block; builder tip is zero.

Only one nonce can be in flight. Network uncertainty retains its nonce and full
gas reserve. If still armed, recovery may rebroadcast the identical bytes at
most three times, only before the target block and after a cooldown. It never
creates a new nonce because a send timed out. A signed record with zero durable
broadcast attempts can be discarded after expiry; any record with an attempted
send remains reserved until a canonical outcome is known.

Expired or dropped transactions are **not automatically assumed absent**.
Private pending state may be invisible to the read RPC. If an attempted send
expires without a receipt, the bot waits and blocks new trades. Cancelling or
replacing a stuck nonce currently requires operator handling through the wallet
or submission provider. There is no automatic fee-bump or cancellation signer.
If an unknown transaction consumes the nonce, the bot retains the reserve and
persists a fault rather than inventing its gas cost or trading through it.

Successful settlement requires the configured confirmation depth, canonical
block hash, valid receipt gas fields, and exactly one matching `Arbitrage` event
from the verified proxy. Reported net equals event payout minus actual receipt
gas (`gasUsed * effectiveGasPrice`). A revert records zero payout and its gas
loss. A successful receipt with an unverified payout is labelled `unverified`,
charges the known gas, and halts; it is not credited as profit. The most recent
settlement block is checked on later cycles to detect deeper reorganizations.

The journal uses owner-only files, atomic replacement, file/directory fsync and
an exclusive process lock. Corrupt, mismatched-wallet/proxy/chain journals fail
closed. **Keep one dedicated wallet with one persistent journal directory.** Do
not share its nonce with another bot or wallet, delete the journal, copy it into
an independent active deployment, or move to a fresh directory to reset limits.
Changing a spending limit does not erase pending reserves or confirmed spend.

## Validation boundaries

`python3 scripts/integration.py` runs the retained Solidity simulation test and
a signed, broadcast, mined arbitrage transaction on an isolated unforked Anvil
chain 31337. The integration checks actual wallet ETH increase against recorded
net after gas and confirms a restart retains settlement history while disarmed.
Its non-mainnet executor constructor and random test signer exist only in the
package's tests. Production configuration and the keystore signer require mainnet.

These tests use mock pool/token infrastructure around actual retained FlashArb
bytecode. They do not establish profitable mainnet opportunities, private-relay
inclusion, all token behavior or RPC reliability. No mainnet transaction needs
to be sent to validate this implementation locally.
