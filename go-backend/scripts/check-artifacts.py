#!/usr/bin/env python3
"""Verify Go embeds exactly the retained TypeScript compiler artifacts."""
import json
from pathlib import Path
import re

root = Path(__file__).resolve().parents[2]
for name in ("proxy", "logic-v4"):
    source = (root / f"src/mev/artifact-{name}.ts").read_text()
    retained = {
        "abi": json.loads(source.split("_ABI = ", 1)[1].split(" as const;", 1)[0]),
        "runtime": re.search(r"_RUNTIME = '(0x[0-9a-fA-F]+)'", source)[1],
        "bytecode": re.search(r"_BYTECODE = '(0x[0-9a-fA-F]+)'", source)[1],
    }
    actual = json.loads((root / f"go-backend/artifacts/{name}.json").read_text())
    if actual != retained:
        raise SystemExit(f"Artifact mismatch: {name}")
    print(f"Verified retained {name} ABI, creation bytecode and runtime")
