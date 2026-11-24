// wallet creates a new encrypted wallet locally. It does not fund, deploy,
// export a plaintext private key, or enable live trading.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ethereum/go-ethereum/accounts/keystore"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/google/uuid"
	"golang.org/x/term"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	out := flag.String("out", ".secrets/wallet.json", "new encrypted keystore file (never overwritten)")
	flag.Parse()
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("run wallet creation in an interactive local terminal")
	}
	dir := filepath.Dir(*out)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return fmt.Errorf("cannot create wallet directory")
	}
	info, e := os.Lstat(dir)
	if e != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("wallet directory must be private (chmod 700)")
	}
	fmt.Fprint(os.Stderr, "New wallet password (at least 12 characters, hidden): ")
	password, e := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if e != nil {
		return fmt.Errorf("cannot read password")
	}
	defer clear(password)
	if len(password) < 12 {
		return fmt.Errorf("password must contain at least 12 characters")
	}
	fmt.Fprint(os.Stderr, "Confirm password (hidden): ")
	confirm, e := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if e != nil {
		return fmt.Errorf("cannot read password confirmation")
	}
	defer clear(confirm)
	if string(password) != string(confirm) {
		return fmt.Errorf("passwords did not match")
	}
	key, e := crypto.GenerateKey()
	if e != nil {
		return fmt.Errorf("cannot generate wallet")
	}
	address := crypto.PubkeyToAddress(key.PublicKey)
	encoded, e := keystore.EncryptKey(&keystore.Key{Id: uuid.New(), Address: address, PrivateKey: key}, string(password), keystore.StandardScryptN, keystore.StandardScryptP)
	if e != nil {
		return fmt.Errorf("cannot encrypt wallet")
	}
	f, e := os.OpenFile(*out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return fmt.Errorf("cannot create new wallet file; existing files are never overwritten")
	}
	if _, e = f.Write(encoded); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil || closeErr != nil {
		return fmt.Errorf("wallet write failed; verify the file before using it")
	}
	fmt.Printf("Public wallet address: %s\nEncrypted keystore: %s\nBack up the encrypted keystore and password separately. Live trading remains disarmed.\n", address.Hex(), *out)
	return nil
}
