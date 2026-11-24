package config

import (
	"os"
	"path/filepath"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(k string) string {
		if k == "RPC_URL" && values[k] == "" {
			return "https://rpc.example"
		}
		return values[k]
	}
}
func TestDefaultsAndFailClosed(t *testing.T) {
	c, e := Parse(env(nil))
	if e != nil {
		t.Fatal(e)
	}
	if c.Listen != "127.0.0.1:7780" || len(c.Sizes) != 3 || len(c.Tokens) != 3 {
		t.Fatal("bad defaults")
	}
	for _, v := range []map[string]string{
		{"ALLOW_LIVE_TRADING": "on"}, {"RPC_URL": "http://remote.example"}, {"RPC_URL": "https://user:password@rpc.example"},
		{"GO_LISTEN": "0.0.0.0:7780"}, {"SCAN_INTERVAL": "0s"}, {"SCAN_TOKENS": "not-an-address"},
		{"LOAN_SIZES_WEI": "-1"}, {"MIN_NET_WEI": "0"}, {"QUOTE_BUFFER_BPS": "10001"}, {"GAS_BUDGET_UNITS": "0"},
		{"FLASH_ARB_PROXY": "0x0000000000000000000000000000000000000010"},
	} {
		if _, e := Parse(env(v)); e == nil {
			t.Fatalf("accepted %+v", v)
		}
	}
}
func TestKeyFilePermissions(t *testing.T) {
	f := filepath.Join(t.TempDir(), "openrouter.key")
	if e := os.WriteFile(f, []byte("test-secret\n"), 0600); e != nil {
		t.Fatal(e)
	}
	c, e := Parse(env(map[string]string{"OPENROUTER_API_KEY_FILE": f}))
	if e != nil || c.APIKey != "test-secret" {
		t.Fatal("protected key not loaded", e)
	}
	if e := os.Chmod(f, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e := Parse(env(map[string]string{"OPENROUTER_API_KEY_FILE": f})); e == nil {
		t.Fatal("world-readable key accepted")
	}
}

func TestLiveRequiresExplicitLimitsAndCredentials(t *testing.T) {
	v := map[string]string{"ALLOW_LIVE_TRADING": "on", "FLASH_ARB_PROXY": "0x0000000000000000000000000000000000000010", "FLASH_ARB_OWNER": "0x0000000000000000000000000000000000000020", "WALLET_KEYSTORE_FILE": "private/wallet.json", "WALLET_PASSWORD_FILE": "private/password", "LIVE_MAX_GAS_WEI": "1000", "LIVE_DAILY_GAS_WEI": "2000", "LIVE_MAX_PRINCIPAL_WEI": "100000", "LIVE_MAX_FEE_PER_GAS_WEI": "100"}
	c, e := Parse(env(v))
	if e != nil || !c.Live.Allowed {
		t.Fatal("complete live config rejected", e)
	}
	for _, name := range []string{"WALLET_PASSWORD_FILE", "LIVE_MAX_GAS_WEI", "LIVE_DAILY_GAS_WEI", "LIVE_MAX_PRINCIPAL_WEI", "LIVE_MAX_FEE_PER_GAS_WEI"} {
		old := v[name]
		delete(v, name)
		if _, e := Parse(env(v)); e == nil {
			t.Fatal("missing safety setting accepted", name)
		}
		v[name] = old
	}
	v["LIVE_CONFIRMATIONS"] = "1"
	if _, e := Parse(env(v)); e == nil {
		t.Fatal("insufficient confirmation depth accepted")
	}
}
