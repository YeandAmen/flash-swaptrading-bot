package live

import (
	"bytes"
	"crypto/ecdsa"
	"errors"
	"math/big"
	"os"
	"strings"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/artifacts"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/keystore"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

type Signer interface {
	Address() common.Address
	Sign(*types.Transaction, *big.Int) (*types.Transaction, error)
}

type keySigner struct {
	key *ecdsa.PrivateKey
	cfg config.Config
}

// LoadSigner only unlocks an owner-only, encrypted Ethereum V3 keystore when
// live mode was explicitly configured. Private keys never enter HTTP state.
func LoadSigner(cfg config.Config) (Signer, error) {
	if !cfg.Live.Allowed {
		return nil, errors.New("live signing is disabled")
	}
	keyJSON, e := readPrivate(cfg.Live.KeyFile, 65536)
	if e != nil {
		return nil, e
	}
	password, e := readPrivate(cfg.Live.PasswordFile, 4096)
	if e != nil {
		return nil, e
	}
	defer clear(password)
	key, e := keystore.DecryptKey(keyJSON, strings.TrimRight(string(password), "\r\n"))
	if e != nil {
		return nil, errors.New("cannot unlock encrypted wallet")
	}
	if key.Address != cfg.Owner || crypto.PubkeyToAddress(key.PrivateKey.PublicKey) != cfg.Owner {
		return nil, errors.New("wallet does not match FLASH_ARB_OWNER")
	}
	return &keySigner{key: key.PrivateKey, cfg: cfg}, nil
}
func readPrivate(path string, max int64) ([]byte, error) {
	f, e := os.OpenFile(path, os.O_RDONLY, 0)
	if e != nil {
		return nil, errors.New("cannot open private credential file")
	}
	defer f.Close()
	info, e := f.Stat()
	link, e2 := os.Lstat(path)
	if e != nil || e2 != nil || !info.Mode().IsRegular() || !link.Mode().IsRegular() || !os.SameFile(info, link) || info.Mode().Perm()&0077 != 0 || info.Size() <= 0 || info.Size() > max {
		return nil, errors.New("credential file must be a small owner-only regular file")
	}
	b := make([]byte, info.Size())
	n, e := f.ReadAt(b, 0)
	if e != nil || n != len(b) {
		return nil, errors.New("cannot read private credential file")
	}
	return b, nil
}
func (s *keySigner) Address() common.Address { return crypto.PubkeyToAddress(s.key.PublicKey) }
func (s *keySigner) Sign(tx *types.Transaction, chain *big.Int) (*types.Transaction, error) {
	if chain.Cmp(big.NewInt(1)) != 0 || tx.ChainId().Cmp(chain) != 0 || !s.cfg.Live.Allowed {
		return nil, errors.New("signer requires enabled mainnet policy")
	}
	order, e := decodeTransaction(tx, s.cfg.Proxy, chain)
	if e != nil {
		return nil, e
	}
	cost := new(big.Int).Mul(new(big.Int).SetUint64(tx.Gas()), tx.GasFeeCap())
	floor := new(big.Int).Add(cost, s.cfg.MinimumNet)
	if tx.Gas() > s.cfg.GasUnits || tx.GasFeeCap().Cmp(s.cfg.Live.MaxFeeWei) > 0 || cost.Cmp(s.cfg.Live.MaxGasWei) > 0 || order.AmountIn.Cmp(s.cfg.Live.MaxPrincipalWei) > 0 || order.MinProfit.Cmp(floor) < 0 {
		return nil, errors.New("signer policy rejected transaction limits")
	}
	allowed := false
	for _, token := range s.cfg.Tokens {
		if token == order.Token {
			allowed = true
		}
	}
	if !allowed {
		return nil, errors.New("signer token is outside the configured universe")
	}
	return types.SignTx(tx, types.LatestSignerForChainID(chain), s.key)
}

func decodeTransaction(tx *types.Transaction, proxyAddress common.Address, chain *big.Int) (evm.Order, error) {
	var order evm.Order
	if tx == nil || tx.Type() != types.DynamicFeeTxType || tx.ChainId().Cmp(chain) != 0 || tx.To() == nil || *tx.To() != proxyAddress || tx.Value().Sign() != 0 || tx.Gas() < 21000 || tx.GasTipCap().Sign() <= 0 || tx.GasTipCap().Cmp(tx.GasFeeCap()) > 0 {
		return order, errors.New("invalid signed execution envelope")
	}
	proxy, e := artifacts.Load("proxy")
	if e != nil {
		return order, e
	}
	logic, e := artifacts.Load("logic-v4")
	if e != nil {
		return order, e
	}
	data := tx.Data()
	method := proxy.ABI.Methods["executePinned"]
	if len(data) < 4 || !bytes.Equal(data[:4], method.ID) {
		return order, errors.New("only executePinned may be signed")
	}
	values, e := method.Inputs.Unpack(data[4:])
	if e != nil || len(values) != 2 {
		return order, errors.New("invalid pinned execution")
	}
	if values[0].([32]byte) != crypto.Keccak256Hash(logic.Runtime) {
		return order, errors.New("unapproved implementation hash")
	}
	inner := values[1].([]byte)
	execute := logic.ABI.Methods["execute"]
	if len(inner) < 4 || !bytes.Equal(inner[:4], execute.ID) {
		return order, errors.New("invalid execution method")
	}
	values, e = execute.Inputs.Unpack(inner[4:])
	if e != nil || len(values) != 1 {
		return order, errors.New("invalid execution arguments")
	}
	order = *abi.ConvertType(values[0], new(evm.Order)).(*evm.Order)
	if order.Funding != 0 || order.Tip.Sign() != 0 || order.MinProfit.Sign() <= 0 || order.AmountIn.Sign() <= 0 || order.AmountIn.BitLen() > 127 || !order.MaxBlock.IsUint64() || order.MaxBlock.Sign() == 0 || order.Token == (common.Address{}) || order.Token == evm.WETH || order.Buy.Pool == order.Sell.Pool {
		return order, errors.New("unsupported execution order")
	}
	for _, p := range []evm.ContractPool{order.Buy, order.Sell} {
		fee := int64(3000)
		if p.Kind == 6 {
			fee = 2500
		}
		if (p.Kind != 0 && p.Kind != 1 && p.Kind != 6) || p.Fee.Cmp(big.NewInt(fee)) != 0 || p.TickSpacing.Sign() != 0 || p.NativeEth || p.Pool == (common.Address{}) {
			return order, errors.New("unsupported V2 route")
		}
	}
	return order, nil
}
