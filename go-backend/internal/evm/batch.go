package evm

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sync"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/rpc"
)

type rpcProvider interface{ Client() *rpc.Client }
type poolRead struct {
	to     common.Address
	method string
	args   []any
}
type poolResult struct {
	values []any
	err    error
}

// batchReads pins every eth_call to the same block hash. Each result is decoded
// separately; a successful HTTP batch cannot disguise an individual RPC error.
func batchReads(ctx context.Context, client *rpc.Client, hash common.Hash, reads []poolRead) ([]poolResult, int, error) {
	results := make([]poolResult, len(reads))
	var wg sync.WaitGroup
	var mu sync.Mutex
	var transport error
	sem := make(chan struct{}, 4)
	batches := 0
	for start := 0; start < len(reads); start += 24 {
		end := start + 24
		if end > len(reads) {
			end = len(reads)
		}
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			return nil, batches, ctx.Err()
		}
		batches++
		wg.Add(1)
		go func(start, end int) {
			defer wg.Done()
			defer func() { <-sem }()
			data := make([]hexutil.Bytes, end-start)
			elems := make([]rpc.BatchElem, end-start)
			for i := start; i < end; i++ {
				read := reads[i]
				payload, e := poolABI.Pack(read.method, read.args...)
				if e != nil {
					mu.Lock()
					transport = errors.New("cannot encode pool batch")
					mu.Unlock()
					return
				}
				elems[i-start] = rpc.BatchElem{Method: "eth_call", Args: []any{map[string]any{"to": read.to, "data": hexutil.Bytes(payload)}, rpc.BlockNumberOrHashWithHash(hash, false)}, Result: &data[i-start]}
			}
			if e := client.BatchCallContext(ctx, elems); e != nil {
				mu.Lock()
				transport = errors.New("batch transport failed")
				mu.Unlock()
				return
			}
			for i, elem := range elems {
				index := start + i
				if elem.Error != nil {
					results[index].err = errors.New("individual batch call failed")
					continue
				}
				values, e := poolABI.Unpack(reads[index].method, data[i])
				results[index] = poolResult{values: values, err: e}
			}
		}(start, end)
	}
	wg.Wait()
	return results, batches, transport
}

func (s *Scanner) batchPools(ctx context.Context, client *rpc.Client, hash common.Hash) ([]market.Pool, []string, int, error) {
	var discovery []poolRead
	type route struct {
		token common.Address
		venue venue
		pair  common.Address
	}
	var routes []route
	for _, token := range s.Config.Tokens {
		for _, v := range venues {
			discovery = append(discovery, poolRead{v.Factory, "getPair", []any{WETH, token}})
			routes = append(routes, route{token: token, venue: v})
		}
	}
	found, batches, e := batchReads(ctx, client, hash, discovery)
	if e != nil {
		return nil, nil, batches, e
	}
	warnings := []string{}
	var actual []route
	var state []poolRead
	for i, result := range found {
		r := routes[i]
		if result.err != nil {
			warnings = append(warnings, fmt.Sprintf("%s %s: pool discovery unavailable", r.venue.Name, r.token.Hex()))
			continue
		}
		pair := result.values[0].(common.Address)
		if pair == (common.Address{}) {
			continue
		}
		r.pair = pair
		actual = append(actual, r)
		for _, method := range []string{"token0", "token1", "getReserves"} {
			state = append(state, poolRead{to: pair, method: method})
		}
	}
	values, count, e := batchReads(ctx, client, hash, state)
	batches += count
	if e != nil {
		return nil, nil, batches, e
	}
	pools := make([]market.Pool, 0, len(actual))
	for i, r := range actual {
		v := values[i*3 : i*3+3]
		if v[0].err != nil || v[1].err != nil || v[2].err != nil {
			warnings = append(warnings, fmt.Sprintf("%s %s: pool state unavailable", r.venue.Name, r.token.Hex()))
			continue
		}
		first, second := v[0].values[0].(common.Address), v[1].values[0].(common.Address)
		if !((first == WETH && second == r.token) || (first == r.token && second == WETH)) {
			warnings = append(warnings, fmt.Sprintf("%s %s: pair token mismatch", r.venue.Name, r.token.Hex()))
			continue
		}
		w, tokens := v[2].values[0], v[2].values[1]
		if first != WETH {
			w, tokens = tokens, w
		}
		pool := market.Pool{Address: r.pair, Token: r.token, Venue: r.venue.Name, Kind: r.venue.Kind, Fee: r.venue.Fee}
		pool.WETH = w.(*big.Int)
		pool.Tokens = tokens.(*big.Int)
		if pool.WETH.Sign() > 0 && pool.Tokens.Sign() > 0 {
			pools = append(pools, pool)
		}
	}
	return pools, warnings, batches, nil
}
