#!/usr/bin/env python3
"""Save an existing keystore password for a local service, without terminal echo."""
import argparse
import getpass
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True, help="new owner-only password file")
args = parser.parse_args()
if not sys.stdin.isatty():
    raise SystemExit("Run in a local interactive terminal")
destination = Path(args.out).expanduser().absolute()
directory = destination.parent
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
if directory.is_symlink() or directory.stat().st_mode & 0o077:
    raise SystemExit("Password directory must be private (chmod 700)")
password = getpass.getpass("Existing encrypted-wallet password (hidden): ")
if not password or "\n" in password or "\r" in password:
    raise SystemExit("Expected a nonempty single-line password")
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as stream:
    stream.write(password + "\n")
    stream.flush()
    os.fsync(stream.fileno())
print(f"Saved owner-only password file: {destination}")
print("This file contains the password in plaintext. Protect it as a credential.")
