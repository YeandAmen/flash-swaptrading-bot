package live

import (
	"context"
	"encoding/json"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

// No mock tokens, factories, code overrides or pool-storage overrides are used.
// The second scenario creates a spread through genuine swaps ONLY on the local
// fork; it verifies execution, not a naturally profitable mainnet opportunity.
func TestMainnetForkRealPools(t *testing.T) {
	endpoint := os.Getenv("MAINNET_FORK_RPC")
	if endpoint == "" {
		t.Skip("run scripts/mainnet-fork.py for real Ethereum pool replay")
	}
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("real-state test requires a local fork endpoint")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	raw, e := rpc.DialContext(ctx, endpoint)
	if e != nil {
		t.Fatal("cannot connect to local fork")
	}
	defer raw.Close()
	client := ethclient.NewClient(raw)
	id, e := client.ChainID(ctx)
	if e != nil || id.Cmp(big.NewInt(31337)) != 0 {
		t.Fatal("refusing to submit test transactions outside local chain 31337")
	}
	source, e := strconv.ParseUint(os.Getenv("MAINNET_FORK_BLOCK"), 10, 64)
	if e != nil {
		t.Fatal("missing source block")
	}
	h, e := client.HeaderByNumber(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	if h.Number.Uint64() != source || h.Hash() != common.HexToHash(os.Getenv("MAINNET_FORK_HASH")) {
		t.Fatal("local fork does not match the pinned actual Ethereum header")
	}
	var metadata struct {
		ForkBlockNumber uint64      `json:"forkBlockNumber"`
		ForkBlockHash   common.Hash `json:"forkBlockHash"`
	}
	_ = raw.CallContext(ctx, &metadata, "anvil_metadata") // Header binding above is mandatory; metadata is optional across Anvil releases.
	poolABI, e := abi.JSON(strings.NewReader(`[
{"type":"function","name":"getPair","inputs":[{"type":"address"},{"type":"address"}],"outputs":[{"type":"address"}]},
{"type":"function","name":"token0","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"token1","inputs":[],"outputs":[{"type":"address"}]},
{"type":"function","name":"getReserves","inputs":[],"outputs":[{"type":"uint112"},{"type":"uint112"},{"type":"uint32"}]},
{"type":"function","name":"deposit","stateMutability":"payable","inputs":[],"outputs":[]},
{"type":"function","name":"transfer","inputs":[{"type":"address"},{"type":"uint256"}],"outputs":[{"type":"bool"}]},
{"type":"function","name":"swap","inputs":[{"type":"uint256"},{"type":"uint256"},{"type":"address"},{"type":"bytes"}],"outputs":[]}]`))
	if e != nil {
		t.Fatal(e)
	}
	pack := func(method string, args ...any) []byte {
		t.Helper()
		b, e := poolABI.Pack(method, args...)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	read := func(address common.Address, hash common.Hash, method string, args ...any) []any {
		t.Helper()
		out, e := client.CallContractAtHash(ctx, ethereum.CallMsg{To: &address, Data: pack(method, args...)}, hash)
		if e != nil {
			t.Fatalf("real contract %s read failed", method)
		}
		v, e := poolABI.Unpack(method, out)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	usdc := common.HexToAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
	factories := []common.Address{common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"), common.HexToAddress("0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac")}
	pools := []market.Pool{}
	contracts := []map[string]any{}
	for i, factory := range factories {
		pair := read(factory, h.Hash(), "getPair", evm.WETH, usdc)[0].(common.Address)
		if pair == (common.Address{}) {
			t.Fatal("canonical WETH/USDC pair is absent")
		}
		first := read(pair, h.Hash(), "token0")[0].(common.Address)
		second := read(pair, h.Hash(), "token1")[0].(common.Address)
		if !((first == usdc && second == evm.WETH) || (first == evm.WETH && second == usdc)) {
			t.Fatal("real pair tokens do not match")
		}
		code, e := client.CodeAtHash(ctx, pair, h.Hash())
		if e != nil || len(code) < 5000 {
			t.Fatal("unexpected real V2 pair code")
		}
		reserve := read(pair, h.Hash(), "getReserves")
		w, token := reserve[0].(*big.Int), reserve[1].(*big.Int)
		if first != evm.WETH {
			w, token = token, w
		}
		p := market.Pool{Address: pair, Token: usdc, Venue: []string{"Uniswap V2", "SushiSwap V2"}[i], Kind: uint8(i), Fee: 3000, WETH: w, Tokens: token}
		pools = append(pools, p)
		contracts = append(contracts, map[string]any{"venue": p.Venue, "factory": factory, "pool": pair, "code_hash": crypto.Keccak256Hash(code), "weth_reserve_wei": w.String(), "usdc_reserve_units": token.String()})
	}
	baseBudget := new(big.Int).Mul(new(big.Int).Add(new(big.Int).Mul(h.BaseFee, big.NewInt(2)), big.NewInt(2_000_000_000)), big.NewInt(600000))
	sizes := []*big.Int{big.NewInt(10_000_000_000_000_000), big.NewInt(100_000_000_000_000_000), big.NewInt(1_000_000_000_000_000_000)}
	baseline := market.Rank(pools, sizes, baseBudget, big.NewInt(10_000_000_000_000), 50)
	quotes := []map[string]any{}
	for _, buy := range pools {
		for _, sell := range pools {
			if buy.Address == sell.Address {
				continue
			}
			for _, size := range sizes {
				tokens, e := market.AmountOut(size, buy.WETH, buy.Tokens, buy.Fee)
				if e != nil {
					t.Fatal(e)
				}
				out, e := market.AmountOut(tokens, sell.Tokens, sell.WETH, sell.Fee)
				if e != nil {
					t.Fatal(e)
				}
				gross := new(big.Int).Sub(out, size)
				quotes = append(quotes, map[string]any{"buy": buy.Venue, "sell": sell.Venue, "amount_wei": size.String(), "gross_quote_wei": gross.String(), "gas_budget_wei": baseBudget.String(), "net_before_quote_buffer_wei": new(big.Int).Sub(gross, baseBudget).String()})
			}
		}
	}
	t.Logf("Actual mainnet snapshot %d: two real pools, %d sizes each direction, %d candidates pass screening", source, len(sizes), len(baseline))
	key, e := crypto.GenerateKey()
	if e != nil {
		t.Fatal(e)
	}
	owner := crypto.PubkeyToAddress(key.PublicKey)
	call := func(method string, args ...any) {
		t.Helper()
		var result any
		if e := raw.CallContext(ctx, &result, method, args...); e != nil {
			t.Fatalf("local setup %s failed", method)
		}
	}
	maxReserve := new(big.Int).Set(pools[0].WETH)
	if pools[1].WETH.Cmp(maxReserve) > 0 {
		maxReserve.Set(pools[1].WETH)
	}
	fakeBalance := new(big.Int).Add(maxReserve, new(big.Int).Mul(big.NewInt(1000), big.NewInt(1_000_000_000_000_000_000)))
	call("anvil_setBalance", owner, hexutil.EncodeBig(fakeBalance))
	call("anvil_impersonateAccount", owner)
	send := func(to *common.Address, value *big.Int, data []byte) *types.Receipt {
		t.Helper()
		args := map[string]any{"from": owner, "data": hexutil.Encode(data), "gas": "0xe4e1c0"}
		if to != nil {
			args["to"] = *to
		}
		if value != nil {
			args["value"] = hexutil.EncodeBig(value)
		}
		var hash common.Hash
		if e := raw.CallContext(ctx, &hash, "eth_sendTransaction", args); e != nil {
			t.Fatalf("local setup transaction failed: %v", e)
		}
		for i := 0; i < 100; i++ {
			receipt, e := client.TransactionReceipt(ctx, hash)
			if e == nil {
				if receipt.Status != 1 {
					t.Fatal("local setup reverted", hash)
				}
				return receipt
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("local setup receipt timed out")
		return nil
	}
	proxyArtifact, _ := artifacts.Load("proxy")
	logic, _ := artifacts.Load("logic-v4")
	args, e := proxyArtifact.ABI.Pack("", logic.Bytecode, crypto.Keccak256Hash(logic.Runtime))
	if e != nil {
		t.Fatal(e)
	}
	proxy := send(nil, nil, append(append([]byte{}, proxyArtifact.Bytecode...), args...)).ContractAddress
	cfg, e := config.Parse(func(k string) string {
		if k == "RPC_URL" {
			return endpoint
		}
		if k == "SCAN_TOKENS" {
			return usdc.Hex()
		}
		return ""
	})
	if e != nil {
		t.Fatal(e)
	}
	cfg.Owner = owner
	cfg.Proxy = proxy
	cfg.MinimumNet = big.NewInt(10_000_000_000_000)
	current, e := client.HeaderByNumber(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = evm.VerifyDeployment(ctx, client, cfg, current.Hash()); e != nil {
		t.Fatal(e)
	}
	// Force an unreachable payout floor in actual, unmodified mainnet pool state.
	// A genuine EVM revert is required, so an RPC timeout cannot masquerade as a pass.
	c := market.Candidate{Token: usdc, Buy: pools[0], Sell: pools[1], AmountWei: sizes[1].String(), GasBudgetWei: "1"}
	highFloor := new(big.Int).Mul(fakeBalance, big.NewInt(10))
	data, e := evm.EncodePinned(c, highFloor, current.Number.Uint64())
	if e != nil {
		t.Fatal(e)
	}
	_, revertErr := client.CallContractAtHash(ctx, ethereum.CallMsg{From: owner, To: &proxy, Data: data, Gas: cfg.GasUnits}, current.Hash())
	if revertErr == nil {
		t.Fatal("unreachable payout floor unexpectedly passed")
	}
	revertData, ok := ethclient.RevertErrorData(revertErr)
	if !ok {
		t.Fatal("rejection was not a verified EVM revert")
	}
	reason, _ := abi.UnpackRevert(revertData)
	if reason == "" {
		reason = "EVM revert (custom or empty revert data)"
	}
	t.Logf("Real-pool excessive-profit-floor protection: %s", reason)

	// A controlled local whale swap creates a deterministic price gap. No pool
	// bytecode, storage slots or token balances are directly overridden.
	shock := 0
	if pools[1].WETH.Cmp(pools[0].WETH) < 0 {
		shock = 1
	}
	amount := new(big.Int).Div(pools[shock].WETH, big.NewInt(5))
	if amount.Sign() <= 0 {
		t.Fatal("real pool has no usable liquidity")
	}
	out, e := market.AmountOut(amount, pools[shock].WETH, pools[shock].Tokens, 3000)
	if e != nil {
		t.Fatal(e)
	}
	send(&evm.WETH, amount, pack("deposit"))
	send(&evm.WETH, nil, pack("transfer", pools[shock].Address, amount))
	zero := big.NewInt(0)
	amount0, amount1 := out, zero
	if evm.WETH.Cmp(usdc) < 0 {
		amount0, amount1 = zero, out
	}
	shockReceipt := send(&pools[shock].Address, nil, pack("swap", amount0, amount1, owner, []byte{}))
	current, e = client.HeaderByNumber(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	for i := range pools {
		res := read(pools[i].Address, current.Hash(), "getReserves")
		first := read(pools[i].Address, current.Hash(), "token0")[0].(common.Address)
		w, tokens := res[0].(*big.Int), res[1].(*big.Int)
		if first != evm.WETH {
			w, tokens = tokens, w
		}
		pools[i].WETH = w
		pools[i].Tokens = tokens
	}
	maxFee := new(big.Int).Add(new(big.Int).Mul(current.BaseFee, big.NewInt(10)), cfg.PriorityWei)
	maxGas := new(big.Int).Mul(new(big.Int).SetUint64(cfg.GasUnits), maxFee)
	cfg.Live = config.Live{Allowed: true, DataDir: filepath.Join(t.TempDir(), "live"), MaxGasWei: maxGas, DailyGasWei: new(big.Int).Mul(maxGas, big.NewInt(10)), MaxFeeWei: maxFee, MaxPrincipalWei: sizes[2], Confirmations: 2}
	budget := new(big.Int).Mul(new(big.Int).Add(new(big.Int).Mul(current.BaseFee, big.NewInt(2)), cfg.PriorityWei), new(big.Int).SetUint64(cfg.GasUnits))
	candidates := market.Rank(pools, sizes, budget, cfg.MinimumNet, 50)
	if len(candidates) == 0 {
		t.Fatal("controlled real-pool spread did not pass screening")
	}
	// Now that repayment is feasible, prove the explicit payout floor itself
	// rejects the route, rather than counting a transfer failure or RPC error.
	tooHigh, e := evm.EncodePinned(candidates[0], highFloor, current.Number.Uint64())
	if e != nil {
		t.Fatal(e)
	}
	_, floorErr := client.CallContractAtHash(ctx, ethereum.CallMsg{From: owner, To: &proxy, Data: tooHigh, Gas: cfg.GasUnits}, current.Hash())
	floorData, ok := ethclient.RevertErrorData(floorErr)
	if !ok {
		t.Fatal("profit-floor test did not produce an EVM revert")
	}
	floorReason, e := abi.UnpackRevert(floorData)
	if e != nil || floorReason != "unprofitable" {
		t.Fatal("explicit profit floor was not the reason for rejection")
	}
	call("anvil_stopImpersonatingAccount", owner)
	signer := &testSigner{key: key}
	executor, e := newExecutor(ctx, client, client, signer, cfg, big.NewInt(31337))
	if e != nil {
		t.Fatal(e)
	}
	defer executor.Close()
	report := evm.Report{Mode: "paper", ChainID: 31337, Block: current.Number.Uint64(), Hash: current.Hash(), ScannedAt: time.Now(), BlockTime: time.Unix(int64(current.Time), 0), Candidates: candidates}
	before, e := client.BalanceAt(ctx, owner, nil)
	if e != nil {
		t.Fatal(e)
	}
	arm(t, executor)
	if e = executor.Tick(ctx, &report); e != nil {
		t.Fatal(e)
	}
	if signer.calls != 1 || executor.View().PendingHash == (common.Hash{}) {
		t.Fatalf("local execution was rejected: %+v", executor.View())
	}
	localHash := executor.View().PendingHash
	call("anvil_mine", "0x1")
	_ = executor.Tick(ctx, nil)
	view := executor.View()
	if view.LastSettlement == nil || view.LastSettlement.Status != "confirmed" || view.PendingHash != (common.Hash{}) {
		t.Fatalf("real-pool local settlement failed: %+v", view)
	}
	after, e := client.BalanceAt(ctx, owner, nil)
	if e != nil {
		t.Fatal(e)
	}
	delta := new(big.Int).Sub(after, before)
	if delta.Sign() <= 0 || delta.String() != view.LastSettlement.NetWei {
		t.Fatal("actual local wallet delta does not match verified net profit")
	}
	result := map[string]any{
		"explicit_profit_floor_rejection": floorReason,
		"source_chain_id":                 1, "source_block": source, "source_block_hash": os.Getenv("MAINNET_FORK_HASH"), "execution_chain_id": 31337,
		"real_contracts": contracts, "mock_pool_contracts_used": false, "pool_code_or_storage_overrides_used": false,
		"untouched_mainnet_snapshot":     map[string]any{"quotes": quotes, "screened_candidate_count": len(baseline), "excessive_profit_floor_revert": reason},
		"controlled_fork_execution":      map[string]any{"spread_created_locally": true, "spread_created_by": "genuine WETH deposit, transfer and V2 pool swap on the local fork", "shock_venue": pools[shock].Venue, "shock_weth_wei": amount.String(), "setup_swap_hash_local_only": shockReceipt.TxHash, "arbitrage_hash_local_only": localHash, "settlement": view.LastSettlement, "actual_wallet_delta_wei": delta.String(), "setup_cost_excluded_from_arbitrage_net": true},
		"live_mainnet_transactions_sent": 0, "live_mainnet_profit_proven": false, "user_wallet_loaded": false,
		"limitations": []string{"Controlled price gap was created on the local fork; it is not evidence of a naturally available mainnet profit.", "Local mining does not reproduce competing searchers or builder inclusion.", "Only Ethereum Uniswap V2 and SushiSwap V2 WETH/USDC routes were executed."},
	}
	b, e := json.MarshalIndent(result, "", "  ")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(os.Getenv("MAINNET_FORK_REPORT"), b, 0600); e != nil {
		t.Fatal(e)
	}
	t.Logf("Signed local trade through REAL Uniswap/Sushi contracts settled; receipt net exactly matches wallet delta. No upstream mainnet transaction was sent.")
}
