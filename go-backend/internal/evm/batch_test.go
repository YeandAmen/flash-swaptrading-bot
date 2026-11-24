package evm

import (
	"context"
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/rpc"
)

type batchFixture struct {
	*fakeChain
	client *rpc.Client
}

func (f *batchFixture) Client() *rpc.Client { return f.client }

type poolRPC struct {
	chain     *fakeChain
	badTokens bool
}
type rpcCall struct {
	To   common.Address `json:"to"`
	Data hexutil.Bytes  `json:"data"`
}

func (s *poolRPC) Call(ctx context.Context, msg rpcCall, block rpc.BlockNumberOrHash) (hexutil.Bytes, error) {
	if block.BlockHash == nil {
		return nil, errors.New("batch read was not pinned by hash")
	}
	method, e := poolABI.MethodById(msg.Data[:4])
	if e != nil {
		return nil, e
	}
	if s.badTokens && method.Name == "token0" {
		return method.Outputs.Pack(common.HexToAddress("0x9999"))
	}
	return s.chain.CallContractAtHash(ctx, ethereum.CallMsg{To: &msg.To, Data: msg.Data}, *block.BlockHash)
}
func batchFixtureFor(t *testing.T, f *fakeChain, bad bool) *batchFixture {
	t.Helper()
	server := rpc.NewServer()
	if e := server.RegisterName("eth", &poolRPC{chain: f, badTokens: bad}); e != nil {
		t.Fatal(e)
	}
	client := rpc.DialInProc(server)
	t.Cleanup(client.Close)
	t.Cleanup(server.Stop)
	return &batchFixture{fakeChain: f, client: client}
}
func TestBatchPreservesSnapshotAndQuoteEconomics(t *testing.T) {
	f := newFake()
	cfg := testConfig(t)
	individual, e := (&Scanner{Chain: f, Config: cfg}).Scan(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	batched, e := (&Scanner{Chain: batchFixtureFor(t, f, false), Config: cfg}).Scan(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if batched.ReadMode != "batch" || batched.BatchRequests != 2 || batched.Pools != individual.Pools || len(batched.Candidates) != len(individual.Candidates) || batched.BestQuote.NetWei != individual.BestQuote.NetWei {
		t.Fatal("batch changed quote economics or pool coverage")
	}
	for _, hash := range f.hashes {
		if hash != batched.Hash {
			t.Fatal("mixed-block batch")
		}
	}
}
func TestBatchRejectsIndividualErrorsAndTokenMismatch(t *testing.T) {
	for _, badTokens := range []bool{false, true} {
		f := newFake()
		f.failCalls = !badTokens
		_, e := (&Scanner{Chain: batchFixtureFor(t, f, badTokens), Config: testConfig(t)}).Scan(context.Background())
		if e == nil {
			t.Fatal("invalid batch data was admitted")
		}
	}
}
func TestBatchTransportFailureFallsBackWithoutLosingChecks(t *testing.T) {
	f := newFake()
	fixture := batchFixtureFor(t, f, false)
	fixture.client.Close()
	r, e := (&Scanner{Chain: fixture, Config: testConfig(t)}).Scan(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if r.ReadMode != "bounded_individual_fallback" || r.Pools != 2 || len(r.Warnings) == 0 {
		t.Fatal("batch fallback lost valid state or warning")
	}
}

func TestBatchChunksPreserveEveryResult(t *testing.T) {
	f := newFake()
	fixture := batchFixtureFor(t, f, false)
	reads := make([]poolRead, 100)
	for i := range reads {
		reads[i] = poolRead{to: venues[0].Factory, method: "getPair", args: []any{WETH, token}}
	}
	results, count, e := batchReads(context.Background(), fixture.client, f.header.Hash(), reads)
	if e != nil || count != 5 || len(results) != 100 {
		t.Fatal("incorrect chunk count or result coverage", e)
	}
	for _, r := range results {
		if r.err != nil || r.values[0].(common.Address) != poolA {
			t.Fatal("chunk lost or reordered a response")
		}
	}
}
