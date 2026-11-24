#!/usr/bin/env python3
"""Replay real Ethereum state locally. Upstream traffic is read-only by construction."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--block", type=int, help="pinned Ethereum block; default: latest")
parser.add_argument("--report", type=Path, default=Path("data/mainnet-fork-report.json"))
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
upstream = os.environ.get("FORK_RPC_URL", "https://ethereum-rpc.publicnode.com")
parsed = urllib.parse.urlsplit(upstream)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
    raise SystemExit("FORK_RPC_URL must be an HTTPS Ethereum read endpoint")
for tool in ("go", "anvil"):
    if not shutil.which(tool):
        raise SystemExit(f"Install {tool} before running the real-state test")

allowed = {
    "eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber",
    "eth_getBlockByHash", "eth_getCode", "eth_getBalance", "eth_getStorageAt",
    "eth_getTransactionCount", "eth_getProof", "eth_call", "eth_getAccountInfo",
    "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs",
    "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas",
}
counts = {}
counts_lock = threading.Lock()


def upstream_call(payload):
    request = urllib.request.Request(upstream, json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
    # Do not follow redirects with a potentially credential-bearing URL/body.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *unused):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            body = response.read(10_000_001)
        if len(body) > 10_000_000:
            raise ValueError()
        return json.loads(body)
    except Exception:
        raise RuntimeError("Ethereum read RPC failed; endpoint details redacted") from None


def call(url, method, params, timeout=20):
    request = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1,
        "method": method, "params": params}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if "error" in value or "result" not in value:
        raise RuntimeError("RPC method failed: " + method)
    return value["result"]


class ReadOnlyProxy(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_POST(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1_000_000:
                raise ValueError()
            payload = json.loads(self.rfile.read(size))
            batch = payload if isinstance(payload, list) else [payload]
            if not batch or len(batch) > 512 or any(
                not isinstance(item, dict) or item.get("method") not in allowed for item in batch
            ):
                self.send_error(403, "Only explicitly allowed Ethereum read methods may reach upstream")
                return
            with counts_lock:
                for item in batch:
                    method = item["method"]
                    counts[method] = counts.get(method, 0) + 1
            body = json.dumps(upstream_call(payload)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            self.send_error(502, "Upstream read failed; private endpoint details redacted")


proxy = ThreadingHTTPServer(("127.0.0.1", 0), ReadOnlyProxy)
proxy.daemon_threads = True
thread = threading.Thread(target=proxy.serve_forever, daemon=True)
thread.start()
proxy_url = f"http://127.0.0.1:{proxy.server_port}"

try:
    if call(proxy_url, "eth_chainId", []) != "0x1":
        raise SystemExit("Upstream must be Ethereum mainnet")
    block = call(proxy_url, "eth_getBlockByNumber", [hex(args.block) if args.block else "latest", False])
    if not block or int(block["number"], 16) == 0:
        raise SystemExit("Cannot pin an Ethereum block")
    number = int(block["number"], 16)
    print(f"Pinned actual Ethereum block {number} ({block['hash']})", flush=True)
    # Verify the guard really rejects all upstream broadcast attempts.
    try:
        call(proxy_url, "eth_sendRawTransaction", ["0x"])
    except urllib.error.HTTPError as error:
        if error.code != 403:
            raise SystemExit("Read-only proxy guard failed")
    else:
        raise SystemExit("Read-only proxy allowed a forbidden method")

    with tempfile.TemporaryDirectory(prefix="flash-real-state-") as directory:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}"
        result_file = Path(directory) / "result.json"
        with (Path(directory) / "anvil.log").open("wb") as log:
            process = subprocess.Popen([
                "anvil", "--host", "127.0.0.1", "--port", str(port), "--chain-id", "31337",
                "--hardfork", "cancun", "--fork-url", proxy_url,
                "--fork-block-number", str(number), "--silent",
            ], stdout=log, stderr=log)
            try:
                for attempt in range(90):
                    if process.poll() is not None:
                        raise SystemExit("Anvil could not initialize the real-state fork")
                    try:
                        if call(endpoint, "eth_chainId", [], timeout=1) != "0x7a69":
                            raise SystemExit("Unexpected local fork chain ID")
                        break
                    except (OSError, TimeoutError):
                        time.sleep(0.5)
                else:
                    raise SystemExit("Mainnet fork did not become ready")
                env = {k: v for k, v in os.environ.items() if not k.startswith(
                    ("WALLET_", "OPENROUTER_", "FORK_", "ANVIL_", "MAINNET_FORK_")
                ) and k not in ("RPC_URL", "SEND_RPC_URL", "ALLOW_LIVE_TRADING")}
                env.update(MAINNET_FORK_RPC=endpoint, MAINNET_FORK_BLOCK=str(number),
                    MAINNET_FORK_HASH=block["hash"], MAINNET_FORK_REPORT=str(result_file))
                subprocess.run(["go", "test", "-race", "./internal/live", "-run",
                    "^TestMainnetForkRealPools$", "-count=1", "-timeout", "8m", "-v"],
                    cwd=root, env=env, check=True)
                result = json.loads(result_file.read_text())
                with counts_lock:
                    result["upstream_read_counts"] = dict(sorted(counts.items()))
                result["upstream_broadcasts_allowed"] = False
                result["upstream_broadcasts_sent"] = 0
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(result, indent=2) + "\n")
                print(f"Real-state results saved to {args.report.resolve()}", flush=True)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
finally:
    proxy.shutdown()
    proxy.server_close()
