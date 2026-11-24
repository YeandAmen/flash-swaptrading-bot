# Go backend validation

Validated on 2026-11-24 with Go 1.26.1 on macOS. The module requires Go 1.25+.

## Guarded execution update

The following additional checks passed for the Ethereum V2 execution path:

- Race-enabled package tests and `go vet`, including encrypted-keystore policy,
  exact arming confirmation, fresh/pending simulations, gas/principal caps,
  durable pre-send reservations, duplicate prevention and exclusive journal ownership.
- Timeout and restart recovery retained the same signed transaction and nonce;
  retries reused identical bytes. Expired attempted sends retained their gas
  reserve. Expired records with zero durable broadcast attempts could be released.
- Receipt confirmation depth, reorganized receipts, unknown nonce replacements,
  missing payout events, reverted gas losses and explicit fault acknowledgement.
- Emergency disarm during an in-flight send waited for that submission section
  and prevented further signing.
- On isolated Anvil chain 31337, the Go executor signed, submitted and mined a
  transaction through actual retained FlashArb proxy/Logic V4 bytecode. The
  wallet's ETH increase exactly equalled verified event profit minus receipt gas.
  Restart preserved settlement and spending records and left execution disarmed.

These are local test-chain execution results using mock tokens and pools. No
transaction was submitted to mainnet, and no funded user wallet was loaded.
All signing tests used throwaway keys, including mainnet-domain signer policy tests.
Mainnet execution remains disabled in the running development service. The
original Solidity and TypeScript sources remain unchanged. The model prompt in
the Go adapter now distinguishes scan reports from live settlement records.

## Initial paper migration

| Check | Observed result |
| --- | --- |
| `go test -race -cover ./...` | All Go package tests passed; integration test skipped here and run separately below |
| `go vet ./...` | Passed |
| Five-second amount-out invariant fuzz test | Passed, 338,219 executions |
| Artifact provenance comparison | Go ABIs, runtime and creation bytecode matched retained upstream artifacts |
| Isolated Anvil integration | Passed using actual retained proxy and Logic V4 bytecode, mock V2 pools and tokens |
| Quote/execution parity | Go gross-profit quote exactly equalled the full Solidity simulation return |
| Excessive profit floor | Rejected by the full executor simulation |
| Simulation persistence | Pool balances unchanged after `eth_call` |
| Demo dashboard HTTP checks | Health, labelled demo state, disabled signing, security headers, HTML and JavaScript syntax passed |
| Read-only Ethereum mainnet scan | Block 26,485,094; nine pools read; zero warnings; zero candidates passed the configured screening floor |
| OpenRouter adapter | Mock-provider tests passed for auth header, bounded request, cooldown, disabled mode, error handling and redaction |

The mainnet observation is one snapshot, not a profitability or latency
benchmark. No mainnet transaction was signed or sent. No real OpenRouter request
was made because no key was configured. The original TypeScript code and
Solidity sources were unchanged; this validation targets the new Go backend.

Further validation includes comparative replay against the original scanner,
actual model/provider checks, private-relay inclusion behavior, broader token
and protocol coverage, and measurement of mainnet execution outcomes. The new
execution safeguards do not establish profitability. Deployment and upgrades,
other EVM pool types, spot execution, Arbitrum and Solana remain outside this
Go execution release. Stuck nonce cancellation still requires operator handling.
