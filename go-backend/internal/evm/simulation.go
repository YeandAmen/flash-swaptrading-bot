package evm

import (
	"bytes"
	"context"
	"errors"
	"math/big"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

type ContractPool struct {
	Kind        uint8
	Pool        common.Address
	Fee         *big.Int // uint24
	TickSpacing *big.Int // int24
	NativeEth   bool
}
type Order struct {
	Funding   uint8
	Token     common.Address
	Buy       ContractPool
	Sell      ContractPool
	AmountIn  *big.Int
	MinProfit *big.Int
	Tip       *big.Int
	MaxBlock  *big.Int
}
type Simulation struct {
	Candidate          int         `json:"candidate_index"`
	Status             string      `json:"status"`
	Reason             string      `json:"reason,omitempty"`
	ProfitWei          string      `json:"simulated_profit_before_gas_wei,omitempty"`
	NetFloorWei        string      `json:"net_floor_wei,omitempty"`
	ImplementationHash common.Hash `json:"implementation_hash,omitempty"`
}

func EncodeOrder(c market.Candidate, minimumNet *big.Int, block uint64) ([]byte, error) {
	logic, e := artifacts.Load("logic-v4")
	if e != nil {
		return nil, e
	}
	amount, ok := new(big.Int).SetString(c.AmountWei, 10)
	if !ok || amount.Sign() <= 0 || amount.BitLen() > 127 {
		return nil, errors.New("invalid order amount")
	}
	budget, ok := new(big.Int).SetString(c.GasBudgetWei, 10)
	if !ok || budget.Sign() < 0 || minimumNet == nil || minimumNet.Sign() <= 0 {
		return nil, errors.New("invalid profit budget")
	}
	pool := func(p market.Pool) ContractPool {
		return ContractPool{p.Kind, p.Address, new(big.Int).SetUint64(uint64(p.Fee)), big.NewInt(0), false}
	}
	order := Order{0, c.Token, pool(c.Buy), pool(c.Sell), amount, new(big.Int).Add(budget, minimumNet), big.NewInt(0), new(big.Int).SetUint64(block)}
	return logic.ABI.Pack("execute", order)
}

// Simulate verifies both bytecodes and ownership before eth_call. It never
// signs, broadcasts, deploys or upgrades a contract. Gas is capped to the budget.
func Simulate(ctx context.Context, chain Chain, cfg config.Config, c market.Candidate, hash common.Hash, block uint64) (Simulation, error) {
	var result Simulation
	proxy, e := artifacts.Load("proxy")
	if e != nil {
		return result, e
	}
	logic, e := artifacts.Load("logic-v4")
	if e != nil {
		return result, e
	}
	code, e := chain.CodeAtHash(ctx, cfg.Proxy, hash)
	if e != nil || !bytes.Equal(code, proxy.Runtime) {
		return result, errors.New("proxy runtime does not match retained artifact")
	}
	slot := new(big.Int).Sub(new(big.Int).SetBytes(crypto.Keccak256([]byte("eip1967.proxy.implementation"))), big.NewInt(1))
	value, e := chain.StorageAtHash(ctx, cfg.Proxy, common.BigToHash(slot), hash)
	if e != nil || len(value) != 32 {
		return result, errors.New("cannot verify implementation slot")
	}
	impl := common.BytesToAddress(value)
	code, e = chain.CodeAtHash(ctx, impl, hash)
	if e != nil || !bytes.Equal(code, logic.Runtime) {
		return result, errors.New("implementation runtime does not match retained Logic V4")
	}
	ownerData, e := logic.ABI.Pack("owner")
	if e != nil {
		return result, e
	}
	owner, e := chain.CallContractAtHash(ctx, ethereum.CallMsg{To: &cfg.Proxy, Data: ownerData}, hash)
	if e != nil || len(owner) != 32 || common.BytesToAddress(owner) != cfg.Owner {
		return result, errors.New("proxy owner mismatch")
	}
	data, e := EncodeOrder(c, cfg.MinimumNet, block)
	if e != nil {
		return result, e
	}
	implHash := crypto.Keccak256Hash(logic.Runtime)
	data, e = proxy.ABI.Pack("executePinned", implHash, data)
	if e != nil {
		return result, e
	}
	out, e := chain.CallContractAtHash(ctx, ethereum.CallMsg{From: cfg.Owner, To: &cfg.Proxy, Data: data, Gas: cfg.GasUnits}, hash)
	if e != nil {
		return result, errors.New("full executor simulation reverted or RPC failed")
	}
	values, e := proxy.ABI.Unpack("executePinned", out)
	if e != nil {
		return result, errors.New("invalid executor response")
	}
	profit := values[0].(*big.Int)
	budget, ok := new(big.Int).SetString(c.GasBudgetWei, 10)
	if !ok {
		return result, errors.New("invalid budget")
	}
	floor := new(big.Int).Add(budget, cfg.MinimumNet)
	if profit.Cmp(floor) < 0 {
		return result, errors.New("simulation did not meet gas and profit floor")
	}
	return Simulation{Status: "simulation_passed", ProfitWei: profit.String(), NetFloorWei: cfg.MinimumNet.String(), ImplementationHash: implHash}, nil
}
