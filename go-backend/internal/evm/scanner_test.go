package evm

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

type fakeChain struct {
	header                                  *types.Header
	reorg, wrongCode, wrongOwner, failCalls bool
	id                                      int64
	mu                                      sync.Mutex
	hashes                                  []common.Hash
}

var token = common.HexToAddress("0x10")
var poolA = common.HexToAddress("0x20")
var poolB = common.HexToAddress("0x30")
var proxyAddress = common.HexToAddress("0x40")
var ownerAddress = common.HexToAddress("0x50")
var implAddress = common.HexToAddress("0x60")

func newFake() *fakeChain {
	return &fakeChain{header: &types.Header{Number: big.NewInt(100), Time: uint64(time.Now().Unix()), BaseFee: big.NewInt(1_000_000_000)}, id: 1}
}
func (f *fakeChain) ChainID(context.Context) (*big.Int, error) { return big.NewInt(f.id), nil }
func (f *fakeChain) HeaderByNumber(_ context.Context, n *big.Int) (*types.Header, error) {
	h := types.CopyHeader(f.header)
	if n != nil && f.reorg {
		h.Extra = []byte{1}
	}
	return h, nil
}
func (f *fakeChain) CodeAtHash(_ context.Context, a common.Address, _ common.Hash) ([]byte, error) {
	if f.wrongCode {
		return []byte{0}, nil
	}
	name := "logic-v4"
	if a == proxyAddress {
		name = "proxy"
	}
	art, e := artifacts.Load(name)
	return art.Runtime, e
}
func (f *fakeChain) StorageAtHash(context.Context, common.Address, common.Hash, common.Hash) ([]byte, error) {
	return common.LeftPadBytes(implAddress.Bytes(), 32), nil
}
func (f *fakeChain) CallContractAtHash(_ context.Context, msg ethereum.CallMsg, hash common.Hash) ([]byte, error) {
	f.mu.Lock()
	f.hashes = append(f.hashes, hash)
	f.mu.Unlock()
	if f.failCalls {
		return nil, errors.New("provider secret must never escape")
	}
	if *msg.To == proxyAddress {
		logic, _ := artifacts.Load("logic-v4")
		proxy, _ := artifacts.Load("proxy")
		if bytes.Equal(msg.Data, logic.ABI.Methods["owner"].ID) {
			a := ownerAddress
			if f.wrongOwner {
				a = token
			}
			return logic.ABI.Methods["owner"].Outputs.Pack(a)
		}
		if bytes.Equal(msg.Data[:4], proxy.ABI.Methods["executePinned"].ID) {
			return proxy.ABI.Methods["executePinned"].Outputs.Pack(big.NewInt(100_000_000_000_000_000))
		}
	}
	m, e := poolABI.MethodById(msg.Data[:4])
	if e != nil {
		return nil, e
	}
	switch m.Name {
	case "getPair":
		a := common.Address{}
		if *msg.To == venues[0].Factory {
			a = poolA
		}
		if *msg.To == venues[1].Factory {
			a = poolB
		}
		return m.Outputs.Pack(a)
	case "token0":
		return m.Outputs.Pack(token)
	case "token1":
		return m.Outputs.Pack(WETH)
	case "getReserves":
		w, _ := new(big.Int).SetString("100000000000000000000", 10)
		if *msg.To == poolB {
			w.Mul(w, big.NewInt(12)).Div(w, big.NewInt(10))
		}
		return m.Outputs.Pack(big.NewInt(200_000_000_000), w, uint32(0))
	}
	return nil, errors.New("unknown method")
}
func testConfig(t *testing.T) config.Config {
	t.Helper()
	c, e := config.Parse(func(k string) string {
		if k == "RPC_URL" {
			return "https://rpc.example"
		}
		if k == "SCAN_TOKENS" {
			return token.Hex()
		}
		return ""
	})
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func TestScannerPinsSnapshotAndRejectsReorg(t *testing.T) {
	f := newFake()
	s := Scanner{Chain: f, Config: testConfig(t)}
	r, e := s.Scan(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if r.Pools != 2 || len(r.Candidates) == 0 || r.Mode != "paper" {
		t.Fatalf("unexpected report %+v", r)
	}
	for _, h := range f.hashes {
		if h != r.Hash {
			t.Fatal("mixed block snapshot")
		}
	}
	f.reorg = true
	if _, e = s.Scan(context.Background()); e == nil {
		t.Fatal("reorg accepted")
	}
}
func TestScannerRejectsWrongChainStaleAndFailedReads(t *testing.T) {
	for _, mode := range []string{"wrong chain", "stale", "RPC failure"} {
		t.Run(mode, func(t *testing.T) {
			f := newFake()
			switch mode {
			case "wrong chain":
				f.id = 31337
			case "stale":
				f.header.Time -= 3600
			case "RPC failure":
				f.failCalls = true
			}
			s := Scanner{Chain: f, Config: testConfig(t)}
			_, e := s.Scan(context.Background())
			if e == nil {
				t.Fatal("accepted invalid input")
			}
			if strings.Contains(e.Error(), "secret") {
				t.Fatal("provider details leaked")
			}
		})
	}
}
func TestSimulationPinsABIAndChecksOwnershipAndCode(t *testing.T) {
	f := newFake()
	cfg := testConfig(t)
	s := Scanner{Chain: f, Config: cfg}
	r, e := s.Scan(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	data, e := EncodeOrder(r.Candidates[0], cfg.MinimumNet, r.Block)
	if e != nil {
		t.Fatal(e)
	}
	if common.Bytes2Hex(data[:4]) != "83cf854d" {
		t.Fatalf("wrong execute selector %x", data[:4])
	}
	cfg.Proxy = proxyAddress
	cfg.Owner = ownerAddress
	sim, e := Simulate(context.Background(), f, cfg, r.Candidates[0], r.Hash, r.Block)
	if e != nil || sim.Status != "simulation_passed" {
		t.Fatalf("simulation %+v %v", sim, e)
	}
	f.wrongOwner = true
	if _, e = Simulate(context.Background(), f, cfg, r.Candidates[0], r.Hash, r.Block); e == nil {
		t.Fatal("wrong owner accepted")
	}
	f.wrongOwner = false
	f.wrongCode = true
	if _, e = Simulate(context.Background(), f, cfg, r.Candidates[0], r.Hash, r.Block); e == nil {
		t.Fatal("wrong code accepted")
	}
}
