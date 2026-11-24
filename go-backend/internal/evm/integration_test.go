package evm

import (
	"context"
	"encoding/json"
	"math/big"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
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

// This test only accepts a dedicated local Anvil on chain 31337. It loads no
// wallet or .env and uses the node's throwaway unlocked account for fixture setup.
func TestAnvilRetainedProxyExecutesAtomicArbitrage(t *testing.T) {
	endpoint := os.Getenv("ANVIL_TEST_RPC")
	if endpoint == "" {
		t.Skip("run scripts/integration.py for local EVM integration")
	}
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("integration endpoint must be loopback HTTP")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	raw, e := rpc.DialContext(ctx, endpoint)
	if e != nil {
		t.Fatal(e)
	}
	defer raw.Close()
	client := ethclient.NewClient(raw)
	id, e := client.ChainID(ctx)
	if e != nil || id.Cmp(big.NewInt(31337)) != 0 {
		t.Fatal("integration requires isolated chain 31337")
	}
	call := func(result any, method string, args ...any) {
		t.Helper()
		if e := raw.CallContext(ctx, result, method, args...); e != nil {
			t.Fatal(method, e)
		}
	}
	var accounts []common.Address
	call(&accounts, "eth_accounts")
	if len(accounts) == 0 {
		t.Fatal("no fixture account")
	}
	owner := accounts[0]
	send := func(to *common.Address, data []byte) *types.Receipt {
		t.Helper()
		args := map[string]any{"from": owner, "data": hexutil.Encode(data), "gas": "0xe4e1c0"}
		if to != nil {
			args["to"] = *to
		}
		var hash common.Hash
		call(&hash, "eth_sendTransaction", args)
		for tries := 0; tries < 100; tries++ {
			receipt, e := client.TransactionReceipt(ctx, hash)
			if e == nil {
				if receipt.Status != 1 {
					t.Fatal("fixture transaction reverted", hash)
				}
				return receipt
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("fixture receipt timeout")
		return nil
	}
	data, e := os.ReadFile(os.Getenv("ANVIL_MOCK_ARTIFACTS"))
	if e != nil {
		t.Fatal(e)
	}
	var compiled struct {
		Contracts map[string]struct {
			ABI     json.RawMessage `json:"abi"`
			Bin     string          `json:"bin"`
			Runtime string          `json:"bin-runtime"`
		} `json:"contracts"`
	}
	if e = json.Unmarshal(data, &compiled); e != nil {
		t.Fatal(e)
	}
	get := func(name string) (abi.ABI, []byte, []byte) {
		t.Helper()
		for key, c := range compiled.Contracts {
			if strings.HasSuffix(key, ":"+name) {
				a, e := abi.JSON(strings.NewReader(string(c.ABI)))
				if e != nil {
					t.Fatal(e)
				}
				return a, common.FromHex(c.Bin), common.FromHex(c.Runtime)
			}
		}
		t.Fatal("missing mock", name)
		return abi.ABI{}, nil, nil
	}
	tokenABI, _, tokenRuntime := get("MockToken")
	tokenAddress := common.HexToAddress("0x0000000000000000000000000000000000000010")
	var ignored any
	call(&ignored, "anvil_setCode", WETH, hexutil.Encode(tokenRuntime))
	call(&ignored, "anvil_setCode", tokenAddress, hexutil.Encode(tokenRuntime))
	call(&ignored, "anvil_setBalance", WETH, "0x3635c9adc5dea00000")
	_, _, factoryRuntime := get("MockFactory")
	pairABI, pairCode, _ := get("MockPair")
	n := func(s string) *big.Int { x, _ := new(big.Int).SetString(s, 10); return x }
	tokens := n("200000000000")
	wethA := n("100000000000000000000")
	wethB := n("120000000000000000000")
	pools := []market.Pool{}
	for i, w := range []*big.Int{wethA, wethB} {
		args, e := pairABI.Pack("", tokenAddress, WETH, tokens, w)
		if e != nil {
			t.Fatal(e)
		}
		pair := send(nil, append(append([]byte{}, pairCode...), args...)).ContractAddress
		for asset, amount := range map[common.Address]*big.Int{WETH: w, tokenAddress: tokens} {
			b, e := tokenABI.Pack("mint", pair, amount)
			if e != nil {
				t.Fatal(e)
			}
			send(&asset, b)
		}
		factory := venues[i].Factory
		call(&ignored, "anvil_setCode", factory, hexutil.Encode(factoryRuntime))
		call(&ignored, "anvil_setStorageAt", factory, common.Hash{}, common.BytesToHash(pair.Bytes()))
		pools = append(pools, market.Pool{Address: pair, Token: tokenAddress, Venue: venues[i].Name, Kind: venues[i].Kind, Fee: venues[i].Fee, WETH: w, Tokens: tokens})
	}
	proxy, _ := artifacts.Load("proxy")
	logic, _ := artifacts.Load("logic-v4")
	args, e := proxy.ABI.Pack("", logic.Bytecode, crypto.Keccak256Hash(logic.Runtime))
	if e != nil {
		t.Fatal(e)
	}
	deployed := send(nil, append(append([]byte{}, proxy.Bytecode...), args...)).ContractAddress
	h, e := client.HeaderByNumber(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	cfg := testConfig(t)
	cfg.Proxy = deployed
	cfg.Owner = owner
	candidates := market.Rank(pools, []*big.Int{n("1000000000000000000")}, n("6000000000000000"), cfg.MinimumNet, 50)
	if len(candidates) != 1 {
		t.Fatal("expected one profitable fixture direction")
	}
	sim, e := Simulate(ctx, client, cfg, candidates[0], h.Hash(), h.Number.Uint64())
	if e != nil {
		t.Fatal(e)
	}
	if sim.Status != "simulation_passed" {
		t.Fatal(sim)
	}
	gross, _ := new(big.Int).SetString(candidates[0].GrossWei, 10)
	if sim.ProfitWei != gross.String() {
		t.Fatalf("Go quote %s != actual Solidity execution %s", gross, sim.ProfitWei)
	}
	// The full eth_call must not persist either swaps or owner profit.
	readBalance := func(a common.Address) *big.Int {
		b, _ := tokenABI.Pack("balanceOf", a)
		out, e := client.CallContractAtHash(ctx, ethereum.CallMsg{To: &WETH, Data: b}, h.Hash())
		if e != nil {
			t.Fatal(e)
		}
		values, e := tokenABI.Unpack("balanceOf", out)
		if e != nil {
			t.Fatal(e)
		}
		return values[0].(*big.Int)
	}
	if readBalance(pools[0].Address).Cmp(wethA) != 0 {
		t.Fatal("simulation changed pool balance")
	}
	cfg.MinimumNet = n("1000000000000000000000")
	if _, e = Simulate(ctx, client, cfg, candidates[0], h.Hash(), h.Number.Uint64()); e == nil {
		t.Fatal("unprofitable full-contract order accepted")
	}
}
