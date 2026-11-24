// Package artifacts embeds copies of the upstream compiler artifacts. Solidity
// sources are retained unchanged; scripts/check-artifacts.py verifies provenance.
package artifacts

import (
	"embed"
	"encoding/json"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common/hexutil"
)

//go:embed proxy.json logic-v4.json
var files embed.FS

type Artifact struct {
	ABI      abi.ABI
	Runtime  []byte
	Bytecode []byte
}

func Load(name string) (Artifact, error) {
	var out Artifact
	b, e := files.ReadFile(name + ".json")
	if e != nil {
		return out, e
	}
	var raw struct {
		ABI      json.RawMessage `json:"abi"`
		Runtime  string          `json:"runtime"`
		Bytecode string          `json:"bytecode"`
	}
	if e = json.Unmarshal(b, &raw); e != nil {
		return out, e
	}
	out.ABI, e = abi.JSON(strings.NewReader(string(raw.ABI)))
	if e != nil {
		return out, e
	}
	out.Runtime, e = hexutil.Decode(raw.Runtime)
	if e != nil {
		return out, e
	}
	out.Bytecode, e = hexutil.Decode(raw.Bytecode)
	return out, e
}
