package live

import (
	"context"
	"errors"
	"math/big"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

func (x *Executor) recover(ctx context.Context) error {
	// Recheck the last settled block: its hash commits to all prior ancestors.
	if n := len(x.j.Settlements); n > 0 {
		last := x.j.Settlements[n-1]
		h, e := x.read.HeaderByNumber(ctx, new(big.Int).SetUint64(last.Block))
		if e != nil {
			return errors.New("cannot recheck last settlement block")
		}
		if h.Hash() != last.BlockHash {
			return x.stop("Previously confirmed settlement was reorganized; operator review required")
		}
	}
	p := x.j.Pending
	if p == nil {
		return nil
	}
	tx, e := pendingTransaction(p, x.cfg.Owner, x.cfg.Proxy, x.chain)
	if e != nil {
		return x.stop("Pending transaction journal is invalid")
	}
	h, e := x.read.HeaderByNumber(ctx, nil)
	if e != nil {
		return errors.New("cannot reconcile chain head")
	}
	receipt, e := x.read.TransactionReceipt(ctx, p.Hash)
	if e != nil && !errors.Is(e, ethereum.NotFound) {
		return errors.New("receipt RPC failed; nonce remains reserved")
	}
	if e == nil && receipt != nil {
		if receipt.BlockNumber == nil || receipt.TxHash != p.Hash || !receipt.BlockNumber.IsUint64() {
			return x.stop("Malformed transaction receipt; nonce remains reserved")
		}
		block, e := x.read.HeaderByNumber(ctx, receipt.BlockNumber)
		if e != nil {
			return errors.New("cannot verify receipt block")
		}
		if block.Hash() != receipt.BlockHash {
			x.publish("Receipt was reorganized; nonce remains reserved")
			return nil
		}
		if h.Number.Cmp(receipt.BlockNumber) < 0 || new(big.Int).Sub(h.Number, receipt.BlockNumber).Uint64() < x.cfg.Live.Confirmations-1 {
			x.publish("Mined; awaiting canonical confirmations")
			return nil
		}
		if receipt.GasUsed > tx.Gas() || receipt.EffectiveGasPrice == nil || receipt.EffectiveGasPrice.Sign() <= 0 || receipt.EffectiveGasPrice.Cmp(tx.GasFeeCap()) > 0 || receipt.Status > 1 {
			return x.stop("Receipt gas or status is inconsistent with the signed transaction")
		}
		gas := new(big.Int).Mul(new(big.Int).SetUint64(receipt.GasUsed), receipt.EffectiveGasPrice)
		r := Settlement{Hash: p.Hash, Block: receipt.BlockNumber.Uint64(), BlockHash: receipt.BlockHash, At: time.Unix(int64(block.Time), 0).UTC(), GasWei: gas.String(), Status: "confirmed"}
		fault := ""
		if receipt.Status == 0 {
			r.Status = "reverted"
			r.ProfitWei = "0"
			r.NetWei = new(big.Int).Neg(gas).String()
			fault = "Transaction reverted; review the loss before rearming"
		} else {
			profit, e := receiptProfit(tx, receipt, x.cfg.Proxy, x.chain)
			if e != nil {
				r.Status = "unverified"
				fault = "Receipt payout could not be verified; review before rearming"
			} else {
				r.ProfitWei = profit.String()
				r.NetWei = new(big.Int).Sub(profit, gas).String()
			}
		}
		var records []Settlement
		for i, old := range x.j.Settlements {
			if old.At.After(time.Now().Add(-24*time.Hour)) || i >= len(x.j.Settlements)-100 {
				records = append(records, old)
			}
		}
		if len(records) >= 4096 {
			return x.stop("Settlement journal capacity reached; nonce remains reserved")
		}
		if p.Nonce == ^uint64(0) {
			return x.stop("Wallet nonce exhausted")
		}
		next := p.Nonce + 1
		j := x.j
		j.Pending = nil
		j.NextNonce = &next
		j.Settlements = append(records, r)
		// A pre-existing persistent fault is never silently cleared by a receipt.
		if fault != "" {
			j.Fault = fault
			x.fault.Store(fault)
			x.armed.Store(false)
		}
		if e = x.commit(j); e != nil {
			return e
		}
		x.publish("Transaction settled: " + r.Status)
		return nil
	}
	// Confirm an external replacement only after the same confirmation depth.
	if h.Number.Uint64() >= x.cfg.Live.Confirmations-1 {
		safe := new(big.Int).Sub(h.Number, new(big.Int).SetUint64(x.cfg.Live.Confirmations-1))
		n, e := x.read.NonceAt(ctx, x.cfg.Owner, safe)
		if e != nil {
			return errors.New("cannot reconcile confirmed nonce")
		}
		if n > p.Nonce {
			return x.stop("Nonce consumed by an unknown transaction; reserve retained for operator review")
		}
	}
	if h.Number.Uint64() >= p.MaxBlock {
		if p.Attempts == 0 {
			j := x.j
			j.Pending = nil
			if e = x.commit(j); e != nil {
				return e
			}
			x.publish("Expired unsigned-to-network attempt discarded; no broadcast was attempted")
			return nil
		}
		x.publish("Expired order still unresolved; nonce and full gas reserve retained")
		return nil
	}
	if x.armed.Load() && p.Attempts < 3 && time.Since(p.LastAttempt) > 5*time.Second {
		x.gate.Lock()
		defer x.gate.Unlock()
		return x.sendLocked(ctx)
	}
	x.publish("Pending transaction; nonce and gas reserve retained")
	return nil
}

func receiptProfit(tx *types.Transaction, r *types.Receipt, proxyAddress common.Address, chain *big.Int) (*big.Int, error) {
	order, e := decodeTransaction(tx, proxyAddress, chain)
	if e != nil {
		return nil, e
	}
	logic, e := artifacts.Load("logic-v4")
	if e != nil {
		return nil, e
	}
	event := logic.ABI.Events["Arbitrage"]
	var profit *big.Int
	for _, log := range r.Logs {
		if log == nil {
			continue
		}
		if log.Address != proxyAddress || len(log.Topics) == 0 || log.Topics[0] != event.ID {
			continue
		}
		if profit != nil || log.Removed || len(log.Topics) != 2 || common.BytesToAddress(log.Topics[1].Bytes()) != order.Token || log.TxHash != r.TxHash || log.BlockHash != r.BlockHash {
			return nil, errors.New("ambiguous payout event")
		}
		v, e := event.Inputs.NonIndexed().Unpack(log.Data)
		if e != nil || len(v) != 5 {
			return nil, errors.New("malformed payout event")
		}
		if v[0].(common.Address) != order.Buy.Pool || v[1].(common.Address) != order.Sell.Pool || v[2].(*big.Int).Cmp(order.AmountIn) != 0 || v[4].(*big.Int).Sign() != 0 {
			return nil, errors.New("payout event does not match signed route")
		}
		profit = v[3].(*big.Int)
	}
	if profit == nil || profit.Cmp(order.MinProfit) < 0 {
		return nil, errors.New("missing or insufficient payout event")
	}
	return profit, nil
}
