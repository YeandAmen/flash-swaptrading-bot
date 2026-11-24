package httpapi

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/advisor"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/evm"
	"github.com/YeandAmen/flash-swaptrading-bot/go-backend/internal/live"
)

type State struct {
	mu        sync.RWMutex
	report    *evm.Report
	lastError string
}

func (s *State) Publish(r evm.Report) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.report = &r
	s.lastError = ""
}
func (s *State) Fail() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastError = "Scan failed; results may be stale. Check RPC availability and configuration."
}
func (s *State) Get() (*evm.Report, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.report, s.lastError
}

func New(listen string, state *State, ai *advisor.Advisor, controllers ...*live.Executor) http.Handler {
	var executor *live.Executor
	if len(controllers) > 0 {
		executor = controllers[0]
	}
	liveView := func() live.View {
		if executor != nil {
			return executor.View()
		}
		return live.View{Status: "Live execution disabled", ReservedGasWei: "0", Spent24hWei: "0"}
	}
	_, port, _ := net.SplitHostPort(listen)
	allowed := map[string]bool{"127.0.0.1:" + port: true, "localhost:" + port: true, "[::1]:" + port: true}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { write(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /api/ready", func(w http.ResponseWriter, r *http.Request) {
		report, err := state.Get()
		ready := fresh(report, err)
		if liveView().Fault != "" {
			ready = false
		}
		status := 503
		if ready {
			status = 200
		}
		write(w, status, map[string]bool{"ready": ready, "live_signing": liveView().Armed})
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		report, err := state.Get()
		write(w, 200, map[string]any{"report": report, "error": err, "model_enabled": ai.Enabled(), "live_signing": liveView().Armed, "live": liveView(), "fresh": fresh(report, err)})
	})
	mux.HandleFunc("POST /api/live/disarm", func(w http.ResponseWriter, r *http.Request) {
		if executor != nil {
			executor.Disarm()
		}
		write(w, 200, liveView())
	})
	for _, action := range []string{"arm", "acknowledge"} {
		mux.HandleFunc("POST /api/live/"+action, func(w http.ResponseWriter, r *http.Request) {
			if executor == nil {
				write(w, 409, map[string]string{"error": "Live mode is not configured"})
				return
			}
			var body struct {
				Confirmation string `json:"confirmation"`
			}
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&body) != nil {
				write(w, 400, map[string]string{"error": "Expected a confirmation field"})
				return
			}
			var e error
			if action == "arm" {
				report, err := state.Get()
				if !fresh(report, err) {
					write(w, 409, map[string]string{"error": "A fresh mainnet scan is required before arming"})
					return
				}
				e = executor.Arm(body.Confirmation)
			} else {
				e = executor.Acknowledge(body.Confirmation)
			}
			if e != nil {
				write(w, 409, map[string]string{"error": e.Error()})
				return
			}
			write(w, 200, liveView())
		})
	}
	mux.HandleFunc("POST /api/analyze", func(w http.ResponseWriter, r *http.Request) {
		report, err := state.Get()
		if report == nil || (report.Mode != "demo" && !fresh(report, err)) {
			write(w, 409, map[string]string{"error": "A fresh successful scan is required"})
			return
		}
		result, e := ai.Analyze(r.Context(), *report)
		if e != nil {
			status := 502
			if errors.Is(e, advisor.ErrDisabled) {
				status = 503
			}
			if errors.Is(e, advisor.ErrRateLimited) {
				status = 429
			}
			write(w, status, map[string]string{"error": e.Error()})
			return
		}
		write(w, 200, result)
	})
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(dashboard))
	})
	mux.HandleFunc("GET /app.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write([]byte(appJS))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		if !allowed[r.Host] {
			http.Error(w, "Forbidden host", 403)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && (r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("X-Bot-UI") != "1") {
			http.Error(w, "Forbidden origin", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func fresh(r *evm.Report, err string) bool {
	return r != nil && r.Mode == "paper" && err == "" && time.Since(r.ScannedAt) < 90*time.Second && time.Since(r.BlockTime) < 2*time.Minute
}
func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

const dashboard = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flash trading · Go</title>
<style>body{font:16px system-ui;background:#101820;color:#e9f1f5;max-width:1000px;margin:50px auto;padding:0 24px}h1{font-size:32px}p{line-height:1.6;color:#b9cbd4}.card{background:#1b2934;border:1px solid #344652;border-radius:12px;padding:24px;margin:22px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px ui-monospace;line-height:1.6}button{background:#80e2c0;color:#112820;padding:12px 18px;border:0;border-radius:7px;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:default}small{color:#b9cbd4}</style>
<h1>Flash trading · Go</h1><p>Ethereum scanning and guarded execution. Live mode always starts disarmed.</p>
<div class="card"><h2 id="status">Connecting…</h2><p id="summary"></p><pre id="routes"></pre><small>Quotes and simulations are estimates. They are not settled profits.</small></div>
<div class="card"><h2>Live execution</h2><p>Disarm stops new submissions. Transactions already submitted may still settle. Review the configured limits before arming.</p><pre id="live"></pre><label for="confirmation">Type ARM LIVE followed by the exact owner address, or ACKNOWLEDGE followed by the address to acknowledge a reviewed fault.</label><p><input id="confirmation" size="55" autocomplete="off" aria-label="Live action confirmation"></p><button id="arm" disabled>Arm live</button> <button id="disarm">Disarm</button> <button id="acknowledge" disabled>Acknowledge reviewed fault</button><pre id="control"></pre></div>
<div class="card"><h2>DeepSeek analyst</h2><p>Explain this scan using OpenRouter. Each click sends the report to the configured model and can incur API charges. At most one request per minute.</p><button id="analyze" disabled>Analyze latest scan</button><pre id="analysis">Analysis is optional and cannot authorize trades.</pre></div>
<script src="/app.js" defer></script></html>`

const appJS = `const el=id=>document.getElementById(id);let model=false;
function eth(value){if(!value)return '0';const raw=BigInt(value),sign=raw<0n?'-':'',n=raw<0n?-raw:raw,whole=n/1000000000000000000n,rest=(n%1000000000000000000n).toString().padStart(18,'0').replace(/0+$/,'');return sign+whole.toString()+(rest?'.'+rest:'');}
async function refresh(){try{const res=await fetch('/api/state');if(!res.ok)throw Error('Backend unavailable');const s=await res.json(),r=s.report;model=s.model_enabled;el('status').textContent=r?(r.mode==='demo'?'DEMO · fixture data':s.fresh?'Current scan snapshot':'Stale scan snapshot'):'Waiting for first scan';el('summary').textContent=s.error||(r?'Block '+r.block+' · '+r.pools+' pools · '+r.candidates.length+' candidate estimates · '+r.simulations.length+' simulations · '+r.scanned_at:'Configure RPC_URL to scan Ethereum.');el('routes').textContent=r?JSON.stringify({warnings:r.warnings,candidates:r.candidates,simulations:r.simulations},null,2):'';const v=s.live;el('live').textContent=v.enabled?(v.armed?'ARMED':'DISARMED')+' · '+v.status+'\nOwner: '+v.owner+'\nPer-trade gas limit: '+eth(v.max_gas_wei)+' ETH\n24-hour gas allowance: '+eth(v.daily_gas_wei)+' ETH · spent: '+eth(v.spent_24h_wei)+' ETH\nPending gas reserve: '+eth(v.reserved_gas_wei)+' ETH\nMaximum loan: '+eth(v.max_principal_wei)+' WETH · minimum net: '+eth(v.minimum_net_wei)+' ETH'+(v.fault?'\nSTOP: '+v.fault:'')+(v.last_settlement?'\nLast settlement: '+v.last_settlement.status+(v.last_settlement.net_wei!==undefined?' · net: '+eth(v.last_settlement.net_wei)+' ETH':' · payout unverified')+'\nTransaction: '+v.last_settlement.hash:''):v.status;el('arm').disabled=!s.live.enabled||s.live.armed||!!s.live.fault||!s.fresh;el('acknowledge').disabled=!s.live.enabled||!s.live.fault;el('analyze').disabled=!model||!r||(!s.fresh&&r.mode!=='demo');}catch(e){el('status').textContent='Connection unavailable';el('analyze').disabled=true;el('arm').disabled=true;}}
for(const action of ['arm','disarm','acknowledge']){el(action).addEventListener('click',async()=>{try{const res=await fetch('/api/live/'+action,{method:'POST',headers:{'X-Bot-UI':'1','Content-Type':'application/json'},body:JSON.stringify({confirmation:el('confirmation').value})});const r=await res.json();el('control').textContent=res.ok?'Action completed':r.error;el('confirmation').value='';}catch(e){el('control').textContent='Action outcome unknown; refresh status before retrying';}refresh();});}
el('analyze').addEventListener('click',async()=>{el('analyze').disabled=true;el('analysis').textContent='Analyzing…';try{const res=await fetch('/api/analyze',{method:'POST',headers:{'X-Bot-UI':'1'}});const r=await res.json();el('analysis').textContent=res.ok?r.text+'\n\nModel: '+r.model+' · Block: '+r.block:r.error;}catch(e){el('analysis').textContent='Analysis request failed';}finally{setTimeout(refresh,1000);}});refresh();setInterval(refresh,10000);`
