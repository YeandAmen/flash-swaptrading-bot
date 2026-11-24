package live

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
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
func anvilFixture(t *testing.T) (*ethclient.Client, *rpc.Client, common.Address, *ecdsa.PrivateKey, []market.Pool, *types.Header) {
	t.Helper()
	endpoint := os.Getenv("ANVIL_TEST_RPC")
	if endpoint == "" {
		t.Skip("run scripts/integration.py for local EVM integration")
	}
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		t.Fatal("integration endpoint must be loopback HTTP")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	raw, e := rpc.DialContext(ctx, endpoint)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(raw.Close)
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
	key, e := crypto.GenerateKey()
	if e != nil {
		t.Fatal(e)
	}
	owner := crypto.PubkeyToAddress(key.PublicKey)
	var setupResult any
	call(&setupResult, "anvil_setBalance", owner, "0x3635c9adc5dea00000")
	call(&setupResult, "anvil_impersonateAccount", owner)
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
	call(&ignored, "anvil_setCode", evm.WETH, hexutil.Encode(tokenRuntime))
	call(&ignored, "anvil_setCode", tokenAddress, hexutil.Encode(tokenRuntime))
	call(&ignored, "anvil_setBalance", evm.WETH, "0x3635c9adc5dea00000")
	_, _, factoryRuntime := get("MockFactory")
	pairABI, pairCode, _ := get("MockPair")
	n := func(s string) *big.Int { x, _ := new(big.Int).SetString(s, 10); return x }
	tokens := n("200000000000")
	wethA := n("100000000000000000000")
	wethB := n("120000000000000000000")
	pools := []market.Pool{}
	for i, w := range []*big.Int{wethA, wethB} {
		args, e := pairABI.Pack("", tokenAddress, evm.WETH, tokens, w)
		if e != nil {
			t.Fatal(e)
		}
		pair := send(nil, append(append([]byte{}, pairCode...), args...)).ContractAddress
		for asset, amount := range map[common.Address]*big.Int{evm.WETH: w, tokenAddress: tokens} {
			b, e := tokenABI.Pack("mint", pair, amount)
			if e != nil {
				t.Fatal(e)
			}
			send(&asset, b)
		}
		factory := []common.Address{common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"), common.HexToAddress("0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac")}[i]
		call(&ignored, "anvil_setCode", factory, hexutil.Encode(factoryRuntime))
		call(&ignored, "anvil_setStorageAt", factory, common.Hash{}, common.BytesToHash(pair.Bytes()))
		pools = append(pools, market.Pool{Address: pair, Token: tokenAddress, Venue: []string{"Uniswap V2", "SushiSwap V2"}[i], Kind: uint8(i), Fee: 3000, WETH: w, Tokens: tokens})
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

	return client, raw, deployed, key, pools, h
}

func TestAnvilSignedArbitrageAndRestartRecovery(t *testing.T) {
	client, raw, proxy, key, pools, h := anvilFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cfg, e := config.Parse(func(k string) string {
		if k == "RPC_URL" {
			return "http://127.0.0.1:8545"
		}
		if k == "SCAN_TOKENS" {
			return pools[0].Token.Hex()
		}
		return ""
	})
	if e != nil {
		t.Fatal(e)
	}
	signer := &testSigner{key: key}
	cfg.Owner = signer.Address()
	cfg.Proxy = proxy
	cfg.Live = config.Live{Allowed: true, DataDir: filepath.Join(t.TempDir(), "live"), MaxGasWei: big.NewInt(10_000_000_000_000_000), DailyGasWei: big.NewInt(20_000_000_000_000_000), MaxPrincipalWei: big.NewInt(2_000_000_000_000_000_000), MaxFeeWei: big.NewInt(20_000_000_000), Confirmations: 2}
	x, e := newExecutor(ctx, client, client, signer, cfg, big.NewInt(31337))
	if e != nil {
		t.Fatal(e)
	}
	closed := false
	defer func() {
		if !closed {
			x.Close()
		}
	}()
	candidates := market.Rank(pools, []*big.Int{big.NewInt(1_000_000_000_000_000_000)}, big.NewInt(6_000_000_000_000_000), cfg.MinimumNet, 50)
	if len(candidates) != 1 {
		t.Fatal("fixture quote missing")
	}
	report := evm.Report{Mode: "paper", ChainID: 31337, Block: h.Number.Uint64(), Hash: h.Hash(), BlockTime: time.Unix(int64(h.Time), 0), ScannedAt: time.Now(), Candidates: candidates}
	before, e := client.BalanceAt(ctx, cfg.Owner, nil)
	if e != nil {
		t.Fatal(e)
	}
	arm(t, x)
	if e = x.Tick(ctx, &report); e != nil {
		t.Fatal(e)
	}
	if signer.calls != 1 || x.View().PendingHash == (common.Hash{}) {
		t.Fatal("signed transaction not journaled")
	}
	var result any
	if e = raw.CallContext(ctx, &result, "anvil_mine", "0x1"); e != nil {
		t.Fatal(e)
	}
	_ = x.Tick(ctx, nil)
	view := x.View()
	if view.PendingHash != (common.Hash{}) || view.LastSettlement == nil || view.LastSettlement.Status != "confirmed" {
		t.Fatalf("settlement failed: %+v", view)
	}
	after, e := client.BalanceAt(ctx, cfg.Owner, nil)
	if e != nil {
		t.Fatal(e)
	}
	delta := new(big.Int).Sub(after, before)
	if delta.Sign() <= 0 || delta.String() != view.LastSettlement.NetWei {
		t.Fatalf("wallet delta %s != recorded net %s", delta, view.LastSettlement.NetWei)
	}
	x.Close()
	closed = true
	restarted, e := newExecutor(ctx, client, client, signer, cfg, big.NewInt(31337))
	if e != nil {
		t.Fatal(e)
	}
	defer restarted.Close()
	if restarted.View().Armed || restarted.View().LastSettlement == nil || restarted.View().LastSettlement.Hash != view.LastSettlement.Hash {
		t.Fatal("restart lost settlement or armed execution")
	}
}
