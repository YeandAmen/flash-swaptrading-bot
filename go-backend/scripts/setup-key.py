#!/usr/bin/env python3
"""Prompt locally without echo and save an owner-only, ignored OpenRouter key."""
import getpass
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if not sys.stdin.isatty():
    raise SystemExit("Run this script in a local interactive terminal so the key can be entered without echo")
directory = root / ".secrets"
if directory.is_symlink():
    raise SystemExit("Refusing a symlinked secret directory")
directory.mkdir(mode=0o700, exist_ok=True)
directory.chmod(0o700)
destination = directory / "openrouter.key"
key = getpass.getpass("OpenRouter API key (hidden): ").strip()
if not key or any(character.isspace() for character in key):
    raise SystemExit("Expected a nonempty key without whitespace")
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(key + "\n")
print(f"Saved protected key to {destination}")
print("From go-backend, use: export OPENROUTER_API_KEY_FILE=\"$PWD/.secrets/openrouter.key\"")
