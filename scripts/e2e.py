#!/usr/bin/env python3
"""Run real-download integration tests through mise and/or standalone vfox."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.server
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Final

from scripts import package_plugin

EXACT_VERSION_RE: Final = re.compile(r"^0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\+[0-9A-Za-z][0-9A-Za-z._-]*$")
REQUIRED_EXECUTABLES: Final = ("moon", "moonc", "moonfmt", "mooninfo", "moonrun", "moon-lsp", "moon-ide")
HELPER_EXECUTABLES: Final = ("moon-lsp", "moon-ide")


class E2EError(RuntimeError):
    """An integration invariant failed."""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextlib.contextmanager
def manifest_server(repo: Path) -> Iterator[str]:
    handler = lambda *args, **kwargs: QuietHandler(*args, directory=str(repo), **kwargs)  # noqa: E731
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/releases"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def run(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: int = 600,
    check: bool = True,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    display = " ".join(str(part) for part in command)
    print(f"$ {display}", flush=True)
    try:
        result = subprocess.run(  # noqa: S603 - commands are fixed by this integration harness.
            [str(part) for part in command],
            cwd=cwd,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_text,
        )
    except subprocess.TimeoutExpired as error:
        stdout = (error.stdout or b"").decode("utf-8", errors="replace")
        stderr = (error.stderr or b"").decode("utf-8", errors="replace")
        if stdout:
            print(stdout, end="" if stdout.endswith("\n") else "\n")
        if stderr:
            print(stderr, end="" if stderr.endswith("\n") else "\n", file=sys.stderr)
        raise E2EError(f"command timed out after {timeout} seconds: {display}") from error
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    if check and result.returncode != 0:
        raise E2EError(f"command exited {result.returncode}: {display}")
    return result


def tree_fingerprint(root: Path) -> tuple[tuple[object, ...], ...] | None:
    if not root.exists() and not root.is_symlink():
        return None
    entries: list[tuple[object, ...]] = []
    paths = [root, *sorted(root.rglob("*"), key=lambda path: path.as_posix())]
    for path in paths:
        metadata = path.lstat()
        relative = "." if path == root else path.relative_to(root).as_posix()
        kind = stat.S_IFMT(metadata.st_mode)
        digest_or_target = ""
        if path.is_symlink():
            digest_or_target = str(path.readlink())
        elif path.is_file():
            digest_or_target = hashlib.sha256(path.read_bytes()).hexdigest()
        entries.append((relative, kind, stat.S_IMODE(metadata.st_mode), metadata.st_size, digest_or_target))
    return tuple(entries)


def exact_version(repo: Path) -> str:
    document = json.loads((repo / "releases" / "latest.json").read_text(encoding="utf-8"))
    version = document.get("version")
    if not isinstance(version, str) or not EXACT_VERSION_RE.fullmatch(version):
        raise E2EError("latest.json does not contain a supported exact version")
    return version


def prepare_plugin(repo: Path, destination: Path, manifest_base: str) -> Path:
    plugin = destination / "plugin source with spaces + symbols"
    for source in package_plugin.release_files(repo):
        relative = source.relative_to(repo)
        target = plugin / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    config = plugin / "lib" / "moonbit_config.lua"
    text = config.read_text(encoding="utf-8")
    replaced, count = re.subn(
        r'manifest_base\s*=\s*"[^"]+"',
        f'manifest_base = "{manifest_base}"',
        text,
        count=1,
    )
    if count != 1:
        raise E2EError("could not redirect the plugin manifest endpoint")
    config.write_text(replaced, encoding="utf-8", newline="\n")
    return plugin


def find_vfox_root(alias: str, version: str, *, cwd: Path, env: dict[str, str]) -> Path:
    formatted = run(
        ["vfox", "info", "--format", "{{.Path}}", f"{alias}@{version}"],
        cwd=cwd,
        env=env,
        check=False,
    )
    output = formatted.stdout.strip()
    candidate = Path(output)
    executable = "moon.exe" if os.name == "nt" else "moon"
    search_roots: list[Path] = []
    if formatted.returncode == 0 and output and candidate.is_dir():
        search_roots.append(candidate)

    bases = [Path(env["VFOX_HOME"]), Path.home() / ".version-fox", Path.home() / ".vfox"]
    for base in bases:
        for category in ("cache", "sdks"):
            scoped = base / category / alias
            if scoped not in search_roots:
                search_roots.append(scoped)

    matches: list[Path] = []
    for search_root in search_roots:
        if search_root.is_dir():
            matches.extend(path.parent.parent for path in search_root.rglob(executable) if path.parent.name == "bin")
    matching_versions = [path for path in matches if version in path.as_posix()]
    choices = matching_versions or matches
    unique = sorted({path.resolve() for path in choices})
    if len(unique) != 1:
        raise E2EError(f"cannot identify one vfox install root for {alias}@{version}: {unique}")
    return unique[0]


def assert_within(root: Path, path: Path) -> None:
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise E2EError(f"installed component escapes its root: {path}") from error


def validate_install(root: Path, version: str) -> None:
    suffix = ".exe" if os.name == "nt" else ""
    for name in REQUIRED_EXECUTABLES:
        path = root / "bin" / f"{name}{suffix}"
        if not path.is_file():
            raise E2EError(f"required MoonBit executable is missing: {path}")
        assert_within(root, path)
    if os.name != "nt":
        tcc = root / "bin" / "internal" / "tcc"
        if not tcc.is_file():
            raise E2EError(f"required MoonBit executable is missing: {tcc}")
        assert_within(root, tcc)
    moonx = root / "bin" / f"moonx{suffix}"
    if not moonx.is_file():
        raise E2EError(f"moonx is missing: {moonx}")
    assert_within(root, moonx)
    if os.name != "nt" and (not moonx.is_symlink() or str(moonx.readlink()) != "moon"):
        raise E2EError("moonx must be a relative symlink to moon on Unix")

    shim_suffix = ".cmd" if os.name == "nt" else ""
    for helper in HELPER_EXECUTABLES:
        shim = root / "shims" / f"{helper}{shim_suffix}"
        if not shim.is_file():
            raise E2EError(f"MoonBit helper shim is missing: {shim}")
        assert_within(root, shim)

    moon_mod = root / "lib" / "core" / "moon.mod"
    if not moon_mod.is_file():
        raise E2EError("installed core has no moon.mod")
    assert_within(root, moon_mod)
    match = re.search(r'^\s*version\s*=\s*"([^"]+)"\s*$', moon_mod.read_text(encoding="utf-8"), re.MULTILINE)
    if not match or match.group(1) != version:
        raise E2EError(f"installed core version does not match {version}")
    builtin = root / "lib" / "core" / "builtin" / "moon.pkg"
    if not builtin.is_file():
        raise E2EError(f"installed core is missing its builtin package: {builtin}")
    assert_within(root, builtin)


def managed_run(
    prefix: Sequence[str],
    command: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    return run([*prefix, *command], cwd=cwd, env=env)


def validate_commands(prefix: Sequence[str], root: Path, version: str, *, workspace: Path, env: dict[str, str]) -> None:
    expected_home = Path(env["MOON_HOME"]).resolve()
    probe = managed_run(
        prefix,
        [
            sys.executable,
            "-c",
            "import json,os; print(json.dumps({'home': os.environ.get('MOON_HOME'), "
            "'root': os.environ.get('MOON_TOOLCHAIN_ROOT'), 'path': os.environ.get('PATH')}))",
        ],
        cwd=workspace,
        env=env,
    )
    values = json.loads(probe.stdout.strip().splitlines()[-1])
    if not isinstance(values.get("home"), str) or Path(values["home"]).resolve() != expected_home:
        raise E2EError("manager overwrote the caller's mutable MOON_HOME")
    if not isinstance(values.get("root"), str) or Path(values["root"]).resolve() != root.resolve():
        raise E2EError("manager did not export the exact install root as MOON_TOOLCHAIN_ROOT")
    if not isinstance(values.get("path"), str):
        raise E2EError("manager did not export PATH")
    path_entries = values["path"].split(os.pathsep)
    expected_paths = [(root / "shims").resolve(), (root / "bin").resolve()]
    path_count = len(expected_paths)
    if len(path_entries) < path_count or [Path(path).resolve() for path in path_entries[:path_count]] != expected_paths:
        raise E2EError("manager did not prepend the helper shims and install bin directories in order")

    install_before = tree_fingerprint(root)

    version_result = managed_run(
        prefix,
        ["moon", "version", "--all", "--json", "--no-path"],
        cwd=workspace,
        env=env,
    )
    try:
        version_json = json.loads(version_result.stdout)
    except json.JSONDecodeError as error:
        raise E2EError("moon version did not return JSON") from error
    if version not in json.dumps(version_json, sort_keys=True):
        raise E2EError(f"moon version output does not contain resolved version {version}")

    project = workspace / "fixture project"
    managed_run(
        prefix,
        ["moon", "new", "--user", "vfox-e2e", "--name", "smoke", str(project)],
        cwd=workspace,
        env=env,
    )
    managed_run(prefix, ["moon", "check"], cwd=project, env=env)
    managed_run(prefix, ["moon", "test"], cwd=project, env=env)
    managed_run(prefix, ["moon", "run", "cmd/main"], cwd=project, env=env)
    # moonx selects package-runner behaviour from argv[0]; it is not a second
    # spelling of the `moon` CLI, so `moonx version` is intentionally invalid.
    moonx_help = managed_run(prefix, ["moonx", "--help"], cwd=project, env=env)
    if "package" not in (moonx_help.stdout + moonx_help.stderr).lower():
        raise E2EError("moonx did not identify itself as the package runner")
    managed_run(prefix, ["moon", "lsp", "--version"], cwd=project, env=env)
    managed_run(prefix, ["moon", "ide", "--help"], cwd=project, env=env)
    if tree_fingerprint(root) != install_before:
        raise E2EError("MoonBit commands modified the managed installation root")


def run_mise(plugin: Path, version: str, *, workspace: Path, env: dict[str, str]) -> None:
    if shutil.which("mise", path=env.get("PATH")) is None:
        raise E2EError("mise is not available on PATH")
    run(["mise", "--no-config", "--yes", "plugins", "link", "--force", "moonbit", plugin], cwd=workspace, env=env)
    run(["mise", "--no-config", "--yes", "install", "moonbit@latest"], cwd=workspace, env=env)
    latest = run(["mise", "--no-config", "latest", "moonbit"], cwd=workspace, env=env).stdout.strip()
    if latest != version:
        raise E2EError(f"mise latest resolved to {latest!r}, expected {version!r}")
    root = Path(run(["mise", "--no-config", "where", f"moonbit@{version}"], cwd=workspace, env=env).stdout.strip())
    validate_install(root, version)
    validate_commands(
        ["mise", "--no-config", "exec", f"moonbit@{version}", "--"],
        root,
        version,
        workspace=workspace,
        env=env,
    )


def run_vfox(plugin: Path, version: str, *, workspace: Path, env: dict[str, str]) -> None:
    if shutil.which("vfox", path=env.get("PATH")) is None:
        raise E2EError("vfox is not available on PATH")
    distribution = workspace / "plugin distribution"
    archive, _, _ = package_plugin.build(plugin, distribution)
    alias = f"moonbit-e2e-{os.getpid()}"
    vfox_home = Path(env["VFOX_HOME"])
    (vfox_home / "plugin").mkdir(parents=True, exist_ok=True)
    run(["vfox", "--version"], cwd=workspace, env=env)
    added = False
    primary_failed = False
    try:
        run(["vfox", "add", "--source", archive, alias], cwd=workspace, env=env)
        added = True
        run(["vfox", "install", "--yes", f"{alias}@latest"], cwd=workspace, env=env, timeout=300)
        root = find_vfox_root(alias, version, cwd=workspace, env=env)
        validate_install(root, version)
        prefix = ["vfox", "exec", f"{alias}@{version}", "--"]
        validate_commands(prefix, root, version, workspace=workspace, env=env)
    except BaseException:
        primary_failed = True
        raise
    finally:
        if added:
            try:
                run(["vfox", "remove", "--yes", alias], cwd=workspace, env=env, timeout=30)
            except (E2EError, OSError, subprocess.SubprocessError) as cleanup_error:
                if not primary_failed:
                    raise
                print(f"warning: vfox cleanup failed after the primary E2E failure: {cleanup_error}", file=sys.stderr)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--backend", choices=("mise", "vfox", "all"), default="mise")
    parser.add_argument(
        "--allow-vfox-user-state",
        action="store_true",
        help="allow standalone vfox to use its normal manager state (safe on ephemeral CI runners)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.backend in {"vfox", "all"} and not (args.allow_vfox_user_state or os.environ.get("CI") == "true"):
        print("standalone vfox E2E is disabled locally; pass --allow-vfox-user-state to opt in", file=sys.stderr)
        return 2

    repo = args.repo.resolve()
    version = exact_version(repo)
    moon_home = Path.home() / ".moon"
    before = tree_fingerprint(moon_home)
    failure: str | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="vfox-moonbit-e2e-") as temporary, manifest_server(repo) as base_url:
            base = Path(temporary)
            workspace = base / "workspace with spaces + symbols"
            workspace.mkdir()
            plugin = prepare_plugin(repo, base, base_url)
            env = os.environ.copy()
            env.update(
                {
                    "MISE_DATA_DIR": str(base / "mise data + symbols"),
                    "MISE_CACHE_DIR": str(base / "mise cache + symbols"),
                    "MISE_STATE_DIR": str(base / "mise state + symbols"),
                    "MISE_NO_UPDATE_CHECK": "1",
                    "VFOX_HOME": str(base / "vfox home + symbols"),
                    "MOON_HOME": str(base / "moon user state + symbols"),
                }
            )
            if args.backend in {"mise", "all"}:
                run_mise(plugin, version, workspace=workspace, env=env.copy())
            if args.backend in {"vfox", "all"}:
                run_vfox(plugin, version, workspace=workspace, env=env.copy())
    except (E2EError, OSError, subprocess.SubprocessError, package_plugin.PackageError, json.JSONDecodeError) as error:
        failure = str(error)
    after = tree_fingerprint(moon_home)
    if after != before:
        failure = "~/.moon was created or modified"
    if failure is not None:
        print(f"E2E failed: {failure}", file=sys.stderr)
        return 1
    print(f"MoonBit {version} E2E passed through {args.backend}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
