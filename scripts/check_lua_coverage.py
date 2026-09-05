#!/usr/bin/env python3
"""Enforce the aggregate and per-file LuaCov line-coverage threshold."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

ROW = re.compile(
    r"^(?P<file>(?:hooks|lib)/\S+\.lua|metadata\.lua)\s+(?P<hits>\d+)\s+(?P<miss>\d+)\s+(?P<coverage>[\d.]+)%$"
)
EXPECTED = {
    "hooks/available.lua",
    "hooks/env_keys.lua",
    "hooks/post_install.lua",
    "hooks/pre_install.lua",
    "lib/moonbit_config.lua",
    "lib/moonbit_installer.lua",
    "lib/moonbit_manifest.lua",
    "lib/moonbit_runtime.lua",
    "lib/moonbit_sha256.lua",
}


def parse_report(report: str) -> dict[str, float]:
    results: dict[str, float] = {}
    for line in report.splitlines():
        match = ROW.match(line.strip())
        if match:
            results[match.group("file")] = float(match.group("coverage"))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minimum", type=float, default=95.0)
    parser.add_argument("--report", type=Path, default=Path("luacov.report.out"))
    args = parser.parse_args()
    rows = parse_report(args.report.read_text(encoding="utf-8"))
    missing = EXPECTED - rows.keys()
    if missing:
        raise SystemExit("LuaCov report is missing first-party files: " + ", ".join(sorted(missing)))
    failures = {name: value for name, value in rows.items() if value < args.minimum}
    if failures:
        details = ", ".join(f"{name}={value:.2f}%" for name, value in sorted(failures.items()))
        raise SystemExit(f"Lua line coverage is below {args.minimum:.2f}%: {details}")
    print("Lua line coverage: " + ", ".join(f"{name}={value:.2f}%" for name, value in sorted(rows.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
