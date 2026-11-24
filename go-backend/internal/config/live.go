package config

import (
	"errors"
	"math/big"
	"net/url"
	"path/filepath"
	"strconv"

	"github.com/ethereum/go-ethereum/common"
)

// Limits are expressed in wei, not floating-point ETH or inferred USD values.
type Live struct {
	Allowed         bool
	SendRPC         string
	DataDir         string
	KeyFile         string
	PasswordFile    string
	MaxGasWei       *big.Int
	DailyGasWei     *big.Int
	MaxPrincipalWei *big.Int
	MaxFeeWei       *big.Int
	Confirmations   uint64
}

func parseLive(env func(string) string, proxy, owner common.Address) (c Live, e error) {
	v := value(env, "ALLOW_LIVE_TRADING", "off")
	if v != "off" && v != "on" {
		return c, errors.New("ALLOW_LIVE_TRADING must be on or off")
	}
	c.Allowed = v == "on"
	c.SendRPC = value(env, "SEND_RPC_URL", "https://rpc.flashbots.net/fast")
	u, err := url.Parse(c.SendRPC)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && loopback(u.Hostname()))) {
		return c, errors.New("invalid SEND_RPC_URL")
	}
	c.DataDir = filepath.Clean(value(env, "GO_DATA_DIR", "data/go-live"))
	c.KeyFile = env("WALLET_KEYSTORE_FILE")
	c.PasswordFile = env("WALLET_PASSWORD_FILE")
	c.Confirmations, err = strconv.ParseUint(value(env, "LIVE_CONFIRMATIONS", "3"), 10, 64)
	if err != nil || c.Confirmations < 2 || c.Confirmations > 64 {
		return c, errors.New("LIVE_CONFIRMATIONS must be 2..64")
	}
	if !c.Allowed {
		return c, nil
	}
	if proxy == (common.Address{}) || owner == (common.Address{}) || c.KeyFile == "" || c.PasswordFile == "" {
		return c, errors.New("live mode requires proxy, owner, encrypted keystore and password-file paths")
	}
	for _, item := range []struct {
		name string
		dest **big.Int
	}{
		{"LIVE_MAX_GAS_WEI", &c.MaxGasWei}, {"LIVE_DAILY_GAS_WEI", &c.DailyGasWei},
		{"LIVE_MAX_PRINCIPAL_WEI", &c.MaxPrincipalWei}, {"LIVE_MAX_FEE_PER_GAS_WEI", &c.MaxFeeWei},
	} {
		*item.dest, e = positive(env(item.name))
		if e != nil {
			return c, errors.New(item.name + " must be an explicit positive integer")
		}
	}
	if c.DailyGasWei.Cmp(c.MaxGasWei) < 0 {
		return c, errors.New("daily gas allowance must cover the per-transaction allowance")
	}
	return c, nil
}
