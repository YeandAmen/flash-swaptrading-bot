package evm

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum/common"
)

type venue struct {
	Name    string
	Factory common.Address
	Kind    uint8
	Fee     uint32
}

var venues = []venue{
	{"Uniswap V2", common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"), 0, 3000},
	{"SushiSwap V2", common.HexToAddress("0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"), 1, 3000},
	{"PancakeSwap V2", common.HexToAddress("0x1097053Fd2ea711dad45caCcc45EfF7548fCB362"), 6, 2500},
}

type Report struct {
	ReadMode        string             `json:"read_mode"`
	BatchRequests   int                `json:"batch_requests"`
	Mode            string             `json:"mode"`
	ChainID         uint64             `json:"chain_id"`
	Block           uint64             `json:"block"`
	Hash            common.Hash        `json:"block_hash"`
	BlockTime       time.Time          `json:"block_time"`
	ScannedAt       time.Time          `json:"scanned_at"`
	Pools           int                `json:"pools"`
	Warnings        []string           `json:"warnings"`
	Candidates      []market.Candidate `json:"candidates"`
	Simulations     []Simulation       `json:"simulations"`
	QuotesEvaluated int                `json:"quotes_evaluated"`
	BestQuote       *market.Candidate  `json:"best_quote,omitempty"`
	BestGrossQuote  *market.Candidate  `json:"best_gross_quote,omitempty"`
	ScanDurationMS  int64              `json:"scan_duration_ms"`
	MinimumNetWei   string             `json:"minimum_net_wei"`
}

type Scanner struct {
	Chain  Chain
	Config config.Config
}

func (s *Scanner) Scan(ctx context.Context) (Report, error) {
	var r Report
	id, e := s.Chain.ChainID(ctx)
	if e != nil || id.Cmp(big.NewInt(1)) != 0 {
		return r, errors.New("scanner requires Ethereum mainnet chain ID 1")
	}
	h, e := s.Chain.HeaderByNumber(ctx, nil)
	if e != nil {
		return r, errors.New("cannot read chain head")
	}
	now := time.Now().UTC()
	if h.BaseFee == nil || h.BaseFee.Sign() <= 0 || h.Number == nil || !h.Number.IsUint64() || h.Time > uint64(now.Add(30*time.Second).Unix()) || now.Sub(time.Unix(int64(h.Time), 0)) > 2*time.Minute {
		return r, errors.New("chain head is stale or missing EIP-1559 fields")
	}
	r = Report{Mode: "paper", ChainID: 1, Block: h.Number.Uint64(), Hash: h.Hash(), BlockTime: time.Unix(int64(h.Time), 0).UTC(), ScannedAt: now, Warnings: []string{}, Candidates: []market.Candidate{}, Simulations: []Simulation{}}
	var pools []market.Pool
	r.ReadMode = "bounded_individual"
	batched := false
	if provider, ok := s.Chain.(rpcProvider); ok {
		p, warning, count, e := s.batchPools(ctx, provider.Client(), r.Hash)
		r.BatchRequests = count
		if e == nil {
			pools = p
			r.Warnings = warning
			r.ReadMode = "batch"
			batched = true
		} else {
			if ctx.Err() != nil {
				return Report{}, ctx.Err()
			}
			r.ReadMode = "bounded_individual_fallback"
			r.Warnings = append(r.Warnings, "Batch transport unavailable; using bounded individual reads")
		}
	}
	if !batched {
		var mu sync.Mutex
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
		for _, token := range s.Config.Tokens {
			for _, v := range venues {
				select {
				case sem <- struct{}{}:
				case <-ctx.Done():
					wg.Wait()
					return Report{}, ctx.Err()
				}
				wg.Add(1)
				go func(token common.Address, v venue) {
					defer wg.Done()
					defer func() { <-sem }()
					p, exists, e := s.pool(ctx, token, v, r.Hash)
					mu.Lock()
					defer mu.Unlock()
					if e != nil {
						r.Warnings = append(r.Warnings, fmt.Sprintf("%s %s: pool unavailable or invalid", v.Name, token.Hex()))
					} else if exists {
						pools = append(pools, p)
					}
				}(token, v)
			}
		}
		wg.Wait()
	}
	if ctx.Err() != nil {
		return Report{}, ctx.Err()
	}
	if len(pools) == 0 && len(r.Warnings) > 0 {
		return Report{}, errors.New("no usable pool reads; check RPC block-hash call support")
	}
	r.Pools = len(pools)
	sort.Slice(pools, func(i, j int) bool { return pools[i].Address.Hex() < pools[j].Address.Hex() })
	sort.Strings(r.Warnings)
	feeCap := new(big.Int).Add(new(big.Int).Mul(h.BaseFee, big.NewInt(2)), s.Config.PriorityWei)
	budget := new(big.Int).Mul(feeCap, new(big.Int).SetUint64(s.Config.GasUnits))
	quotes := market.Evaluate(pools, s.Config.Sizes, budget, s.Config.MinimumNet, s.Config.BufferBPS)
	r.QuotesEvaluated = len(quotes)
	r.MinimumNetWei = s.Config.MinimumNet.String()
	if len(quotes) > 0 {
		best := quotes[0]
		r.BestQuote = &best
	}
	for _, quote := range quotes {
		gross, _ := new(big.Int).SetString(quote.GrossWei, 10)
		if r.BestGrossQuote == nil {
			v := quote
			r.BestGrossQuote = &v
		} else {
			best, _ := new(big.Int).SetString(r.BestGrossQuote.GrossWei, 10)
			if gross.Cmp(best) > 0 {
				v := quote
				r.BestGrossQuote = &v
			}
		}
	}
	for _, quote := range quotes {
		if quote.Status == "quote_only" {
			r.Candidates = append(r.Candidates, quote)
		}
	}
	if len(r.Candidates) > 10 {
		r.Candidates = r.Candidates[:10]
	}
	if s.Config.Proxy != (common.Address{}) {
		for i, c := range r.Candidates {
			if i >= 3 {
				break
			}
			sim, e := Simulate(ctx, s.Chain, s.Config, c, r.Hash, r.Block)
			if e != nil {
				sim = Simulation{Status: "rejected", Reason: e.Error(), Candidate: i}
			} else {
				sim.Candidate = i
			}
			r.Simulations = append(r.Simulations, sim)
		}
	}
	canonical, e := s.Chain.HeaderByNumber(ctx, h.Number)
	if e != nil || canonical.Hash() != r.Hash {
		return Report{}, errors.New("snapshot block changed during scan; discarding results")
	}
	r.ScannedAt = time.Now().UTC()
	r.ScanDurationMS = time.Since(now).Milliseconds()
	return r, nil
}

func (s *Scanner) pool(ctx context.Context, token common.Address, v venue, hash common.Hash) (market.Pool, bool, error) {
	var p market.Pool
	values, e := read(ctx, s.Chain, v.Factory, hash, "getPair", WETH, token)
	if e != nil {
		return p, false, e
	}
	a := values[0].(common.Address)
	if a == (common.Address{}) {
		return p, false, nil
	}
	t0, e := read(ctx, s.Chain, a, hash, "token0")
	if e != nil {
		return p, false, e
	}
	t1, e := read(ctx, s.Chain, a, hash, "token1")
	if e != nil {
		return p, false, e
	}
	first, second := t0[0].(common.Address), t1[0].(common.Address)
	if !((first == WETH && second == token) || (first == token && second == WETH)) {
		return p, false, errors.New("pair token mismatch")
	}
	res, e := read(ctx, s.Chain, a, hash, "getReserves")
	if e != nil {
		return p, false, e
	}
	w, t := res[0].(*big.Int), res[1].(*big.Int)
	if first != WETH {
		w, t = t, w
	}
	if w.Sign() == 0 || t.Sign() == 0 {
		return p, false, nil
	}
	return market.Pool{Address: a, Token: token, Venue: v.Name, Kind: v.Kind, Fee: v.Fee, WETH: w, Tokens: t}, true, nil
}
