#!/usr/bin/env python3
"""Probe rapid input followed by Save in an isolated Linux/WSL GUI profile.

Usage: python3 linux-save-order-probe.py MASTER_BINARY BRANCH_BINARY AUDIT_ROOT
AUDIT_ROOT must already contain profile/{config,data,cache} and tmp directories.
All generated documents and logs remain under AUDIT_ROOT. Run on a dedicated
display: xdotool focuses the launched windows and injects real X11 events.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

master, branch, root = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]).resolve()
if not (root.name.startswith("mdraft-preview-hardening-") and root.parent == Path("/tmp")):
    raise SystemExit("Use the dedicated /tmp/mdraft-preview-hardening-* audit directory")
line = b"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima "
original = (line * 2 + b"\r\n\r\n") * 72_000
if not all((root / name).is_dir() for name in ("profile/config", "profile/data", "profile/cache", "tmp")):
    raise SystemExit("Create the dedicated profile/{config,data,cache} and tmp directories first")

env = os.environ.copy()
env.update(
    DISPLAY=":0",
    GDK_BACKEND="x11",
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS="1",
    WEBKIT_DISABLE_COMPOSITING_MODE="1",
    XDG_CONFIG_HOME=str(root / "profile/config"),
    XDG_DATA_HOME=str(root / "profile/data"),
    XDG_CACHE_HOME=str(root / "profile/cache"),
    TMPDIR=str(root / "tmp"),
)


def xdo(*arguments, timeout=10, check=True):
    return subprocess.run(
        ["xdotool", *map(str, arguments)],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=check,
    ).stdout.strip()


def window_for(pid, name):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        result = xdo("search", "--onlyvisible", "--pid", pid, check=False)
        for candidate in result.splitlines():
            if name in xdo("getwindowname", candidate, check=False):
                return candidate
        time.sleep(0.2)
    raise RuntimeError(f"No matching window for owned process {pid}")


def run(binary, label, number):
    marker = b"LINUXCRLFCHECK"
    path = root / f"save-order-{label}-{number}.md"
    path.write_bytes(original)
    logfile = root / f"save-order-{label}-{number}.log"
    with logfile.open("wb") as log:
        process = subprocess.Popen([str(binary), str(path)], env=env, stdout=log, stderr=log)
        window = None
        try:
            window = window_for(process.pid, path.name)
            if int(xdo("getwindowpid", window)) != process.pid:
                raise RuntimeError("The window does not belong to the launched process")
            xdo("windowactivate", "--sync", window)
            # Let loading begin, then inject the same burst and save in order.
            time.sleep(3)
            xdo("key", "--clearmodifiers", "ctrl+Home")
            xdo("type", "--clearmodifiers", "--delay", "0", marker.decode("ascii"))
            xdo("key", "--clearmodifiers", "ctrl+s")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and path.stat().st_size == len(original):
                time.sleep(0.1)
            first = path.read_bytes()
            first_title = xdo("getwindowname", window, check=False)
            # Wait for the remaining GUI events before the second, confirming save.
            time.sleep(5)
            xdo("key", "--clearmodifiers", "ctrl+s")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                saved = path.read_bytes()
                if saved.startswith(marker) and len(saved) == len(original) + len(marker):
                    break
                time.sleep(0.2)
            saved = path.read_bytes()
            result = {
                "version": label,
                "run": number,
                "first_saved_prefix": first[: len(marker)].decode("ascii", errors="replace"),
                "first_size": len(first),
                "first_title": first_title,
                "final_has_marker": saved.startswith(marker),
                "final_size": len(saved),
                "final_crlf": saved.count(b"\r\n"),
            }
            print(json.dumps(result), flush=True)
            return result
        finally:
            if process.poll() is None:
                if window is not None:
                    xdo("windowclose", window, check=False)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=12)


results = []
for number in range(1, 3):
    for label, binary in (("master", master), ("branch", branch)):
        results.append(run(binary, label, number))
out = root / "linux-save-order-results.json"
out.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
if not all(item["final_has_marker"] and item["final_crlf"] == 144_000 for item in results):
    raise SystemExit("The confirming save did not preserve the expected fixture")
