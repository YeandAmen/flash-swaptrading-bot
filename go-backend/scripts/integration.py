#!/usr/bin/env python3
"""Run the actual retained FlashArb bytecode on an isolated, unforked Anvil."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
for tool in ("go", "anvil", "solc"):
    if not shutil.which(tool):
        raise SystemExit(f"Install {tool} before running this local integration test")

with tempfile.TemporaryDirectory(prefix="flash-go-integration-") as directory:
    artifacts = Path(directory) / "mocks.json"
    compiled = subprocess.check_output([
        "solc", "--evm-version", "cancun", "--optimize", "--combined-json",
        "abi,bin,bin-runtime", str(root / "testdata/Mocks.sol"),
    ])
    artifacts.write_bytes(compiled)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    endpoint = f"http://127.0.0.1:{port}"
    with (Path(directory) / "anvil.log").open("wb") as log:
        process = subprocess.Popen([
            "anvil", "--host", "127.0.0.1", "--port", str(port),
            "--chain-id", "31337", "--hardfork", "cancun", "--silent",
        ], stdout=log, stderr=log)
        try:
            for attempt in range(100):
                if process.poll() is not None:
                    raise SystemExit("Isolated Anvil failed to start")
                try:
                    request = urllib.request.Request(endpoint, json.dumps({
                        "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": [],
                    }).encode(), {"Content-Type": "application/json"})
                    with urllib.request.urlopen(request, timeout=1) as response:
                        if json.load(response).get("result") != "0x7a69":
                            raise SystemExit("Unexpected local test chain")
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise SystemExit("Isolated Anvil did not become ready")
            env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENROUTER_", "WALLET_")) and k not in ("RPC_URL", "ALLOW_LIVE_TRADING")}
            env.update(ANVIL_TEST_RPC=endpoint, ANVIL_MOCK_ARTIFACTS=str(artifacts))
            subprocess.run([
                "go", "test", "-race", "./internal/evm", "-run", "TestAnvil", "-count=1", "-v",
            ], cwd=root, env=env, check=True)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
