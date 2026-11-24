package config

import (
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

type Config struct {
	RPC         string
	Listen      string
	Interval    time.Duration
	Tokens      []common.Address
	Sizes       []*big.Int
	GasUnits    uint64
	PriorityWei *big.Int
	MinimumNet  *big.Int
	BufferBPS   uint32
	Proxy       common.Address
	Owner       common.Address
	Model       string
	APIKey      string
}

func Load() (Config, error) { return Parse(os.Getenv) }

func Parse(env func(string) string) (c Config, err error) {
	if v := env("ALLOW_LIVE_TRADING"); v != "" && v != "off" {
		return c, errors.New("this Go release supports paper mode only; ALLOW_LIVE_TRADING must be off")
	}
	c.RPC = env("RPC_URL")
	u, e := url.Parse(c.RPC)
	if e != nil || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && loopback(u.Hostname()))) {
		return c, errors.New("RPC_URL must be HTTPS or loopback HTTP, without userinfo or fragment")
	}
	c.Listen = value(env, "GO_LISTEN", "127.0.0.1:7780")
	host, _, e := net.SplitHostPort(c.Listen)
	if e != nil || !loopback(host) {
		return c, errors.New("GO_LISTEN must bind a loopback IP address")
	}
	c.Interval, e = time.ParseDuration(value(env, "SCAN_INTERVAL", "15s"))
	if e != nil || c.Interval < time.Second || c.Interval > time.Hour {
		return c, errors.New("SCAN_INTERVAL must be between 1s and 1h")
	}
	for _, s := range strings.Split(value(env, "SCAN_TOKENS", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599,0x514910771AF9Ca656af840dff83E8264EcF986CA"), ",") {
		a, e := address(strings.TrimSpace(s))
		if e != nil {
			return c, fmt.Errorf("SCAN_TOKENS: %w", e)
		}
		if a == common.HexToAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2") {
			return c, errors.New("SCAN_TOKENS must exclude WETH")
		}
		for _, existing := range c.Tokens {
			if existing == a {
				return c, errors.New("duplicate token")
			}
		}
		c.Tokens = append(c.Tokens, a)
	}
	if len(c.Tokens) > 20 {
		return c, errors.New("SCAN_TOKENS exceeds 20-token request budget")
	}
	for _, s := range strings.Split(value(env, "LOAN_SIZES_WEI", "10000000000000000,100000000000000000,1000000000000000000"), ",") {
		n, e := positive(strings.TrimSpace(s))
		if e != nil || n.BitLen() > 127 {
			return c, errors.New("invalid LOAN_SIZES_WEI")
		}
		c.Sizes = append(c.Sizes, n)
	}
	if len(c.Sizes) > 16 {
		return c, errors.New("too many loan sizes")
	}
	c.GasUnits, e = strconv.ParseUint(value(env, "GAS_BUDGET_UNITS", "600000"), 10, 64)
	if e != nil || c.GasUnits < 21000 || c.GasUnits > 30_000_000 {
		return c, errors.New("invalid GAS_BUDGET_UNITS")
	}
	c.PriorityWei, e = positive(value(env, "PRIORITY_FEE_WEI", "2000000000"))
	if e != nil {
		return c, e
	}
	c.MinimumNet, e = positive(value(env, "MIN_NET_WEI", "1000000000000000"))
	if e != nil {
		return c, e
	}
	b, e := strconv.ParseUint(value(env, "QUOTE_BUFFER_BPS", "50"), 10, 32)
	if e != nil || b > 1000 {
		return c, errors.New("QUOTE_BUFFER_BPS must be 0..1000")
	}
	c.BufferBPS = uint32(b)
	if env("FLASH_ARB_PROXY") != "" {
		c.Proxy, e = address(env("FLASH_ARB_PROXY"))
		if e != nil {
			return c, e
		}
		c.Owner, e = address(env("FLASH_ARB_OWNER"))
		if e != nil {
			return c, errors.New("FLASH_ARB_OWNER required with proxy")
		}
	} else if env("FLASH_ARB_OWNER") != "" {
		return c, errors.New("FLASH_ARB_PROXY required with owner")
	}
	c.Model = value(env, "OPENROUTER_MODEL", "deepseek/deepseek-chat-v3-0324")
	if !strings.HasPrefix(c.Model, "deepseek/") || len(c.Model) > 120 {
		return c, errors.New("OPENROUTER_MODEL must be a DeepSeek model ID")
	}
	c.APIKey = env("OPENROUTER_API_KEY")
	if file := env("OPENROUTER_API_KEY_FILE"); file != "" {
		if c.APIKey != "" {
			return c, errors.New("choose one OpenRouter key source")
		}
		info, e := os.Lstat(file)
		if e != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
			return c, errors.New("OpenRouter key file must be a small regular file")
		}
		if info.Mode().Perm()&0077 != 0 {
			return c, errors.New("OpenRouter key file must have owner-only permissions (chmod 600)")
		}
		data, e := os.ReadFile(file)
		if e != nil {
			return c, errors.New("cannot read OpenRouter key file")
		}
		c.APIKey = strings.TrimSpace(string(data))
	}
	if strings.ContainsAny(c.APIKey, "\r\n") {
		return c, errors.New("invalid OpenRouter key")
	}
	return c, nil
}
func value(env func(string) string, k, d string) string {
	if v := env(k); v != "" {
		return v
	}
	return d
}
func loopback(s string) bool { ip := net.ParseIP(s); return ip != nil && ip.IsLoopback() }
func address(s string) (common.Address, error) {
	if !common.IsHexAddress(s) || common.HexToAddress(s) == (common.Address{}) {
		return common.Address{}, errors.New("invalid nonzero address")
	}
	return common.HexToAddress(s), nil
}
func positive(s string) (*big.Int, error) {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.Sign() <= 0 || n.BitLen() > 256 {
		return nil, errors.New("expected positive uint256 integer")
	}
	return n, nil
}
