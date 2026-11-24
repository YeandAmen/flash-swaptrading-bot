# Initial Go migration validation

Validated on 2026-11-24 with Go 1.26.1 on macOS. The module requires Go 1.25+.

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

Remaining validation before live trading would include protocol coverage,
comparative replay against the original scanner, actual provider/model checks,
signer and nonce recovery tests, fee estimation, pending-state simulation,
settlement reconciliation and measurement of real execution outcomes.
