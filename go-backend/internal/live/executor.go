package live

import (
	"context"
	"errors"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
)

type Backend interface {
	evm.Chain
	PendingCallContract(context.Context, ethereum.CallMsg) ([]byte, error)
	EstimateGas(context.Context, ethereum.CallMsg) (uint64, error)
	PendingNonceAt(context.Context, common.Address) (uint64, error)
	NonceAt(context.Context, common.Address, *big.Int) (uint64, error)
	BalanceAt(context.Context, common.Address, *big.Int) (*big.Int, error)
	TransactionReceipt(context.Context, common.Hash) (*types.Receipt, error)
}
type Sender interface {
	ChainID(context.Context) (*big.Int, error)
	SendTransaction(context.Context, *types.Transaction) error
}
type View struct {
	Enabled         bool           `json:"enabled"`
	Armed           bool           `json:"armed"`
	Owner           common.Address `json:"owner"`
	Proxy           common.Address `json:"proxy"`
	MaxGasWei       string         `json:"max_gas_wei"`
	DailyGasWei     string         `json:"daily_gas_wei"`
	MaxPrincipalWei string         `json:"max_principal_wei"`
	MaxFeeWei       string         `json:"max_fee_per_gas_wei"`
	MinimumNetWei   string         `json:"minimum_net_wei"`
	Confirmations   uint64         `json:"confirmations"`
	Status          string         `json:"status"`
	Fault           string         `json:"fault,omitempty"`
	PendingHash     common.Hash    `json:"pending_hash,omitempty"`
	PendingNonce    uint64         `json:"pending_nonce,omitempty"`
	ReservedGasWei  string         `json:"reserved_gas_wei"`
	Spent24hWei     string         `json:"spent_24h_wei"`
	LastSettlement  *Settlement    `json:"last_settlement,omitempty"`
}
type Executor struct {
	read   Backend
	sender Sender
	signer Signer
	cfg    config.Config
	chain  *big.Int
	store  *store
	j      journal
	mu     sync.Mutex
	gate   sync.Mutex
	armed  atomic.Bool
	fault  atomic.Value
	view   atomic.Value
}

func New(ctx context.Context, read Backend, sender Sender, signer Signer, cfg config.Config) (*Executor, error) {
	return newExecutor(ctx, read, sender, signer, cfg, big.NewInt(1))
}

// Non-mainnet chain IDs are only supplied by package-local integration tests.
func newExecutor(ctx context.Context, read Backend, sender Sender, signer Signer, cfg config.Config, chain *big.Int) (*Executor, error) {
	if !cfg.Live.Allowed || signer == nil || signer.Address() != cfg.Owner {
		return nil, errors.New("live execution requires the configured owner signer")
	}
	for _, limit := range []*big.Int{cfg.Live.MaxGasWei, cfg.Live.DailyGasWei, cfg.Live.MaxFeeWei, cfg.Live.MaxPrincipalWei, cfg.MinimumNet} {
		if limit == nil || limit.Sign() <= 0 {
			return nil, errors.New("live limits must be explicitly positive")
		}
	}
	if cfg.Live.Confirmations < 2 || cfg.Live.DailyGasWei.Cmp(cfg.Live.MaxGasWei) < 0 {
		return nil, errors.New("invalid live safety limits")
	}
	for _, c := range []interface {
		ChainID(context.Context) (*big.Int, error)
	}{read, sender} {
		id, e := c.ChainID(ctx)
		if e != nil || id.Cmp(chain) != 0 {
			return nil, errors.New("read and send RPCs must match the execution chain")
		}
	}
	h, e := read.HeaderByNumber(ctx, nil)
	if e != nil {
		return nil, errors.New("cannot verify deployment head")
	}
	if _, e = evm.VerifyDeployment(ctx, read, cfg, h.Hash()); e != nil {
		return nil, e
	}
	s, j, e := openStore(cfg.Live.DataDir, cfg.Owner, cfg.Proxy, chain)
	if e != nil {
		return nil, e
	}
	x := &Executor{read: read, sender: sender, signer: signer, cfg: cfg, chain: new(big.Int).Set(chain), store: s, j: j}
	x.fault.Store(j.Fault)
	if j.NextNonce == nil {
		n, e := read.NonceAt(ctx, cfg.Owner, nil)
		if e != nil {
			s.lock.Unlock()
			return nil, errors.New("cannot initialize wallet nonce")
		}
		x.j.NextNonce = &n
		if e = s.save(x.j); e != nil {
			s.lock.Unlock()
			return nil, e
		}
	}
	if x.j.Pending != nil && x.j.Pending.Nonce != *x.j.NextNonce {
		s.lock.Unlock()
		return nil, errors.New("journal nonce does not match reserved transaction")
	}
	x.publish("Disarmed; explicit arming is required after every restart")
	return x, nil
}
func (x *Executor) Close() { x.Disarm(); x.mu.Lock(); defer x.mu.Unlock(); _ = x.store.lock.Unlock() }
func (x *Executor) View() View {
	v := x.view.Load().(View)
	v.Armed = x.armed.Load()
	v.Fault = x.fault.Load().(string)
	return v
}
func (x *Executor) Arm(confirmation string) error {
	x.gate.Lock()
	defer x.gate.Unlock()
	if confirmation != "ARM LIVE "+x.cfg.Owner.Hex() {
		return errors.New("type ARM LIVE followed by the exact wallet address")
	}
	if x.fault.Load().(string) != "" {
		return errors.New("resolve the execution fault before arming")
	}
	x.armed.Store(true)
	if x.fault.Load().(string) != "" {
		x.armed.Store(false)
		return errors.New("execution fault appeared while arming")
	}
	return nil
}

// Disarm prevents future sends. An RPC call already in flight can still land;
// this call waits for that submission section to finish (bounded RPC timeout).
func (x *Executor) Disarm() {
	x.armed.Store(false)
	x.gate.Lock()
	x.armed.Store(false)
	x.gate.Unlock()
}
func (x *Executor) Acknowledge(confirmation string) error {
	if confirmation != "ACKNOWLEDGE "+x.cfg.Owner.Hex() {
		return errors.New("type ACKNOWLEDGE followed by the exact wallet address")
	}
	x.Disarm()
	x.mu.Lock()
	defer x.mu.Unlock()
	x.gate.Lock()
	defer x.gate.Unlock()
	x.armed.Store(false)
	if x.j.Pending != nil {
		return errors.New("cannot acknowledge an unresolved nonce")
	}
	j := x.j
	j.Fault = ""
	if e := x.commit(j); e != nil {
		return e
	}
	x.fault.Store("")
	x.publish("Fault acknowledged; still disarmed")
	return nil
}
func (x *Executor) spent() *big.Int {
	n := new(big.Int)
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, r := range x.j.Settlements {
		if r.At.After(cutoff) {
			v, _ := new(big.Int).SetString(r.GasWei, 10)
			n.Add(n, v)
		}
	}
	return n
}
func (x *Executor) publish(status string) {
	v := View{Enabled: true, Owner: x.cfg.Owner, Status: status, ReservedGasWei: "0", Spent24hWei: x.spent().String()}
	v.Proxy = x.cfg.Proxy
	v.MaxGasWei = x.cfg.Live.MaxGasWei.String()
	v.DailyGasWei = x.cfg.Live.DailyGasWei.String()
	v.MaxPrincipalWei = x.cfg.Live.MaxPrincipalWei.String()
	v.MaxFeeWei = x.cfg.Live.MaxFeeWei.String()
	v.MinimumNetWei = x.cfg.MinimumNet.String()
	v.Confirmations = x.cfg.Live.Confirmations
	if p := x.j.Pending; p != nil {
		v.PendingHash = p.Hash
		v.PendingNonce = p.Nonce
		v.ReservedGasWei = p.ReserveWei
	}
	if n := len(x.j.Settlements); n > 0 {
		r := x.j.Settlements[n-1]
		v.LastSettlement = &r
	}
	x.view.Store(v)
}
func (x *Executor) commit(j journal) error {
	if e := x.store.save(j); e != nil {
		x.fault.Store("Journal persistence failed; execution stopped")
		x.armed.Store(false)
		return e
	}
	x.j = j
	return nil
}
func (x *Executor) stop(reason string) error {
	x.fault.Store(reason)
	x.armed.Store(false)
	j := x.j
	j.Fault = reason
	e := x.commit(j)
	x.publish(reason)
	if e != nil {
		return e
	}
	return errors.New(reason)
}

// Tick always reconciles pending transactions, even when disarmed. It submits
// at most one new transaction, after both snapshot and pending-state simulation.
func (x *Executor) Tick(ctx context.Context, report *evm.Report) (err error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	defer func() {
		if err != nil {
			x.publish(err.Error())
		} else {
			x.publish(x.View().Status)
		}
	}()
	if e := x.recover(ctx); e != nil {
		return e
	}
	if x.j.Pending != nil || !x.armed.Load() || x.fault.Load().(string) != "" {
		return nil
	}
	if report == nil || report.Mode != "paper" || report.ChainID != x.chain.Uint64() || time.Since(report.ScannedAt) > 30*time.Second {
		return errors.New("live execution requires a fresh paper report")
	}
	if len(report.Candidates) == 0 {
		x.publish("Armed; waiting for a qualifying route")
		return nil
	}
	for i, c := range report.Candidates {
		if i == 3 {
			break
		}
		if e := x.submit(ctx, *report, c); e != nil {
			x.publish(e.Error())
			if x.j.Pending != nil || x.fault.Load().(string) != "" {
				return e
			}
			continue
		}
		return nil
	}
	return nil
}

func (x *Executor) submit(ctx context.Context, r evm.Report, c market.Candidate) error {
	id, e := x.read.ChainID(ctx)
	if e != nil || id.Cmp(x.chain) != 0 {
		return errors.New("execution chain changed")
	}
	h, e := x.read.HeaderByNumber(ctx, nil)
	if e != nil || h.Hash() != r.Hash || h.Number.Uint64() != r.Block || h.BaseFee == nil || time.Since(time.Unix(int64(h.Time), 0)) > 45*time.Second {
		return errors.New("quote head changed or is stale; rescan required")
	}
	if r.Block == ^uint64(0) {
		return errors.New("invalid deadline block")
	}
	if _, e = evm.VerifyDeployment(ctx, x.read, x.cfg, r.Hash); e != nil {
		return e
	}
	amount, ok := new(big.Int).SetString(c.AmountWei, 10)
	if !ok || amount.Sign() <= 0 || amount.Cmp(x.cfg.Live.MaxPrincipalWei) > 0 {
		return errors.New("loan exceeds principal limit")
	}
	fee := new(big.Int).Add(new(big.Int).Mul(h.BaseFee, big.NewInt(2)), x.cfg.PriorityWei)
	if fee.Cmp(x.cfg.Live.MaxFeeWei) > 0 {
		return errors.New("fee per gas exceeds live limit")
	}
	gas := x.cfg.GasUnits
	budget := new(big.Int).Mul(new(big.Int).SetUint64(gas), fee)
	c.GasBudgetWei = budget.String()
	data, e := evm.EncodePinned(c, x.cfg.MinimumNet, r.Block+1)
	if e != nil {
		return e
	}
	msg := ethereum.CallMsg{From: x.cfg.Owner, To: &x.cfg.Proxy, Data: data, Gas: gas, GasFeeCap: fee, GasTipCap: x.cfg.PriorityWei}
	balance, e := x.read.BalanceAt(ctx, x.cfg.Owner, nil)
	if e != nil || balance.Cmp(budget) < 0 {
		return errors.New("wallet lacks ETH for the full gas envelope")
	}
	estimate, e := x.read.EstimateGas(ctx, msg)
	if e != nil || estimate > gas {
		return errors.New("gas estimation failed or exceeded gas-unit ceiling")
	}
	padded := estimate + (estimate+3)/4
	if padded < estimate || padded > gas {
		return errors.New("padded gas exceeds gas-unit ceiling")
	}
	gas = padded
	budget = new(big.Int).Mul(new(big.Int).SetUint64(gas), fee)
	if budget.Cmp(x.cfg.Live.MaxGasWei) > 0 || new(big.Int).Add(x.spent(), budget).Cmp(x.cfg.Live.DailyGasWei) > 0 {
		return errors.New("per-transaction or rolling daily gas allowance exceeded")
	}
	c.GasBudgetWei = budget.String()
	data, e = evm.EncodePinned(c, x.cfg.MinimumNet, r.Block+1)
	if e != nil {
		return e
	}
	msg.Data = data
	msg.Gas = gas
	if _, e = decodeTransaction(types.NewTx(&types.DynamicFeeTx{ChainID: x.chain, To: &x.cfg.Proxy, Gas: gas, GasFeeCap: fee, GasTipCap: x.cfg.PriorityWei, Data: data}), x.cfg.Proxy, x.chain); e != nil {
		return e
	}
	floor := new(big.Int).Add(budget, x.cfg.MinimumNet)
	for _, pending := range []bool{false, true} {
		var out []byte
		if pending {
			out, e = x.read.PendingCallContract(ctx, msg)
		} else {
			out, e = x.read.CallContractAtHash(ctx, msg, r.Hash)
		}
		if e != nil {
			return errors.New("final snapshot or pending simulation failed")
		}
		profit, e := evm.DecodeProfit(out)
		if e != nil || profit.Cmp(floor) < 0 {
			return errors.New("final simulation failed the gas and profit floor")
		}
	}
	nonce, e := x.read.NonceAt(ctx, x.cfg.Owner, nil)
	if e != nil {
		return errors.New("cannot read confirmed nonce")
	}
	pendingNonce, e := x.read.PendingNonceAt(ctx, x.cfg.Owner)
	if e != nil {
		return errors.New("cannot read pending nonce")
	}
	if nonce != *x.j.NextNonce || pendingNonce != nonce {
		return x.stop("Wallet nonce changed outside the journal; operator review required")
	}
	unsigned := types.NewTx(&types.DynamicFeeTx{ChainID: x.chain, Nonce: nonce, To: &x.cfg.Proxy, Gas: gas, GasFeeCap: fee, GasTipCap: x.cfg.PriorityWei, Data: data})
	x.gate.Lock()
	defer x.gate.Unlock()
	if !x.armed.Load() || ctx.Err() != nil {
		return errors.New("disarmed before signing")
	}
	current, e := x.read.HeaderByNumber(ctx, nil)
	if e != nil || current.Hash() != r.Hash {
		return errors.New("head changed before signing; rescan required")
	}
	signed, e := x.signer.Sign(unsigned, x.chain)
	if e != nil {
		return errors.New("wallet signer rejected transaction")
	}
	wire, e := signed.MarshalBinary()
	if e != nil {
		return errors.New("cannot encode signed transaction")
	}
	p := &Pending{Hash: signed.Hash(), Raw: hexutil.Encode(wire), Nonce: nonce, MaxBlock: r.Block + 1, ReserveWei: budget.String()}
	if _, e = pendingTransaction(p, x.cfg.Owner, x.cfg.Proxy, x.chain); e != nil {
		return e
	}
	j := x.j
	j.Pending = p
	if e = x.commit(j); e != nil {
		return e
	}
	return x.sendLocked(ctx)
}

// gate and mu are held. The reservation and attempt counter are durable before
// an RPC sees any signed bytes. A timeout never frees a nonce or its reserve.
func (x *Executor) sendLocked(ctx context.Context) error {
	if !x.armed.Load() || ctx.Err() != nil {
		return errors.New("disarmed before broadcast")
	}
	p := *x.j.Pending
	if p.Attempts >= 3 {
		return errors.New("broadcast attempt limit reached; awaiting settlement")
	}
	tx, e := pendingTransaction(&p, x.cfg.Owner, x.cfg.Proxy, x.chain)
	if e != nil {
		return x.stop("Invalid pending transaction")
	}
	h, e := x.read.HeaderByNumber(ctx, nil)
	if e != nil || h.Number.Uint64() >= p.MaxBlock {
		return errors.New("target block passed before broadcast; awaiting recovery")
	}
	if !x.armed.Load() {
		return errors.New("disarmed before broadcast")
	}
	p.Attempts++
	p.LastAttempt = time.Now().UTC()
	j := x.j
	j.Pending = &p
	if e = x.commit(j); e != nil {
		return e
	}
	sendCtx, stop := context.WithTimeout(ctx, 8*time.Second)
	defer stop()
	if !x.armed.Load() {
		return errors.New("disarmed before RPC send")
	}
	if e = x.sender.SendTransaction(sendCtx, tx); e != nil {
		x.publish("RPC outcome uncertain; nonce and full gas reserve retained")
		return errors.New("broadcast outcome uncertain; reconciling the same transaction")
	}
	x.publish("Transaction submitted; awaiting canonical confirmations")
	return nil
}
