from __future__ import annotations

import sys

import pytest

from scripts import check_lua_coverage
from scripts.check_lua_coverage import EXPECTED, parse_report


def test_parse_luacov_report():
    report = """
File                         Hits Missed Coverage
------------------------------------------------
hooks/available.lua             4      0  100.00%
lib/moonbit_runtime.lua        95      5   95.00%
tests/lua/example.lua          10      0  100.00%
Total                         109      5   95.61%
"""
    assert parse_report(report) == {"hooks/available.lua": 100.0, "lib/moonbit_runtime.lua": 95.0}


def report_for_expected(coverage: float = 100.0) -> str:
    return "\n".join(f"{name} 10 0 {coverage:.2f}%" for name in sorted(EXPECTED))


def test_lua_coverage_main_accepts_complete_report(tmp_path, monkeypatch, capsys):
    report = tmp_path / "report.out"
    report.write_text(report_for_expected(), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["check_lua_coverage.py", "--report", str(report), "--minimum", "95"])
    assert check_lua_coverage.main() == 0
    assert "Lua line coverage" in capsys.readouterr().out


def test_lua_coverage_main_rejects_missing_and_low_files(tmp_path, monkeypatch):
    report = tmp_path / "report.out"
    report.write_text("hooks/available.lua 10 0 100.00%\n", encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["check_lua_coverage.py", "--report", str(report)])
    with pytest.raises(SystemExit, match="missing first-party"):
        check_lua_coverage.main()

    report.write_text(report_for_expected(94.0), encoding="utf-8")
    with pytest.raises(SystemExit, match="below 95.00%"):
        check_lua_coverage.main()
