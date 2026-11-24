package evm

import (
	"context"
	"errors"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

var WETH = common.HexToAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")

var poolABI = mustABI(`[
 {"type":"function","name":"getPair","inputs":[{"name":"a","type":"address"},{"name":"b","type":"address"}],"outputs":[{"type":"address"}]},
 {"type":"function","name":"token0","inputs":[],"outputs":[{"type":"address"}]},
 {"type":"function","name":"token1","inputs":[],"outputs":[{"type":"address"}]},
 {"type":"function","name":"getReserves","inputs":[],"outputs":[{"type":"uint112"},{"type":"uint112"},{"type":"uint32"}]}]`)

func mustABI(s string) abi.ABI {
	a, e := abi.JSON(strings.NewReader(s))
	if e != nil {
		panic(e)
	}
	return a
}

// Chain exposes no signing or broadcast methods to the scanner.
type Chain interface {
	ChainID(context.Context) (*big.Int, error)
	HeaderByNumber(context.Context, *big.Int) (*types.Header, error)
	CallContractAtHash(context.Context, ethereum.CallMsg, common.Hash) ([]byte, error)
	CodeAtHash(context.Context, common.Address, common.Hash) ([]byte, error)
	StorageAtHash(context.Context, common.Address, common.Hash, common.Hash) ([]byte, error)
}

func Dial(ctx context.Context, url string) (*ethclient.Client, error) {
	c, e := ethclient.DialContext(ctx, url)
	if e != nil {
		return nil, errors.New("RPC connection failed")
	}
	id, e := c.ChainID(ctx)
	if e != nil || id.Cmp(big.NewInt(1)) != 0 {
		c.Close()
		return nil, errors.New("RPC must report Ethereum mainnet chain ID 1")
	}
	return c, nil
}

func read(ctx context.Context, c Chain, address common.Address, hash common.Hash, method string, args ...any) ([]any, error) {
	data, e := poolABI.Pack(method, args...)
	if e != nil {
		return nil, e
	}
	result, e := c.CallContractAtHash(ctx, ethereum.CallMsg{To: &address, Data: data}, hash)
	if e != nil {
		return nil, errors.New("pool RPC read failed")
	}
	return poolABI.Unpack(method, result)
}
