from __future__ import annotations

import contextlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from scripts import e2e

REPO = Path(__file__).resolve().parents[2]


def test_exact_version(tmp_path):
    assert e2e.exact_version(REPO).startswith("0.")
    (tmp_path / "releases").mkdir()
    (tmp_path / "releases" / "latest.json").write_text(json.dumps({"version": "latest"}), encoding="utf-8")
    with pytest.raises(e2e.E2EError, match="supported exact"):
        e2e.exact_version(tmp_path)


def test_find_vfox_root_normalizes_the_version_container(tmp_path, monkeypatch):
    version = "0.1.2+abc"
    container = tmp_path / "vfox" / "cache" / "moonbit-e2e-123" / f"v-{version}"
    root = container / f"moonbit-{version}"
    (root / "bin").mkdir(parents=True)
    executable = "moon.exe" if os.name == "nt" else "moon"
    (root / "bin" / executable).write_bytes(b"moon")

    monkeypatch.setattr(
        e2e,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess([], 0, stdout=str(container) + "\n", stderr=""),
    )
    found = e2e.find_vfox_root(
        "moonbit-e2e-123",
        version,
        cwd=tmp_path,
        env={"VFOX_HOME": str(tmp_path / "vfox")},
    )
    assert found == root.resolve()


def test_manifest_server_and_prepare_plugin(tmp_path, monkeypatch):
    class FakeServer:
        server_port = 12345

        def __init__(self, address, handler):
            assert address == ("127.0.0.1", 0)
            assert callable(handler)

        def serve_forever(self):
            return None

        def shutdown(self):
            return None

        def server_close(self):
            return None

    monkeypatch.setattr(e2e.http.server, "ThreadingHTTPServer", FakeServer)
    with e2e.manifest_server(REPO) as base:
        plugin = e2e.prepare_plugin(REPO, tmp_path, base)
    assert base == "http://127.0.0.1:12345/releases"
    assert base in (plugin / "lib" / "moonbit_config.lua").read_text(encoding="utf-8")
    assert (plugin / "lib" / "sha2.lua").is_file()


def test_prepare_plugin_requires_manifest_setting(tmp_path, monkeypatch):
    fake_repo = tmp_path / "repo"
    (fake_repo / "lib").mkdir(parents=True)
    fake_config = fake_repo / "lib" / "moonbit_config.lua"
    fake_config.write_text("return {}", encoding="utf-8")
    monkeypatch.setattr(e2e.package_plugin, "release_files", lambda _repo: [fake_config])
    with pytest.raises(e2e.E2EError, match="redirect"):
        e2e.prepare_plugin(fake_repo, tmp_path / "out", "http://127.0.0.1")


def test_tree_fingerprint_tracks_files_and_links(tmp_path):
    missing = tmp_path / "missing"
    assert e2e.tree_fingerprint(missing) is None
    root = tmp_path / "tree"
    root.mkdir()
    (root / "file").write_bytes(b"one")
    with contextlib.suppress(OSError):
        (root / "link").symlink_to("file")
    before = e2e.tree_fingerprint(root)
    (root / "file").write_bytes(b"two")
    assert e2e.tree_fingerprint(root) != before


def test_assert_within_and_cli_local_vfox_guard(tmp_path, monkeypatch, capsys):
    root = tmp_path / "root"
    root.mkdir()
    child = root / "child"
    child.write_text("ok", encoding="utf-8")
    e2e.assert_within(root, child)
    with pytest.raises(e2e.E2EError, match="escapes"):
        e2e.assert_within(root, tmp_path / "missing")
    monkeypatch.delenv("CI", raising=False)
    assert e2e.main(["--repo", str(REPO), "--backend", "vfox"]) == 2
    assert "disabled locally" in capsys.readouterr().err


def test_validate_install_checks_toolchain_core_and_containment(tmp_path):
    version = "0.1.2+abc"
    root = tmp_path / "install root"
    (root / "bin" / "internal").mkdir(parents=True)
    for name in e2e.REQUIRED_EXECUTABLES:
        (root / "bin" / name).write_bytes(name.encode())
    (root / "shims").mkdir()
    for name in e2e.HELPER_EXECUTABLES:
        (root / "shims" / name).write_bytes(name.encode())
    (root / "bin" / "internal" / "tcc").write_bytes(b"tcc")
    (root / "bin" / "moonx").symlink_to("moon")
    (root / "lib" / "core" / "builtin").mkdir(parents=True)
    (root / "lib" / "core" / "moon.mod").write_text(f'version = "{version}"\n', encoding="utf-8")
    builtin = root / "lib" / "core" / "builtin" / "moon.pkg"
    builtin.write_bytes(b"builtin")

    e2e.validate_install(root, version)
    builtin.unlink()
    with pytest.raises(e2e.E2EError, match="builtin package"):
        e2e.validate_install(root, version)

    builtin.write_bytes(b"builtin")
    (root / "bin" / "internal" / "tcc").unlink()
    with pytest.raises(e2e.E2EError, match="required MoonBit executable"):
        e2e.validate_install(root, version)


def test_run_reports_success_and_failure(tmp_path):
    env = os.environ.copy()
    success = e2e.run(
        [os.fspath(Path(os.sys.executable)), "-c", "print(input())"],
        cwd=tmp_path,
        env=env,
        input_text="ok\n",
    )
    assert success.stdout == "ok\n"
    with pytest.raises(e2e.E2EError, match="exited 3"):
        e2e.run([os.fspath(Path(os.sys.executable)), "-c", "raise SystemExit(3)"], cwd=tmp_path, env=env)


def test_run_preserves_timeout_output(tmp_path, monkeypatch, capsys):
    def time_out(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(
            ["tool", "--flag"],
            7,
            output=b"partial stdout\n",
            stderr=b"partial stderr",
        )

    monkeypatch.setattr(e2e.subprocess, "run", time_out)
    with pytest.raises(e2e.E2EError, match=r"timed out after 7 seconds: tool --flag"):
        e2e.run(["tool", "--flag"], cwd=tmp_path, env={"PATH": os.environ.get("PATH", "")}, timeout=7)
    captured = capsys.readouterr()
    assert captured.out == "$ tool --flag\npartial stdout\n"
    assert captured.err == "partial stderr\n"

    def time_out_without_output(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(["tool"], 3)

    monkeypatch.setattr(e2e.subprocess, "run", time_out_without_output)
    with pytest.raises(e2e.E2EError, match=r"timed out after 3 seconds: tool"):
        e2e.run(["tool"], cwd=tmp_path, env={}, timeout=3)
