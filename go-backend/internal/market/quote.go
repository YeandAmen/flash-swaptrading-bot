// Package market implements integer-only screening for canonical V2 pools.
// Quotes are estimates, never evidence of an executable or settled profit.
package market

import (
	"errors"
	"math/big"
	"sort"

	"github.com/ethereum/go-ethereum/common"
)

type Pool struct {
	Address common.Address `json:"address"`
	Token   common.Address `json:"token"`
	Venue   string         `json:"venue"`
	Kind    uint8          `json:"kind"`
	Fee     uint32         `json:"fee_ppm"`
	WETH    *big.Int       `json:"-"`
	Tokens  *big.Int       `json:"-"`
}

type Candidate struct {
	Token        common.Address `json:"token"`
	Buy          Pool           `json:"buy"`
	Sell         Pool           `json:"sell"`
	AmountWei    string         `json:"amount_wei"`
	OutputWei    string         `json:"estimated_output_wei"`
	GrossWei     string         `json:"estimated_gross_wei"`
	GasBudgetWei string         `json:"gas_budget_wei"`
	NetWei       string         `json:"conservative_net_wei"`
	Status       string         `json:"status"`
}

// AmountOut follows the V2 constant-product formula, including integer truncation.
func AmountOut(amount, in, out *big.Int, fee uint32) (*big.Int, error) {
	if amount == nil || in == nil || out == nil || amount.Sign() <= 0 || in.Sign() <= 0 || out.Sign() <= 0 || fee >= 1_000_000 {
		return nil, errors.New("invalid amount, reserves or fee")
	}
	adjusted := new(big.Int).Mul(amount, big.NewInt(int64(1_000_000-fee)))
	num := new(big.Int).Mul(adjusted, out)
	den := new(big.Int).Add(new(big.Int).Mul(in, big.NewInt(1_000_000)), adjusted)
	return num.Div(num, den), nil
}

// Rank models BuyPool flash funding: the buy pool lends its token output and
// receives amountIn WETH in the callback. The pool trading fee is already in
// AmountOut; no fictitious extra lender premium is charged.
func Rank(pools []Pool, sizes []*big.Int, gasBudget, minimumNet *big.Int, bufferBPS uint32) []Candidate {
	result := make([]Candidate, 0)
	if gasBudget == nil || minimumNet == nil || gasBudget.Sign() < 0 || minimumNet.Sign() <= 0 || bufferBPS >= 10_000 {
		return result
	}
	for _, buy := range pools {
		for _, sell := range pools {
			if buy.Token != sell.Token || buy.Address == sell.Address {
				continue
			}
			for _, size := range sizes {
				tokens, err := AmountOut(size, buy.WETH, buy.Tokens, buy.Fee)
				if err != nil {
					continue
				}
				output, err := AmountOut(tokens, sell.Tokens, sell.WETH, sell.Fee)
				if err != nil {
					continue
				}
				gross := new(big.Int).Sub(output, size)
				guarded := new(big.Int).Div(new(big.Int).Mul(output, big.NewInt(int64(10_000-bufferBPS))), big.NewInt(10_000))
				net := new(big.Int).Sub(new(big.Int).Sub(guarded, size), gasBudget)
				if net.Cmp(minimumNet) < 0 {
					continue
				}
				result = append(result, Candidate{buy.Token, buy, sell, size.String(), output.String(), gross.String(), gasBudget.String(), net.String(), "quote_only"})
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		a, _ := new(big.Int).SetString(result[i].NetWei, 10)
		b, _ := new(big.Int).SetString(result[j].NetWei, 10)
		return a.Cmp(b) > 0
	})
	return result
}
