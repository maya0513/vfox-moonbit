#!/usr/bin/env python3
"""Safely promote a complete MoonBit stable release into immutable manifests."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import posixpath
import re
import stat
import sys
import tarfile
import urllib.error
import urllib.request
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Final

SCHEMA: Final = 1
RECIPE: Final = 1
CDN: Final = "https://cli.moonbitlang.com"
EXACT_VERSION_RE: Final = re.compile(r"^(0)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\+([0-9A-Za-z][0-9A-Za-z._-]*)$")
SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")
DRIVE_RE: Final = re.compile(r"^[A-Za-z]:")
MAX_INSTALLER_BYTES: Final = 1024 * 1024
MAX_CHECKSUM_BYTES: Final = 4096
MAX_CORE_BYTES: Final = 128 * 1024 * 1024
MAX_TOOLCHAIN_BYTES: Final = 768 * 1024 * 1024
MAX_MEMBERS: Final = 100_000
MAX_UNCOMPRESSED_BYTES: Final = 4 * 1024 * 1024 * 1024


class UpdateError(RuntimeError):
    """Base error for update validation failures."""


class IncompleteRelease(UpdateError):
    """The CDN has not finished publishing every release artifact."""


class SupplyChainError(UpdateError):
    """Published metadata or bytes are inconsistent."""


class ManualReviewRequired(SupplyChainError):
    """Upstream semantics changed and a maintainer must review them."""


@dataclass(frozen=True)
class Platform:
    key: str
    filename: str
    format: str
    required: tuple[str, ...]


UNIX_REQUIRED: Final = (
    "bin/moon",
    "bin/moonc",
    "bin/moonfmt",
    "bin/mooninfo",
    "bin/moonrun",
    "bin/moon-lsp",
    "bin/internal/tcc",
)
WINDOWS_REQUIRED: Final = tuple(f"{item}.exe" for item in UNIX_REQUIRED if item != "bin/internal/tcc")
CORE_REQUIRED: Final = ("core/moon.mod", "core/builtin/moon.pkg")
PLATFORMS: Final = (
    Platform("darwin-aarch64", "moonbit-darwin-aarch64.tar.gz", "tar.gz", UNIX_REQUIRED),
    Platform("linux-aarch64", "moonbit-linux-aarch64.tar.gz", "tar.gz", UNIX_REQUIRED),
    Platform("linux-x86_64", "moonbit-linux-x86_64.tar.gz", "tar.gz", UNIX_REQUIRED),
    Platform("windows-x86_64", "moonbit-windows-x86_64.zip", "zip", WINDOWS_REQUIRED),
)

INSTALLER_MARKERS: Final = {
    "unix": (
        "bundle --warn-list -a --all",
        "bundle --warn-list -a --target wasm-gc --quiet",
        "chmod +x ./internal/tcc",
        "ln -sfn moon",
    ),
    "powershell": (
        "bundle --warn-list -a --all",
        "bundle --warn-list -a --target wasm-gc --quiet",
        "New-Item -ItemType HardLink",
    ),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode_version(version: str) -> str:
    if not EXACT_VERSION_RE.fullmatch(version):
        raise ManualReviewRequired(f"unsupported MoonBit version schema: {version!r}")
    return version.replace("+", "%2B")


def canonical_json(document: object) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


class Downloader:
    def __init__(self, *, timeout: float = 90.0) -> None:
        self.timeout = timeout

    def fetch(self, url: str, max_bytes: int) -> bytes:
        if not url.startswith("https://"):
            raise UpdateError(f"refusing non-HTTPS download: {url}")
        request = urllib.request.Request(  # noqa: S310 - URL scheme is constrained above.
            url,
            headers={"User-Agent": "maya0513/vfox-moonbit updater", "Accept": "application/octet-stream"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
                header = response.headers.get("Content-Length")
                if header is not None and int(header) > max_bytes:
                    raise SupplyChainError(f"download exceeds size limit: {url}")
                chunks: list[bytes] = []
                size = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise SupplyChainError(f"download exceeds size limit: {url}")
                    chunks.append(chunk)
                return b"".join(chunks)
        except urllib.error.HTTPError as error:
            if error.code in {403, 404, 409}:
                raise IncompleteRelease(f"artifact is not published yet ({error.code}): {url}") from error
            raise UpdateError(f"HTTP {error.code} while downloading {url}") from error
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise UpdateError(f"failed to download {url}: {error}") from error


def _safe_name(raw_name: str) -> str:
    if "\x00" in raw_name:
        raise SupplyChainError("archive member contains NUL")
    name = raw_name.replace("\\", "/")
    if name.startswith("/") or DRIVE_RE.match(name):
        raise SupplyChainError(f"archive contains absolute path: {raw_name!r}")
    parts = [part for part in PurePosixPath(name).parts if part not in {"", "."}]
    if not parts or any(part == ".." for part in parts):
        if not parts and name.rstrip("/") in {"", "."}:
            return ""
        raise SupplyChainError(f"archive path escapes its root: {raw_name!r}")
    return "/".join(parts)


def _safe_link(member_name: str, raw_target: str) -> None:
    if "\x00" in raw_target:
        raise SupplyChainError("archive link target contains NUL")
    target = raw_target.replace("\\", "/")
    if target.startswith("/") or DRIVE_RE.match(target):
        raise SupplyChainError(f"archive link has absolute target: {raw_target!r}")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member_name), target))
    if resolved == ".." or resolved.startswith("../"):
        raise SupplyChainError(f"archive link escapes its root: {member_name!r} -> {raw_target!r}")


def _check_layout(names: Iterable[str], required: Iterable[str], label: str) -> set[str]:
    present = set(names)
    missing = sorted(set(required) - present)
    if missing:
        raise ManualReviewRequired(f"{label} archive layout changed; missing required paths: {', '.join(missing)}")
    return present


def inspect_tar(data: bytes, *, required: Iterable[str], label: str) -> set[str]:
    names: set[str] = set()
    folded: set[str] = set()
    total_size = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            members = archive.getmembers()
            if len(members) > MAX_MEMBERS:
                raise SupplyChainError(f"{label} archive has too many members")
            for member in members:
                name = _safe_name(member.name)
                if not name:
                    continue
                key = name.casefold()
                if key in folded:
                    raise SupplyChainError(f"{label} archive has duplicate/case-colliding path: {name}")
                folded.add(key)
                names.add(name)
                if (
                    member.isdev()
                    or member.isfifo()
                    or not (member.isfile() or member.isdir() or member.issym() or member.islnk())
                ):
                    raise SupplyChainError(f"{label} archive contains unsupported special file: {name}")
                if member.issym():
                    _safe_link(name, member.linkname)
                elif member.islnk():
                    # Tar hardlink names are archive-root-relative, unlike
                    # symlink targets, which are relative to their parent.
                    _safe_name(member.linkname)
                if member.isfile():
                    total_size += member.size
                    if total_size > MAX_UNCOMPRESSED_BYTES:
                        raise SupplyChainError(f"{label} archive expands beyond the size limit")
    except (tarfile.TarError, EOFError) as error:
        raise SupplyChainError(f"invalid {label} tar.gz archive: {error}") from error
    return _check_layout(names, required, label)


def inspect_zip(data: bytes, *, required: Iterable[str], label: str) -> set[str]:
    names: set[str] = set()
    folded: set[str] = set()
    total_size = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) > MAX_MEMBERS:
                raise SupplyChainError(f"{label} archive has too many members")
            for member in members:
                name = _safe_name(member.filename)
                if not name:
                    continue
                key = name.casefold()
                if key in folded:
                    raise SupplyChainError(f"{label} archive has duplicate/case-colliding path: {name}")
                folded.add(key)
                names.add(name)
                if member.flag_bits & 0x1:
                    raise SupplyChainError(f"{label} archive contains encrypted member: {name}")
                mode = (member.external_attr >> 16) & 0xFFFF
                if mode and any(
                    predicate(mode) for predicate in (stat.S_ISCHR, stat.S_ISBLK, stat.S_ISFIFO, stat.S_ISSOCK)
                ):
                    raise SupplyChainError(f"{label} archive contains unsupported special file: {name}")
                total_size += member.file_size
                if total_size > MAX_UNCOMPRESSED_BYTES:
                    raise SupplyChainError(f"{label} archive expands beyond the size limit")
                if mode and stat.S_ISLNK(mode):
                    target = archive.read(member).decode("utf-8")
                    _safe_link(name, target)
            bad_member = archive.testzip()
            if bad_member is not None:
                raise SupplyChainError(f"{label} archive has corrupt member: {bad_member}")
    except (zipfile.BadZipFile, UnicodeDecodeError, RuntimeError) as error:
        raise SupplyChainError(f"invalid {label} zip archive: {error}") from error
    return _check_layout(names, required, label)


def inspect_archive(data: bytes, format_name: str, *, required: Iterable[str], label: str) -> set[str]:
    if format_name == "tar.gz":
        return inspect_tar(data, required=required, label=label)
    if format_name == "zip":
        return inspect_zip(data, required=required, label=label)
    raise SupplyChainError(f"unsupported archive format: {format_name}")


def core_version(data: bytes, format_name: str) -> str:
    path = "core/moon.mod"
    try:
        if format_name == "tar.gz":
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                members = {_safe_name(member.name): member for member in archive.getmembers()}
                member = members.get(path)
                if member is None or not member.isfile():
                    raise SupplyChainError("core archive has no regular core/moon.mod")
                stream = archive.extractfile(member)
                if stream is None:
                    raise SupplyChainError("cannot read core/moon.mod")
                content = stream.read(1024 * 1024 + 1)
        elif format_name == "zip":
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                content = archive.read(path)
        else:
            raise SupplyChainError(f"unsupported core format: {format_name}")
    except (tarfile.TarError, zipfile.BadZipFile, KeyError) as error:
        raise SupplyChainError(f"cannot read core version: {error}") from error
    if len(content) > 1024 * 1024:
        raise SupplyChainError("core/moon.mod exceeds its size limit")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SupplyChainError("core/moon.mod is not UTF-8") from error
    match = re.search(r'^\s*version\s*=\s*"([^"]+)"\s*$', text, re.MULTILINE)
    if not match:
        raise SupplyChainError("core/moon.mod has no top-level version")
    return match.group(1)


def parse_checksum(data: bytes, expected_filename: str) -> str:
    try:
        text = data.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise SupplyChainError("official checksum is not ASCII") from error
    match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?([^\s]+)", text)
    if not match or match.group(2) != expected_filename:
        raise SupplyChainError(f"malformed official checksum for {expected_filename}")
    return match.group(1).lower()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SupplyChainError(f"cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise SupplyChainError(f"JSON root must be an object: {path}")
    return value


def check_installers(repo: Path, downloader: Downloader) -> None:
    lock = load_json(repo / "upstream" / "installers.json")
    if lock.get("schema") != SCHEMA or lock.get("recipe") != RECIPE or not isinstance(lock.get("files"), dict):
        raise SupplyChainError("invalid installer lock schema")
    for name, markers in INSTALLER_MARKERS.items():
        record = lock["files"].get(name)
        if not isinstance(record, dict) or not SHA256_RE.fullmatch(str(record.get("sha256", ""))):
            raise SupplyChainError(f"invalid installer lock record: {name}")
        url = record.get("url")
        if not isinstance(url, str) or not url.startswith(CDN + "/install/"):
            raise SupplyChainError(f"installer does not use the official CDN: {name}")
        data = downloader.fetch(url, MAX_INSTALLER_BYTES)
        if sha256(data) != record["sha256"]:
            raise ManualReviewRequired(f"official {name} installer changed; review the installation recipe")
        text = data.decode("utf-8", errors="replace")
        if any(marker not in text for marker in markers):
            raise ManualReviewRequired(f"official {name} installer no longer matches recipe {RECIPE}")
        print(f"verified official {name} installer", file=sys.stderr)


def _core_url(version: str, extension: str) -> str:
    return f"{CDN}/cores/core-{encode_version(version)}.{extension}"


def _artifact(url: str, digest: str, format_name: str) -> dict[str, str]:
    return {"format": format_name, "sha256": digest, "url": url}


def discover(repo: Path, downloader: Downloader) -> dict[str, Any]:
    check_installers(repo, downloader)

    latest_urls = {
        "tar.gz": f"{CDN}/cores/core-latest.tar.gz",
        "zip": f"{CDN}/cores/core-latest.zip",
    }
    latest_core = {format_name: downloader.fetch(url, MAX_CORE_BYTES) for format_name, url in latest_urls.items()}
    for format_name, data in latest_core.items():
        inspect_archive(data, format_name, required=CORE_REQUIRED, label=f"latest core {format_name}")
        print(f"verified latest core {format_name}", file=sys.stderr)
    versions = {core_version(data, format_name) for format_name, data in latest_core.items()}
    if len(versions) != 1:
        raise IncompleteRelease("latest core tar.gz and zip point to different MoonBit versions")
    version = versions.pop()
    encode_version(version)  # Also acts as the pre-1.0 major-version gate.

    exact_core: dict[str, bytes] = {}
    for format_name, latest_data in latest_core.items():
        extension = "tar.gz" if format_name == "tar.gz" else "zip"
        url = _core_url(version, extension)
        data = downloader.fetch(url, MAX_CORE_BYTES)
        if data != latest_data:
            raise SupplyChainError(f"latest and exact MoonBit core differ for {format_name}")
        exact_core[format_name] = data
        print(f"verified exact core {format_name}", file=sys.stderr)

    encoded = encode_version(version)
    platforms: dict[str, Any] = {}
    for platform in PLATFORMS:
        url = f"{CDN}/binaries/{encoded}/{platform.filename}"
        checksum_data = downloader.fetch(url + ".sha256", MAX_CHECKSUM_BYTES)
        expected = parse_checksum(checksum_data, platform.filename)
        archive = downloader.fetch(url, MAX_TOOLCHAIN_BYTES)
        actual = sha256(archive)
        if actual != expected:
            raise SupplyChainError(
                f"official checksum mismatch for {platform.filename}: expected {expected}, got {actual}"
            )
        inspect_archive(archive, platform.format, required=platform.required, label=platform.key)
        print(f"verified {platform.key} toolchain", file=sys.stderr)
        core_format = "zip" if platform.format == "zip" else "tar.gz"
        core_extension = "zip" if core_format == "zip" else "tar.gz"
        platforms[platform.key] = {
            "core": _artifact(
                _core_url(version, core_extension),
                sha256(exact_core[core_format]),
                core_format,
            ),
            "toolchain": _artifact(url, actual, platform.format),
        }

    # Detect a latest pointer change that happened while platform artifacts were
    # being checked. A later poll will retry with one coherent release.
    for format_name, url in latest_urls.items():
        if downloader.fetch(url, MAX_CORE_BYTES) != latest_core[format_name]:
            raise IncompleteRelease(f"MoonBit latest {format_name} changed during discovery; deferring promotion")

    return {"schema": SCHEMA, "recipe": RECIPE, "version": version, "platforms": platforms}


def latest_pointer(version: str) -> dict[str, Any]:
    return {"schema": SCHEMA, "recipe": RECIPE, "version": version, "manifest": f"{version}.json"}


def validate_exact(document: dict[str, Any], *, expected_version: str | None = None) -> None:
    if document.get("schema") != SCHEMA or document.get("recipe") != RECIPE:
        raise SupplyChainError("unsupported release manifest schema or recipe")
    version = document.get("version")
    if not isinstance(version, str) or not EXACT_VERSION_RE.fullmatch(version):
        raise SupplyChainError("release manifest has invalid version")
    if expected_version is not None and version != expected_version:
        raise SupplyChainError("release manifest version does not match its filename")
    platforms = document.get("platforms")
    if not isinstance(platforms, dict) or set(platforms) != {platform.key for platform in PLATFORMS}:
        raise SupplyChainError("release manifest platform set is incomplete or unexpected")
    encoded = encode_version(version)
    for platform in PLATFORMS:
        record = platforms[platform.key]
        if not isinstance(record, dict) or set(record) != {"core", "toolchain"}:
            raise SupplyChainError(f"invalid component set for {platform.key}")
        expected_format = platform.format
        for component in ("core", "toolchain"):
            artifact = record[component]
            if not isinstance(artifact, dict) or set(artifact) != {"format", "sha256", "url"}:
                raise SupplyChainError(f"invalid {component} record for {platform.key}")
            if artifact["format"] != expected_format:
                raise SupplyChainError(f"invalid format for {platform.key} {component}")
            if not isinstance(artifact["sha256"], str) or not SHA256_RE.fullmatch(artifact["sha256"]):
                raise SupplyChainError(f"invalid digest for {platform.key} {component}")
            core_extension = "zip" if platform.format == "zip" else "tar.gz"
            expected_url = (
                _core_url(version, core_extension)
                if component == "core"
                else f"{CDN}/binaries/{encoded}/{platform.filename}"
            )
            if artifact["url"] != expected_url:
                raise SupplyChainError(f"non-canonical URL for {platform.key} {component}")


def validate_local(repo: Path) -> None:
    release_dir = repo / "releases"
    pointer_path = release_dir / "latest.json"
    pointer = load_json(pointer_path)
    if set(pointer) != {"schema", "recipe", "version", "manifest"}:
        raise SupplyChainError("latest pointer has unexpected fields")
    if pointer.get("schema") != SCHEMA or pointer.get("recipe") != RECIPE:
        raise SupplyChainError("latest pointer has unsupported schema or recipe")
    version = pointer.get("version")
    if not isinstance(version, str) or not EXACT_VERSION_RE.fullmatch(version):
        raise SupplyChainError("latest pointer has invalid version")
    if pointer.get("manifest") != f"{version}.json":
        raise SupplyChainError("latest pointer filename is inconsistent")

    exact_paths = sorted(path for path in release_dir.glob("*.json") if path.name != "latest.json")
    if not exact_paths:
        raise SupplyChainError("no exact MoonBit manifests are present")
    for path in exact_paths:
        exact_version = path.name.removesuffix(".json")
        document = load_json(path)
        validate_exact(document, expected_version=exact_version)
        if path.read_text(encoding="utf-8") != canonical_json(document):
            raise SupplyChainError(f"manifest is not canonical JSON: {path}")
    if not (release_dir / str(pointer["manifest"])).is_file():
        raise SupplyChainError("latest pointer targets a missing exact manifest")
    if pointer_path.read_text(encoding="utf-8") != canonical_json(pointer):
        raise SupplyChainError("latest pointer is not canonical JSON")

    vendor = load_json(repo / "vendor-lock.json")
    record = vendor.get("pure_lua_SHA")
    if vendor.get("schema") != 1 or not isinstance(record, dict):
        raise SupplyChainError("invalid vendor lock")
    vendored_path = repo / str(record.get("file"))
    try:
        vendored_digest = hashlib.sha256(vendored_path.read_bytes()).hexdigest()
    except OSError as error:
        raise SupplyChainError(f"cannot read vendored SHA module: {error}") from error
    if vendored_digest != record.get("sha256"):
        raise SupplyChainError("vendored pure_lua_SHA digest does not match vendor-lock.json")


def promote(repo: Path, exact: dict[str, Any], *, dry_run: bool = False) -> bool:
    validate_exact(exact)
    version = str(exact["version"])
    exact_path = repo / "releases" / f"{version}.json"
    pointer_path = repo / "releases" / "latest.json"
    exact_text = canonical_json(exact)
    pointer_text = canonical_json(latest_pointer(version))

    if exact_path.exists() and exact_path.read_text(encoding="utf-8") != exact_text:
        raise SupplyChainError(f"immutable manifest changed for already-recorded MoonBit {version}")
    changed = (
        not exact_path.exists() or not pointer_path.exists() or pointer_path.read_text(encoding="utf-8") != pointer_text
    )
    if dry_run or not changed:
        return changed
    exact_path.parent.mkdir(parents=True, exist_ok=True)
    if not exact_path.exists():
        exact_path.write_text(exact_text, encoding="utf-8", newline="\n")
    temporary = pointer_path.with_suffix(".json.part")
    temporary.write_text(pointer_text, encoding="utf-8", newline="\n")
    temporary.replace(pointer_path)
    return True


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="validate checked-in manifests without network access")
    mode.add_argument("--dry-run", action="store_true", help="discover upstream but do not write manifests")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, *, downloader: Downloader | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    repo = args.repo.resolve()
    try:
        validate_local(repo)
        if args.check:
            print("checked-in MoonBit manifests and vendor lock are valid")
            return 0
        exact = discover(repo, downloader or Downloader())
        changed = promote(repo, exact, dry_run=args.dry_run)
        state = "would update" if args.dry_run and changed else "updated" if changed else "already current"
        print(f"MoonBit {exact['version']}: {state}")
        return 0
    except IncompleteRelease as error:
        print(f"release incomplete; deferred: {error}", file=sys.stderr)
        return 0
    except ManualReviewRequired as error:
        print(f"manual review required: {error}", file=sys.stderr)
        return 2
    except UpdateError as error:
        print(f"update failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
