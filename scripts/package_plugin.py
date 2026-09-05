#!/usr/bin/env python3
"""Build a deterministic vfox plugin archive, checksum, and manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path
from typing import Final

OWNER: Final = "maya0513"
REPOSITORY: Final = "vfox-moonbit"
SEMVER_RE: Final = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
STRING_FIELD_RE: Final = re.compile(r'^PLUGIN\.(?P<name>[A-Za-z][A-Za-z0-9]*)\s*=\s*"(?P<value>[^"\r\n]*)"\s*$')
LIST_FIELD_RE: Final = re.compile(
    r"^PLUGIN\.(?P<name>depends|notes|legacyFilenames)\s*=\s*\{(?P<body>.*?)\}", re.DOTALL | re.MULTILINE
)
LIST_VALUE_RE: Final = re.compile(r'"([^"\r\n]*)"')
REQUIRED_METADATA: Final = {
    "name",
    "version",
    "homepage",
    "license",
    "description",
    "minRuntimeVersion",
    "manifestUrl",
}
ROOT_FILES: Final = (
    "LICENSE",
    "README.md",
    "README.ja.md",
    "THIRD_PARTY_NOTICES",
    "metadata.lua",
    "vendor-lock.json",
)


class PackageError(RuntimeError):
    """The plugin release inputs are incomplete or inconsistent."""


def canonical_json(document: object) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def parse_metadata(path: Path) -> dict[str, object]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise PackageError(f"cannot read plugin metadata: {error}") from error

    result: dict[str, object] = {}
    for line in text.splitlines():
        match = STRING_FIELD_RE.fullmatch(line.strip())
        if match:
            result[match.group("name")] = match.group("value")
    for match in LIST_FIELD_RE.finditer(text):
        result[match.group("name")] = LIST_VALUE_RE.findall(match.group("body"))

    missing = sorted(REQUIRED_METADATA - result.keys())
    if missing:
        raise PackageError("metadata.lua is missing fields: " + ", ".join(missing))
    if result["name"] != "moonbit":
        raise PackageError("metadata.lua must name the plugin 'moonbit'")
    return result


def release_files(repo: Path) -> list[Path]:
    paths = [repo / name for name in ROOT_FILES]
    for directory in ("hooks", "lib"):
        paths.extend(sorted((repo / directory).glob("*.lua")))
    missing = [str(path.relative_to(repo)) for path in paths if not path.is_file()]
    if missing:
        raise PackageError("release input is missing: " + ", ".join(missing))
    if not (repo / "hooks" / "available.lua").is_file() or not (repo / "lib" / "sha2.lua").is_file():
        raise PackageError("release input does not contain the required hook and vendored SHA module")
    for path in paths:
        if path.is_symlink():
            raise PackageError(f"release input must not be a symlink: {path.relative_to(repo)}")
    return sorted(set(paths), key=lambda path: path.relative_to(repo).as_posix())


def zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def build(repo: Path, output_dir: Path, version: str | None = None) -> tuple[Path, Path, Path]:
    repo = repo.resolve()
    metadata = parse_metadata(repo / "metadata.lua")
    metadata_version = str(metadata["version"])
    version = metadata_version if version is None else version
    if not SEMVER_RE.fullmatch(version):
        raise PackageError(f"plugin version is not SemVer: {version!r}")
    if version != metadata_version:
        raise PackageError(f"tag version {version} does not match metadata.lua version {metadata_version}")
    if metadata["homepage"] != f"https://github.com/{OWNER}/{REPOSITORY}":
        raise PackageError("metadata.lua homepage does not match the release repository")

    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / f"{REPOSITORY}-{version}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for path in release_files(repo):
            relative = path.relative_to(repo).as_posix()
            bundle.writestr(zip_info(relative), path.read_bytes(), compresslevel=9)

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = output_dir / f"{archive.name}.sha256"
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii", newline="\n")

    manifest_document = dict(metadata)
    manifest_document["downloadUrl"] = (
        f"https://github.com/{OWNER}/{REPOSITORY}/releases/download/v{version}/{archive.name}"
    )
    manifest = output_dir / "manifest.json"
    manifest.write_text(canonical_json(manifest_document), encoding="utf-8", newline="\n")
    return archive, checksum, manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, default=Path("dist"))
    parser.add_argument("--version")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        archive, checksum, manifest = build(args.repo, args.output, args.version)
    except PackageError as error:
        print(f"package failed: {error}")
        return 1
    print(archive)
    print(checksum)
    print(manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
