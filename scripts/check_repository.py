#!/usr/bin/env python3
"""Validate repository ownership, supply-chain policy, and workflow pinning."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path
from typing import Final

from scripts import package_plugin, update_latest

OWNER: Final = "maya0513"
REPOSITORY: Final = "vfox-moonbit"
EXPECTED_REPOSITORY: Final = f"{OWNER}/{REPOSITORY}"
ACTION_RE: Final = re.compile(r"^\s*(?:-\s+)?uses:\s*([^\s#]+)", re.MULTILINE)
PINNED_ACTION_RE: Final = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}$")
REMOTE_RE: Final = re.compile(r"^(?:https://github\.com/|git@github\.com:)(?P<slug>[^/]+/[^/]+?)(?:\.git)?$")


class RepositoryError(RuntimeError):
    """A checked-in repository invariant was violated."""


def check_owner(repo: Path) -> None:
    metadata = package_plugin.parse_metadata(repo / "metadata.lua")
    homepage = f"https://github.com/{EXPECTED_REPOSITORY}"
    if metadata["homepage"] != homepage:
        raise RepositoryError(f"metadata homepage must be {homepage}")
    if metadata["license"] != "Apache-2.0":
        raise RepositoryError("metadata license must use the Apache-2.0 SPDX identifier")
    if metadata["manifestUrl"] != f"{homepage}/releases/download/manifest/manifest.json":
        raise RepositoryError("metadata manifestUrl does not use the canonical repository")
    config = (repo / "lib" / "moonbit_config.lua").read_text(encoding="utf-8")
    required = (
        f'owner = "{OWNER}"',
        f'repository = "{REPOSITORY}"',
        f"https://raw.githubusercontent.com/{EXPECTED_REPOSITORY}/main/releases",
    )
    if any(value not in config for value in required):
        raise RepositoryError("moonbit_config.lua contains an unresolved or inconsistent repository owner")
    excluded = {
        ".agents",
        ".codex",
        ".direnv",
        ".git",
        ".mise",
        ".pytest_cache",
        ".rocks",
        ".ruff_cache",
        ".venv",
        ".version-fox",
        ".vfox",
        "__pycache__",
        "build",
        "dist",
        "htmlcov",
        "target",
    }
    text_suffixes = {"", ".json", ".lua", ".md", ".py", ".sh", ".toml", ".yml", ".yaml"}
    candidates = [
        path
        for path in repo.rglob("*")
        if path.is_file() and not excluded.intersection(path.parts) and path.suffix in text_suffixes
    ]
    placeholders = ("<" + "owner>", "YOUR" + "_OWNER", "your" + "-owner", "username/" + REPOSITORY)
    for placeholder in placeholders:
        for path in candidates:
            if placeholder in path.read_text(encoding="utf-8", errors="ignore"):
                raise RepositoryError(f"unresolved owner placeholder in {path.relative_to(repo)}")


def check_release_policy(repo: Path) -> None:
    update_latest.validate_local(repo)
    release_dir = repo / "releases"
    unexpected = sorted(path.name for path in release_dir.iterdir() if not path.is_file() or path.suffix != ".json")
    if unexpected:
        raise RepositoryError("releases/ may contain JSON manifests only: " + ", ".join(unexpected))
    for path in release_dir.iterdir():
        if path.stat().st_size > 1024 * 1024:
            raise RepositoryError(f"release manifest exceeds 1 MiB: {path.name}")


def check_plugin_code(repo: Path) -> None:
    code_paths = [
        repo / "metadata.lua",
        *sorted((repo / "hooks").glob("*.lua")),
        *sorted((repo / "lib").glob("moonbit_*.lua")),
    ]
    combined = "\n".join(path.read_text(encoding="utf-8") for path in code_paths)
    if re.search(r"\baddition\s*=", combined):
        raise RepositoryError("vfox addition archives are forbidden; core must be installed transactionally")
    runtime_code = "\n".join(path.read_text(encoding="utf-8") for path in code_paths if path.name != "metadata.lua")
    if re.search(r"\bmoonup\b", runtime_code, re.IGNORECASE):
        raise RepositoryError("plugin runtime must not invoke or depend on moonup")
    if re.search(r"moon\s+upgrade", runtime_code, re.IGNORECASE):
        raise RepositoryError("plugin runtime must not invoke moon upgrade")


def check_actions(repo: Path) -> None:
    workflows = sorted((repo / ".github" / "workflows").glob("*.y*ml"))
    if not workflows:
        raise RepositoryError("no GitHub Actions workflows are present")
    for path in workflows:
        text = path.read_text(encoding="utf-8")
        for reference in ACTION_RE.findall(text):
            if reference.startswith("./"):
                continue
            if not PINNED_ACTION_RE.fullmatch(reference):
                raise RepositoryError(f"GitHub Action is not pinned to a full commit SHA in {path.name}: {reference}")


def origin_slug(repo: Path) -> str | None:
    result = subprocess.run(
        ["git", "config", "--get", "remote.origin.url"],  # noqa: S607 - fixed read-only git invocation.
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    match = REMOTE_RE.fullmatch(result.stdout.strip())
    return match.group("slug") if match else ""


def validate(repo: Path, *, require_origin: bool = False) -> None:
    repo = repo.resolve()
    check_owner(repo)
    check_release_policy(repo)
    check_plugin_code(repo)
    check_actions(repo)
    slug = origin_slug(repo)
    if require_origin and slug is None:
        raise RepositoryError("git remote origin is required for release validation")
    if slug is not None and slug != EXPECTED_REPOSITORY:
        raise RepositoryError(f"remote origin must be github.com/{EXPECTED_REPOSITORY}, got {slug or 'an invalid URL'}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--require-origin", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        validate(args.repo, require_origin=args.require_origin)
    except (RepositoryError, package_plugin.PackageError, update_latest.UpdateError, OSError) as error:
        print(f"repository check failed: {error}")
        return 1
    print(f"repository policy is valid for {EXPECTED_REPOSITORY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
