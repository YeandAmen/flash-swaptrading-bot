package live

import (
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/gofrs/flock"
)

type Pending struct {
	Hash        common.Hash `json:"hash"`
	Raw         string      `json:"raw_transaction"`
	Nonce       uint64      `json:"nonce"`
	MaxBlock    uint64      `json:"max_block"`
	ReserveWei  string      `json:"reserve_wei"`
	Attempts    int         `json:"attempts"`
	LastAttempt time.Time   `json:"last_attempt"`
}
type Settlement struct {
	Hash      common.Hash `json:"hash"`
	Block     uint64      `json:"block"`
	BlockHash common.Hash `json:"block_hash"`
	At        time.Time   `json:"at"`
	Status    string      `json:"status"`
	GasWei    string      `json:"gas_wei"`
	ProfitWei string      `json:"profit_wei,omitempty"`
	NetWei    string      `json:"net_wei,omitempty"`
}
type journal struct {
	Version     int            `json:"version"`
	ChainID     string         `json:"chain_id"`
	Owner       common.Address `json:"owner"`
	Proxy       common.Address `json:"proxy"`
	Fault       string         `json:"fault,omitempty"`
	NextNonce   *uint64        `json:"next_nonce"`
	Pending     *Pending       `json:"pending"`
	Settlements []Settlement   `json:"settlements"`
}
type store struct {
	path string
	lock *flock.Flock
}

func openStore(dir string, owner, proxy common.Address, chain *big.Int) (*store, journal, error) {
	var j journal
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, j, errors.New("cannot create journal directory")
	}
	info, e := os.Lstat(dir)
	if e != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, j, errors.New("journal directory must be private (chmod 700)")
	}
	lockPath := filepath.Join(dir, "executor.lock")
	f, e := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, j, errors.New("cannot create journal lock")
	}
	f.Close()
	lockInfo, e := os.Lstat(lockPath)
	if e != nil || !lockInfo.Mode().IsRegular() || lockInfo.Mode().Perm()&0077 != 0 {
		return nil, j, errors.New("invalid journal lock file")
	}
	s := &store{path: filepath.Join(dir, "journal.json"), lock: flock.New(lockPath)}
	ok, e := s.lock.TryLock()
	if e != nil || !ok {
		return nil, j, errors.New("another executor owns this data directory")
	}
	fail := func() (*store, journal, error) {
		s.lock.Unlock()
		return nil, journal{}, errors.New("journal is invalid or belongs to another wallet, proxy or chain")
	}
	if _, e = os.Lstat(s.path); os.IsNotExist(e) {
		j = journal{Version: 1, ChainID: chain.String(), Owner: owner, Proxy: proxy, Settlements: []Settlement{}}
		if e = s.save(j); e != nil {
			s.lock.Unlock()
			return nil, j, e
		}
		return s, j, nil
	}
	b, e := readPrivate(s.path, 8<<20)
	if e != nil {
		return fail()
	}
	if json.Unmarshal(b, &j) != nil || j.Version != 1 || j.Owner != owner || j.Proxy != proxy || j.ChainID != chain.String() || len(j.Settlements) > 4096 {
		return fail()
	}
	seen := map[common.Hash]bool{}
	for _, r := range j.Settlements {
		n, ok := new(big.Int).SetString(r.GasWei, 10)
		if !ok || n.Sign() < 0 || n.BitLen() > 256 || r.Hash == (common.Hash{}) || seen[r.Hash] || r.BlockHash == (common.Hash{}) || r.At.IsZero() || (r.Status != "confirmed" && r.Status != "reverted" && r.Status != "unverified") {
			return fail()
		}
		seen[r.Hash] = true
		if r.At.After(time.Now().Add(2*time.Minute)) || r.Block == 0 {
			return fail()
		}
		if r.Status == "unverified" {
			if r.ProfitWei != "" || r.NetWei != "" {
				return fail()
			}
		} else {
			profit, ok := new(big.Int).SetString(r.ProfitWei, 10)
			net, ok2 := new(big.Int).SetString(r.NetWei, 10)
			if !ok || !ok2 || profit.Sign() < 0 || new(big.Int).Sub(profit, n).Cmp(net) != 0 {
				return fail()
			}
			if (r.Status == "reverted" && profit.Sign() != 0) || (r.Status == "confirmed" && net.Sign() <= 0) {
				return fail()
			}
		}
	}
	if p := j.Pending; p != nil {
		tx, e := pendingTransaction(p, owner, proxy, chain)
		if e != nil || seen[p.Hash] || tx.Hash() != p.Hash {
			return fail()
		}
	}
	return s, j, nil
}
func pendingTransaction(p *Pending, owner, proxy common.Address, chain *big.Int) (*types.Transaction, error) {
	if p == nil || len(p.Raw) > 12000 || p.Attempts < 0 || p.Attempts > 3 {
		return nil, errors.New("invalid pending transaction")
	}
	b, e := hexutil.Decode(p.Raw)
	if e != nil {
		return nil, errors.New("invalid transaction journal bytes")
	}
	tx := new(types.Transaction)
	if tx.UnmarshalBinary(b) != nil {
		return nil, errors.New("invalid journal transaction")
	}
	order, e := decodeTransaction(tx, proxy, chain)
	if e != nil {
		return nil, e
	}
	sender, e := types.Sender(types.LatestSignerForChainID(chain), tx)
	cost := new(big.Int).Mul(new(big.Int).SetUint64(tx.Gas()), tx.GasFeeCap())
	if e != nil || sender != owner || tx.Hash() != p.Hash || tx.Nonce() != p.Nonce || order.MaxBlock.Uint64() != p.MaxBlock || cost.String() != p.ReserveWei || order.MinProfit.Cmp(cost) <= 0 {
		return nil, errors.New("journal transaction binding mismatch")
	}
	return tx, nil
}

// save fsyncs the file before atomic rename, then fsyncs the directory. A send
// cannot proceed until the signed transaction and full gas reserve are durable.
func (s *store) save(j journal) error {
	b, e := json.MarshalIndent(j, "", "  ")
	if e != nil {
		return errors.New("cannot encode execution journal")
	}
	dir := filepath.Dir(s.path)
	f, e := os.CreateTemp(dir, ".journal-*")
	if e != nil {
		return errors.New("cannot create durable journal")
	}
	name := f.Name()
	defer os.Remove(name)
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil || closeErr != nil {
		return errors.New("cannot flush execution journal")
	}
	if os.Rename(name, s.path) != nil {
		return errors.New("cannot replace execution journal")
	}
	d, e := os.Open(dir)
	if e != nil {
		return errors.New("cannot open journal directory")
	}
	defer d.Close()
	if d.Sync() != nil {
		return errors.New("cannot flush journal directory")
	}
	return nil
}
