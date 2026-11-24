package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/advisor"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/config"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/httpapi"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/market"
	"github.com/ethereum/go-ethereum/common"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func run() error {
	demo := flag.Bool("demo", false, "use synthetic reserve fixtures; no blockchain connection")
	once := flag.Bool("once", false, "print one JSON report and exit")
	flag.Parse()
	env := func(k string) string {
		if *demo && k == "RPC_URL" {
			return "http://127.0.0.1:8545"
		}
		return os.Getenv(k)
	}
	cfg, e := config.Parse(env)
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var scan func(context.Context) (evm.Report, error)
	if *demo {
		scan = func(context.Context) (evm.Report, error) { return demoReport(cfg), nil }
	} else {
		dialCtx, stop := context.WithTimeout(ctx, 15*time.Second)
		client, e := evm.Dial(dialCtx, cfg.RPC)
		stop()
		if e != nil {
			return e
		}
		defer client.Close()
		scanner := &evm.Scanner{Chain: client, Config: cfg}
		scan = scanner.Scan
	}
	state := &httpapi.State{}
	cycle := func() (evm.Report, error) {
		callCtx, stop := context.WithTimeout(ctx, 45*time.Second)
		defer stop()
		return scan(callCtx)
	}
	if *once {
		r, e := cycle()
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(r)
	}
	ai := advisor.New(cfg.APIKey, cfg.Model)
	server := &http.Server{Addr: cfg.Listen, Handler: httpapi.New(cfg.Listen, state, ai), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 55 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		for {
			r, e := cycle()
			if e != nil {
				state.Fail()
				log.Print("scan failed; check RPC and configuration")
			} else {
				state.Publish(r)
				log.Printf("%s block=%d pools=%d candidates=%d simulations=%d", r.Mode, r.Block, r.Pools, len(r.Candidates), len(r.Simulations))
			}
			timer := time.NewTimer(cfg.Interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
	go func() {
		<-ctx.Done()
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = server.Shutdown(shutdown)
	}()
	fmt.Printf("Go paper backend: http://%s (model enabled: %t)\n", cfg.Listen, ai.Enabled())
	if e := server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		return e
	}
	return nil
}

func demoReport(cfg config.Config) evm.Report {
	n := func(s string) *big.Int { x, _ := new(big.Int).SetString(s, 10); return x }
	token := common.HexToAddress("0x0000000000000000000000000000000000000010")
	pools := []market.Pool{
		{Address: common.HexToAddress("0x0000000000000000000000000000000000000020"), Token: token, Venue: "Fixture A", Kind: 0, Fee: 3000, WETH: n("100000000000000000000"), Tokens: n("200000000000")},
		{Address: common.HexToAddress("0x0000000000000000000000000000000000000030"), Token: token, Venue: "Fixture B", Kind: 1, Fee: 3000, WETH: n("120000000000000000000"), Tokens: n("200000000000")},
	}
	now := time.Now().UTC()
	return evm.Report{Mode: "demo", ChainID: 1, Block: 0, BlockTime: now, ScannedAt: now, Pools: 2, Warnings: []string{"Synthetic fixtures only; no RPC reads or actual trading opportunities."}, Candidates: market.Rank(pools, cfg.Sizes, big.NewInt(6_000_000_000_000_000), cfg.MinimumNet, cfg.BufferBPS), Simulations: []evm.Simulation{}}
}
