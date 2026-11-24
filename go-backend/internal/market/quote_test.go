package market

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestAmountOut(t *testing.T) {
	// 1000 in against 10000/20000 reserves at 0.3%, with floor rounding.
	x, e := AmountOut(big.NewInt(1000), big.NewInt(10000), big.NewInt(20000), 3000)
	if e != nil || x.String() != "1813" {
		t.Fatalf("output=%v error=%v", x, e)
	}
	for _, fee := range []uint32{3000, 2500} {
		in := big.NewInt(1000)
		a := big.NewInt(10000)
		b := big.NewInt(20000)
		_, _ = AmountOut(in, a, b, fee)
		if in.Int64() != 1000 || a.Int64() != 10000 || b.Int64() != 20000 {
			t.Fatal("input mutated")
		}
	}
	if _, e := AmountOut(nil, big.NewInt(1), big.NewInt(1), 3000); e == nil {
		t.Fatal("nil accepted")
	}
	if _, e := AmountOut(big.NewInt(1), big.NewInt(0), big.NewInt(1), 3000); e == nil {
		t.Fatal("zero reserve accepted")
	}
	if _, e := AmountOut(big.NewInt(1), big.NewInt(1), big.NewInt(1), 1000000); e == nil {
		t.Fatal("invalid fee accepted")
	}
}
func TestRankCostsAndDirection(t *testing.T) {
	token := common.HexToAddress("0x10")
	p := []Pool{{Address: common.HexToAddress("0x20"), Token: token, Fee: 3000, WETH: big.NewInt(1000000), Tokens: big.NewInt(2000000)}, {Address: common.HexToAddress("0x30"), Token: token, Fee: 3000, WETH: big.NewInt(1200000), Tokens: big.NewInt(2000000)}}
	r := Rank(p, []*big.Int{big.NewInt(10000)}, big.NewInt(100), big.NewInt(1), 50)
	if len(r) != 1 || r[0].Buy.Address != p[0].Address || r[0].Sell.Address != p[1].Address || r[0].Status != "quote_only" {
		t.Fatalf("unexpected routes: %+v", r)
	}
	if len(Rank(p, []*big.Int{big.NewInt(10000)}, big.NewInt(1000000), big.NewInt(1), 50)) != 0 {
		t.Fatal("unprofitable route admitted")
	}
	p[1].WETH = big.NewInt(1000000)
	if len(Rank(p, []*big.Int{big.NewInt(10000)}, big.NewInt(0), big.NewInt(1), 0)) != 0 {
		t.Fatal("equal-price round trip profitable")
	}
}
func FuzzAmountOutInvariant(f *testing.F) {
	f.Add(uint64(1000), uint64(10000), uint64(20000), uint32(3000))
	f.Fuzz(func(t *testing.T, amount, in, out uint64, fee uint32) {
		if amount == 0 || in == 0 || out == 0 || fee >= 1000000 {
			t.Skip()
		}
		a, b, c := new(big.Int).SetUint64(amount), new(big.Int).SetUint64(in), new(big.Int).SetUint64(out)
		x, e := AmountOut(a, b, c, fee)
		if e != nil {
			t.Fatal(e)
		}
		if x.Sign() < 0 || x.Cmp(c) >= 0 {
			t.Fatal("output outside reserves")
		}
		before := new(big.Int).Mul(b, c)
		after := new(big.Int).Mul(new(big.Int).Add(b, a), new(big.Int).Sub(c, x))
		if after.Cmp(before) < 0 {
			t.Fatal("constant product decreased")
		}
	})
}

func TestRejectedQuoteDiagnosticsCannotEnterRank(t *testing.T) {
	token := common.HexToAddress("0x10")
	p := []Pool{{Address: common.HexToAddress("0x20"), Token: token, Fee: 3000, WETH: big.NewInt(1000000), Tokens: big.NewInt(2000000)}, {Address: common.HexToAddress("0x30"), Token: token, Fee: 3000, WETH: big.NewInt(1000000), Tokens: big.NewInt(2000000)}}
	quotes := Evaluate(p, []*big.Int{big.NewInt(10000)}, big.NewInt(100), big.NewInt(1), 50)
	if len(quotes) != 2 || quotes[0].Status != "below_profit_floor" {
		t.Fatal("rejection economics missing")
	}
	if len(Rank(p, []*big.Int{big.NewInt(10000)}, big.NewInt(100), big.NewInt(1), 50)) != 0 {
		t.Fatal("diagnostic quote admitted for execution")
	}
}
