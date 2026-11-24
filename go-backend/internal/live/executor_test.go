package live

import (
	"context"
	"crypto/ecdsa"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/keystore"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
)

type testSigner struct {
	key    *ecdsa.PrivateKey
	calls  int
	onSign func()
}

func (s *testSigner) Address() common.Address { return crypto.PubkeyToAddress(s.key.PublicKey) }
func (s *testSigner) Sign(tx *types.Transaction, id *big.Int) (*types.Transaction, error) {
	s.calls++
	if s.onSign != nil {
		s.onSign()
	}
	return types.SignTx(tx, types.LatestSignerForChainID(id), s.key)
}

type fakeBackend struct {
	owner, proxy            common.Address
	head                    *types.Header
	blocks                  map[uint64]*types.Header
	nonce                   uint64
	sent                    []*types.Transaction
	receipt                 *types.Receipt
	pendingError, sendError bool
	onPending               func()
	beforeSend              func(*types.Transaction)
}

func (f *fakeBackend) ChainID(context.Context) (*big.Int, error) { return big.NewInt(1), nil }
func (f *fakeBackend) HeaderByNumber(_ context.Context, n *big.Int) (*types.Header, error) {
	if n == nil {
		return types.CopyHeader(f.head), nil
	}
	if h, ok := f.blocks[n.Uint64()]; ok {
		return types.CopyHeader(h), nil
	}
	return nil, ethereum.NotFound
}
func (f *fakeBackend) CallContractAtHash(_ context.Context, msg ethereum.CallMsg, _ common.Hash) ([]byte, error) {
	logic, _ := artifacts.Load("logic-v4")
	if common.Bytes2Hex(msg.Data) == common.Bytes2Hex(logic.ABI.Methods["owner"].ID) {
		return logic.ABI.Methods["owner"].Outputs.Pack(f.owner)
	}
	proxy, _ := artifacts.Load("proxy")
	return proxy.ABI.Methods["executePinned"].Outputs.Pack(big.NewInt(100_000_000_000_000_000))
}
func (f *fakeBackend) CodeAtHash(_ context.Context, a common.Address, _ common.Hash) ([]byte, error) {
	name := "logic-v4"
	if a == f.proxy {
		name = "proxy"
	}
	v, e := artifacts.Load(name)
	return v.Runtime, e
}
func (f *fakeBackend) StorageAtHash(context.Context, common.Address, common.Hash, common.Hash) ([]byte, error) {
	return common.LeftPadBytes(common.HexToAddress("0x60").Bytes(), 32), nil
}
func (f *fakeBackend) PendingCallContract(ctx context.Context, msg ethereum.CallMsg) ([]byte, error) {
	if f.onPending != nil {
		f.onPending()
	}
	if f.pendingError {
		return nil, errors.New("provider-secret")
	}
	return f.CallContractAtHash(ctx, msg, common.Hash{})
}
func (f *fakeBackend) EstimateGas(context.Context, ethereum.CallMsg) (uint64, error) {
	return 100000, nil
}
func (f *fakeBackend) PendingNonceAt(context.Context, common.Address) (uint64, error) {
	return f.nonce, nil
}
func (f *fakeBackend) NonceAt(context.Context, common.Address, *big.Int) (uint64, error) {
	return f.nonce, nil
}
func (f *fakeBackend) BalanceAt(context.Context, common.Address, *big.Int) (*big.Int, error) {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(20), nil), nil
}
func (f *fakeBackend) TransactionReceipt(context.Context, common.Hash) (*types.Receipt, error) {
	if f.receipt == nil {
		return nil, ethereum.NotFound
	}
	return f.receipt, nil
}
func (f *fakeBackend) SendTransaction(_ context.Context, tx *types.Transaction) error {
	if f.beforeSend != nil {
		f.beforeSend(tx)
	}
	f.sent = append(f.sent, tx)
	if f.sendError {
		return errors.New("provider-secret")
	}
	return nil
}
func fixture(t *testing.T) (*Executor, *fakeBackend, *testSigner, config.Config, evm.Report) {
	t.Helper()
	key, e := crypto.GenerateKey()
	if e != nil {
		t.Fatal(e)
	}
	signer := &testSigner{key: key}
	cfg, e := config.Parse(func(k string) string {
		if k == "RPC_URL" {
			return "https://rpc.example"
		}
		if k == "SCAN_TOKENS" {
			return common.HexToAddress("0x10").Hex()
		}
		return ""
	})
	if e != nil {
		t.Fatal(e)
	}
	cfg.Proxy = common.HexToAddress("0x40")
	cfg.Owner = signer.Address()
	cfg.Live = config.Live{Allowed: true, DataDir: filepath.Join(t.TempDir(), "live"), MaxGasWei: big.NewInt(10_000_000_000_000_000), DailyGasWei: big.NewInt(20_000_000_000_000_000), MaxPrincipalWei: big.NewInt(2_000_000_000_000_000_000), MaxFeeWei: big.NewInt(20_000_000_000), Confirmations: 2}
	h := &types.Header{Number: big.NewInt(100), Time: uint64(time.Now().Unix()), BaseFee: big.NewInt(1_000_000_000)}
	f := &fakeBackend{owner: cfg.Owner, proxy: cfg.Proxy, head: h, blocks: map[uint64]*types.Header{100: h}}
	x, e := New(context.Background(), f, f, signer, cfg)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(x.Close)
	pool := func(a string, k uint8) market.Pool {
		return market.Pool{Address: common.HexToAddress(a), Token: cfg.Tokens[0], Kind: k, Fee: 3000}
	}
	r := evm.Report{Mode: "paper", ChainID: 1, Block: 100, Hash: h.Hash(), ScannedAt: time.Now(), BlockTime: time.Now(), Candidates: []market.Candidate{{Token: cfg.Tokens[0], Buy: pool("0x20", 0), Sell: pool("0x30", 1), AmountWei: "1000000000000000000", GasBudgetWei: "6000000000000000"}}}
	return x, f, signer, cfg, r
}
func arm(t *testing.T, x *Executor) {
	t.Helper()
	if e := x.Arm("ARM LIVE " + x.cfg.Owner.Hex()); e != nil {
		t.Fatal(e)
	}
}
func advance(f *fakeBackend, to uint64) {
	for n := f.head.Number.Uint64() + 1; n <= to; n++ {
		h := &types.Header{Number: new(big.Int).SetUint64(n), Time: uint64(time.Now().Unix()), BaseFee: big.NewInt(1_000_000_000), ParentHash: f.head.Hash()}
		f.blocks[n] = h
		f.head = h
	}
}
func mined(t *testing.T, f *fakeBackend, success bool) {
	t.Helper()
	tx := f.sent[0]
	advance(f, 102)
	block := f.blocks[101]
	r := &types.Receipt{Type: 2, TxHash: tx.Hash(), BlockNumber: big.NewInt(101), BlockHash: block.Hash(), GasUsed: 100000, EffectiveGasPrice: big.NewInt(3_000_000_000), Status: 0}
	if success {
		r.Status = 1
		order, e := decodeTransaction(tx, f.proxy, big.NewInt(1))
		if e != nil {
			t.Fatal(e)
		}
		a, _ := artifacts.Load("logic-v4")
		event := a.ABI.Events["Arbitrage"]
		data, e := event.Inputs.NonIndexed().Pack(order.Buy.Pool, order.Sell.Pool, order.AmountIn, big.NewInt(100_000_000_000_000_000), big.NewInt(0))
		if e != nil {
			t.Fatal(e)
		}
		r.Logs = []*types.Log{{Address: f.proxy, Topics: []common.Hash{event.ID, common.BytesToHash(order.Token.Bytes())}, Data: data, TxHash: tx.Hash(), BlockHash: r.BlockHash}}
	}
	f.receipt = r
	f.nonce = 1
}

func TestDisarmedAndFreshnessGuards(t *testing.T) {
	x, f, s, _, r := fixture(t)
	if e := x.Tick(context.Background(), &r); e != nil {
		t.Fatal(e)
	}
	if s.calls != 0 || len(f.sent) != 0 {
		t.Fatal("disarmed execution signed")
	}
	if x.Arm("yes") == nil {
		t.Fatal("arming lacked exact confirmation")
	}
	arm(t, x)
	r.Hash = common.Hash{}
	_ = x.Tick(context.Background(), &r)
	if s.calls != 0 {
		t.Fatal("stale head signed")
	}
}
func TestPendingSimulationAndDisarmPreventSigning(t *testing.T) {
	for _, mode := range []string{"simulation", "disarm"} {
		t.Run(mode, func(t *testing.T) {
			x, f, s, _, r := fixture(t)
			arm(t, x)
			if mode == "simulation" {
				f.pendingError = true
			} else {
				f.onPending = x.Disarm
			}
			_ = x.Tick(context.Background(), &r)
			if s.calls != 0 || len(f.sent) != 0 {
				t.Fatal("failed guard signed")
			}
		})
	}
}
func TestDurableReservationAndDuplicateProtection(t *testing.T) {
	x, f, s, cfg, r := fixture(t)
	arm(t, x)
	f.beforeSend = func(tx *types.Transaction) {
		t.Helper()
		data, e := os.ReadFile(filepath.Join(cfg.Live.DataDir, "journal.json"))
		if e != nil {
			t.Fatal(e)
		}
		if !strings.Contains(string(data), tx.Hash().Hex()) || !strings.Contains(string(data), `"attempts": 1`) {
			t.Fatal("broadcast before durable journal")
		}
	}
	if e := x.Tick(context.Background(), &r); e != nil {
		t.Fatal(e)
	}
	if e := x.Tick(context.Background(), &r); e != nil {
		t.Fatal(e)
	}
	if s.calls != 1 || len(f.sent) != 1 || x.View().PendingHash == (common.Hash{}) {
		t.Fatal("duplicate transaction or missing reserve")
	}
	if _, e := New(context.Background(), f, f, s, cfg); e == nil {
		t.Fatal("second process took journal")
	}
}
func TestTimeoutRestartAndExpiredNonceHold(t *testing.T) {
	x, f, s, cfg, r := fixture(t)
	f.sendError = true
	arm(t, x)
	if x.Tick(context.Background(), &r) == nil {
		t.Fatal("timeout not reported")
	}
	x.Close()
	restarted, e := New(context.Background(), f, f, s, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer restarted.Close()
	if restarted.View().Armed || restarted.View().PendingHash == (common.Hash{}) {
		t.Fatal("unsafe startup recovery")
	}
	advance(f, 103)
	_ = restarted.Tick(context.Background(), nil)
	if restarted.View().PendingHash == (common.Hash{}) || len(f.sent) != 1 {
		t.Fatal("expired uncertain nonce was reused")
	}
	mined(t, f, true)
	_ = restarted.Tick(context.Background(), nil)
	if restarted.View().PendingHash != (common.Hash{}) || restarted.View().LastSettlement == nil || restarted.View().LastSettlement.NetWei != "99700000000000000" {
		t.Fatalf("bad settlement %+v", restarted.View())
	}
}
func TestRevertChargesGasAndStopsUntilAcknowledged(t *testing.T) {
	x, f, _, _, r := fixture(t)
	arm(t, x)
	if e := x.Tick(context.Background(), &r); e != nil {
		t.Fatal(e)
	}
	mined(t, f, false)
	_ = x.Tick(context.Background(), nil)
	v := x.View()
	if v.Armed || v.Fault == "" || v.LastSettlement.Status != "reverted" || v.Spent24hWei != "300000000000000" {
		t.Fatalf("revert accounting %+v", v)
	}
	if x.Arm("ARM LIVE "+x.cfg.Owner.Hex()) == nil {
		t.Fatal("fault allowed rearm")
	}
	if e := x.Acknowledge("ACKNOWLEDGE " + x.cfg.Owner.Hex()); e != nil {
		t.Fatal(e)
	}
	if x.View().Spent24hWei != "300000000000000" || x.View().Armed {
		t.Fatal("acknowledgement erased spend or armed")
	}
}
func TestGasCapsAndExternalNonce(t *testing.T) {
	for _, mode := range []string{"gas", "daily", "nonce"} {
		t.Run(mode, func(t *testing.T) {
			x, f, s, _, r := fixture(t)
			arm(t, x)
			switch mode {
			case "gas":
				x.cfg.Live.MaxGasWei = big.NewInt(1)
			case "daily":
				x.cfg.Live.DailyGasWei = big.NewInt(1)
			case "nonce":
				f.nonce = 1
			}
			_ = x.Tick(context.Background(), &r)
			if s.calls != 0 || len(f.sent) != 0 {
				t.Fatal("limit bypassed")
			}
			if mode == "nonce" && x.View().Fault == "" {
				t.Fatal("external nonce did not stop trading")
			}
		})
	}
}
func TestCorruptJournalAndSignerPolicy(t *testing.T) {
	x, f, s, cfg, r := fixture(t)
	x.Close()
	path := filepath.Join(cfg.Live.DataDir, "journal.json")
	if e := os.WriteFile(path, []byte("{broken"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := New(context.Background(), f, f, s, cfg); e == nil {
		t.Fatal("corrupt journal reset")
	}
	keyJSON, e := keystore.EncryptKey(&keystore.Key{Id: uuid.New(), Address: s.Address(), PrivateKey: s.key}, "test-password", keystore.LightScryptN, keystore.LightScryptP)
	if e != nil {
		t.Fatal(e)
	}
	cfg.Live.KeyFile = filepath.Join(t.TempDir(), "wallet.json")
	cfg.Live.PasswordFile = filepath.Join(t.TempDir(), "password")
	if e = os.WriteFile(cfg.Live.KeyFile, keyJSON, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(cfg.Live.PasswordFile, []byte("test-password"), 0600); e != nil {
		t.Fatal(e)
	}
	loaded, e := LoadSigner(cfg)
	if e != nil {
		t.Fatal(e)
	}
	data, e := evm.EncodePinned(r.Candidates[0], cfg.MinimumNet, 101)
	if e != nil {
		t.Fatal(e)
	}
	tx := types.NewTx(&types.DynamicFeeTx{ChainID: big.NewInt(1), To: &cfg.Proxy, Gas: 125000, GasFeeCap: big.NewInt(4_000_000_000), GasTipCap: big.NewInt(2_000_000_000), Data: data})
	if _, e = loaded.Sign(tx, big.NewInt(1)); e != nil {
		t.Fatal(e)
	}
	if _, e = loaded.Sign(tx, big.NewInt(31337)); e == nil {
		t.Fatal("wrong chain signed")
	}
	if e = os.Chmod(cfg.Live.PasswordFile, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e = LoadSigner(cfg); e == nil {
		t.Fatal("unsafe password file loaded")
	}
}

func TestConfirmationDepthPayoutAndReorg(t *testing.T) {
	for _, mode := range []string{"confirmations", "event", "reorg"} {
		t.Run(mode, func(t *testing.T) {
			x, f, _, _, r := fixture(t)
			arm(t, x)
			if e := x.Tick(context.Background(), &r); e != nil {
				t.Fatal(e)
			}
			mined(t, f, true)
			switch mode {
			case "confirmations":
				f.head = f.blocks[101]
			case "event":
				f.receipt.Logs = nil
			case "reorg":
				copy := types.CopyHeader(f.blocks[101])
				copy.Extra = []byte{1}
				f.blocks[101] = copy
			}
			_ = x.Tick(context.Background(), nil)
			v := x.View()
			if mode == "event" {
				if v.LastSettlement == nil || v.LastSettlement.Status != "unverified" || v.Armed || v.Fault == "" {
					t.Fatal("missing event credited as profit")
				}
			} else if v.PendingHash == (common.Hash{}) || v.LastSettlement != nil {
				t.Fatal("unconfirmed or reorganized receipt settled")
			}
		})
	}
}
func TestUnknownReplacementKeepsReserveAndBlocksAcknowledgement(t *testing.T) {
	x, f, _, _, r := fixture(t)
	arm(t, x)
	if e := x.Tick(context.Background(), &r); e != nil {
		t.Fatal(e)
	}
	f.nonce = 1
	advance(f, 103)
	_ = x.Tick(context.Background(), nil)
	if x.View().Fault == "" || x.View().PendingHash == (common.Hash{}) || x.View().ReservedGasWei == "0" {
		t.Fatal("unknown replacement lost its reserve")
	}
	if x.Acknowledge("ACKNOWLEDGE "+x.cfg.Owner.Hex()) == nil {
		t.Fatal("unresolved nonce was acknowledged away")
	}
}
func TestRetryUsesIdenticalSignatureAndNonce(t *testing.T) {
	x, f, s, _, r := fixture(t)
	arm(t, x)
	f.sendError = true
	_ = x.Tick(context.Background(), &r)
	p := *x.j.Pending
	p.LastAttempt = time.Now().Add(-time.Minute)
	j := x.j
	j.Pending = &p
	if e := x.commit(j); e != nil {
		t.Fatal(e)
	}
	_ = x.Tick(context.Background(), nil)
	if len(f.sent) != 2 || s.calls != 1 || f.sent[0].Hash() != f.sent[1].Hash() {
		t.Fatal("recovery created a new transaction")
	}
}
func TestZeroAttemptExpiryCanReleaseUnbroadcastRecord(t *testing.T) {
	x, f, s, _, r := fixture(t)
	arm(t, x)
	s.onSign = func() { x.armed.Store(false) }
	_ = x.Tick(context.Background(), &r)
	if x.j.Pending == nil || x.j.Pending.Attempts != 0 || len(f.sent) != 0 {
		t.Fatal("unexpected pre-broadcast state")
	}
	advance(f, 102)
	_ = x.Tick(context.Background(), nil)
	if x.View().PendingHash != (common.Hash{}) || x.View().ReservedGasWei != "0" {
		t.Fatal("provably unbroadcast expiry retained")
	}
}
func TestEmergencyStopWaitsForInFlightSendAndPreventsNewSigning(t *testing.T) {
	x, f, s, _, r := fixture(t)
	arm(t, x)
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	var releaseOnce sync.Once
	releaseSend := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseSend()
	f.beforeSend = func(*types.Transaction) { once.Do(func() { close(started) }); <-release }
	tickDone := make(chan struct{})
	go func() { _ = x.Tick(context.Background(), &r); close(tickDone) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("send did not start")
	}
	stopped := make(chan struct{})
	go func() { x.Disarm(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("disarm returned during in-flight send")
	case <-time.After(20 * time.Millisecond):
	}
	releaseSend()
	<-tickDone
	<-stopped
	if x.View().Armed {
		t.Fatal("emergency stop left execution armed")
	}
	_ = x.Tick(context.Background(), &r)
	if s.calls != 1 {
		t.Fatal("signed after stop")
	}
}
