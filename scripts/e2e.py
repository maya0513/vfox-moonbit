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
REQUIRED_EXECUTABLES: Final = ("moon", "moonc", "moonfmt", "mooninfo", "moonrun", "moon-lsp")


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
) -> subprocess.CompletedProcess[str]:
    display = " ".join(str(part) for part in command)
    print(f"$ {display}", flush=True)
    result = subprocess.run(  # noqa: S603 - commands are fixed by this integration harness.
        [str(part) for part in command],
        cwd=cwd,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
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
    if formatted.returncode == 0 and output and candidate.is_dir():
        return candidate

    bases = [Path(env["VFOX_HOME"]), Path.home() / ".version-fox", Path.home() / ".vfox"]
    executable = "moon.exe" if os.name == "nt" else "moon"
    matches: list[Path] = []
    for base in bases:
        if base.is_dir():
            matches.extend(path.parent.parent for path in base.rglob(executable) if path.parent.name == "bin")
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
    probe = managed_run(
        prefix,
        [
            sys.executable,
            "-c",
            "import json,os; print(json.dumps({'home': os.environ.get('MOON_HOME'), 'path': os.environ.get('PATH')}))",
        ],
        cwd=workspace,
        env=env,
    )
    values = json.loads(probe.stdout.strip().splitlines()[-1])
    if not isinstance(values.get("home"), str) or Path(values["home"]).resolve() != root.resolve():
        raise E2EError("manager did not export the exact install root as MOON_HOME")
    if not isinstance(values.get("path"), str):
        raise E2EError("manager did not export PATH")
    path_entries = values["path"].split(os.pathsep)
    if not path_entries or Path(path_entries[0]).resolve() != (root / "bin").resolve():
        raise E2EError("manager did not prepend the exact install bin directory to PATH")

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


def vfox_supports_exec(version_output: str) -> bool:
    match = re.search(r"(?:version\s+)?(\d+)\.(\d+)\.(\d+)", version_output)
    return bool(match and int(match.group(1)) >= 1)


def parse_vfox_environment(output: str, root: Path) -> tuple[str, str]:
    try:
        document = json.loads(next(line for line in reversed(output.splitlines()) if line.strip().startswith("{")))
    except (StopIteration, json.JSONDecodeError) as error:
        raise E2EError("vfox env --json did not return a JSON object") from error
    paths = document.get("paths")
    sdks = document.get("sdks")
    if not isinstance(paths, list) or not isinstance(sdks, dict):
        raise E2EError("vfox env --json has an unexpected schema")
    expected_bin = (root / "bin").resolve()
    matching_paths = [value for value in paths if isinstance(value, str) and Path(value).resolve() == expected_bin]
    homes = [
        variables.get("MOON_HOME")
        for variables in sdks.values()
        if isinstance(variables, dict) and isinstance(variables.get("MOON_HOME"), str)
    ]
    matching_homes = [value for value in homes if Path(value).resolve() == root.resolve()]
    if len(matching_paths) != 1 or len(matching_homes) != 1:
        raise E2EError("standalone vfox did not export the exact PATH and MOON_HOME from EnvKeys")
    return matching_paths[0], matching_homes[0]


def run_vfox(plugin: Path, version: str, *, workspace: Path, env: dict[str, str]) -> None:
    if shutil.which("vfox", path=env.get("PATH")) is None:
        raise E2EError("vfox is not available on PATH")
    distribution = workspace / "plugin distribution"
    archive, _, _ = package_plugin.build(plugin, distribution)
    alias = f"moonbit-e2e-{os.getpid()}"
    added = False
    try:
        run(["vfox", "add", "--source", archive, alias], cwd=workspace, env=env)
        added = True
        run(["vfox", "install", "--yes", f"{alias}@latest"], cwd=workspace, env=env)
        root = find_vfox_root(alias, version, cwd=workspace, env=env)
        validate_install(root, version)
        version_output = run(["vfox", "--version"], cwd=workspace, env=env).stdout
        if vfox_supports_exec(version_output):
            prefix = ["vfox", "exec", f"{alias}@{version}", "--"]
        else:
            run(["vfox", "use", "--session", f"{alias}@{version}"], cwd=workspace, env=env)
            environment = run(["vfox", "env", "--json"], cwd=workspace, env=env)
            bin_path, moon_home = parse_vfox_environment(environment.stdout, root)
            env["MOON_HOME"] = moon_home
            env["PATH"] = bin_path + os.pathsep + env["PATH"]
            prefix = []
        validate_commands(prefix, root, version, workspace=workspace, env=env)
    finally:
        if added:
            run(["vfox", "remove", alias], cwd=workspace, env=env, check=False)


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
