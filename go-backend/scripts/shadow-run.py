#!/usr/bin/env python3
"""Bounded real-mainnet observation; never loads a wallet or sends transactions."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--samples", type=int, default=8)
parser.add_argument("--period", type=float, default=12)
parser.add_argument("--extended", action="store_true")
parser.add_argument("--report", type=Path, default=Path("data/shadow-report.json"))
args = parser.parse_args()
if not 1 <= args.samples <= 10000 or args.period < 1:
    raise SystemExit("Expected 1..10000 samples and a period of at least 1s")
root = Path(__file__).resolve().parents[1]
rpc = os.environ.get("SHADOW_RPC_URL", "https://ethereum-rpc.publicnode.com")
env = {k: v for k, v in os.environ.items() if not k.startswith((
    "WALLET_", "OPENROUTER_", "FLASH_ARB_", "ANVIL_", "FORK_", "LIVE_"
)) and k not in ("RPC_URL", "SEND_RPC_URL", "ALLOW_LIVE_TRADING")}
env.update(RPC_URL=rpc, ALLOW_LIVE_TRADING="off")
if args.extended:
    core = (root.parent / "src/config.ts").read_text().split("export const CORE_TOKENS", 1)[1].split("];", 1)[0]
    tokens = ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"] + re.findall(r"address: a\('([^']+)'\)", core)
    if len(tokens) != 6:
        raise SystemExit("Cannot validate the six-token universe")
    env["SCAN_TOKENS"] = ",".join(tokens)
    env["LOAN_SIZES_WEI"] = ",".join(str(n) for n in (
        10**15, 3*10**15, 10**16, 3*10**16, 10**17, 3*10**17, 10**18, 3*10**18, 10**19))


def finish_head():
    request = urllib.request.Request(rpc, json.dumps({"jsonrpc": "2.0", "id": 1,
        "method": "eth_blockNumber", "params": []}).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return int(json.load(response)["result"], 16)
    except Exception:
        return None


started = datetime.now(timezone.utc)
samples = []
with tempfile.TemporaryDirectory(prefix="flash-shadow-") as directory:
    binary = Path(directory) / "bot"
    shutil.copy2(root / "bin/bot", binary)
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    next_start = time.monotonic()
    for index in range(args.samples):
        delay = next_start-time.monotonic()
        if delay > 0:
            time.sleep(delay)
        began = time.monotonic()
        try:
            process = subprocess.run([str(binary), "--once"], cwd=root, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=65)
            if process.returncode:
                raise RuntimeError("scan_failed")
            report = json.loads(process.stdout)
            if report.get("mode") != "paper" or report.get("chain_id") != 1:
                raise RuntimeError("unexpected_mode_or_chain")
            elapsed = time.monotonic()-began
            head = finish_head()
            sample = {"index": index, "ok": True, "process_seconds": round(elapsed, 3),
                "head_at_finish": head, "head_advanced_during_scan": head is not None and head > report["block"], "report": report}
            print(f"Sample {index+1}/{args.samples}: block={report['block']} pools={report['pools']} "
                  f"quotes={report.get('quotes_evaluated', 0)} candidates={len(report['candidates'])} "
                  f"warnings={len(report['warnings'])} elapsed={elapsed:.2f}s", flush=True)
        except Exception:
            sample = {"index": index, "ok": False, "process_seconds": round(time.monotonic()-began, 3),
                "error": "Scan failed or timed out; endpoint details redacted"}
            print(f"Sample {index+1}/{args.samples}: scan failed or timed out", flush=True)
        samples.append(sample)
        next_start = max(next_start+args.period, began+args.period)

success = [s for s in samples if s["ok"]]
blocks = sorted({s["report"]["block"] for s in success})
best = max((s["report"]["best_quote"] for s in success if s["report"].get("best_quote")),
           key=lambda q: int(q["conservative_net_wei"]), default=None)
gross = max((s["report"]["best_gross_quote"] for s in success if s["report"].get("best_gross_quote")),
            key=lambda q: int(q["estimated_gross_wei"])-int(q["gas_budget_wei"]), default=None)
summary = {"started_at": started.isoformat(), "ended_at": datetime.now(timezone.utc).isoformat(),
    "samples_requested": args.samples, "samples_succeeded": len(success), "samples_failed": args.samples-len(success),
    "unique_blocks": blocks, "distinct_blocks_count": len(blocks),
    "min_pools": min((s["report"]["pools"] for s in success), default=0),
    "max_pools": max((s["report"]["pools"] for s in success), default=0),
    "quote_evaluations": sum(s["report"].get("quotes_evaluated", 0) for s in success),
    "qualifying_quote_count": sum(len(s["report"]["candidates"]) for s in success),
    "warnings_count": sum(len(s["report"]["warnings"]) for s in success),
    "scans_with_head_advanced_at_finish": sum(s["head_advanced_during_scan"] for s in success),
    "average_process_seconds": round(sum(s["process_seconds"] for s in success)/len(success), 3) if success else None,
    "best_conservative_quote": best, "best_unbuffered_quote": gross,
    "best_unbuffered_net_wei": str(int(gross["estimated_gross_wei"])-int(gross["gas_budget_wei"])) if gross else None,
    "live_transactions_sent": 0, "wallet_loaded": False, "model_calls": 0,
    "extended_universe": args.extended, "tested_loan_sizes_wei": env.get("LOAN_SIZES_WEI", "defaults"),
    "binary_sha256": digest, "limitations": ["Short observation window; no profitability claim follows from these quotes.",
        "Qualifying quotes still require full executor simulation and actual inclusion.", "Only supported Ethereum V2 venues were scanned."]}
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps({"summary": summary, "samples": samples}, indent=2)+"\n")
print(json.dumps(summary, indent=2), flush=True)
