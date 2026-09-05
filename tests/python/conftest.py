from __future__ import annotations

import io
import stat
import tarfile
import zipfile
from collections.abc import Iterable
from pathlib import Path

import pytest

from scripts import update_latest as updater


def tar_bytes(
    files: dict[str, bytes],
    *,
    links: dict[str, str] | None = None,
    hardlinks: dict[str, str] | None = None,
    special: str | None = None,
) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o755 if name.startswith("bin/") else 0o644
            archive.addfile(info, io.BytesIO(content))
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            archive.addfile(info)
        for name, target in (hardlinks or {}).items():
            info = tarfile.TarInfo(name)
            info.type = tarfile.LNKTYPE
            info.linkname = target
            archive.addfile(info)
        if special:
            info = tarfile.TarInfo(special)
            info.type = tarfile.FIFOTYPE
            archive.addfile(info)
    return output.getvalue()


def zip_bytes(
    files: dict[str, bytes],
    *,
    link: tuple[str, str] | None = None,
    special: str | None = None,
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        if link:
            info = zipfile.ZipInfo(link[0])
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, link[1])
        if special:
            info = zipfile.ZipInfo(special)
            info.create_system = 3
            info.external_attr = (stat.S_IFIFO | 0o644) << 16
            archive.writestr(info, b"")
    return output.getvalue()


def installer_bytes(name: str) -> bytes:
    return ("\n".join(updater.INSTALLER_MARKERS[name]) + "\n").encode()


def toolchain_files(required: Iterable[str]) -> dict[str, bytes]:
    return {path: ("executable:" + path).encode() for path in required}


class FakeDownloader:
    def __init__(self, mapping: dict[str, bytes | Exception]) -> None:
        self.mapping = mapping
        self.calls: list[tuple[str, int]] = []

    def fetch(self, url: str, max_bytes: int) -> bytes:
        self.calls.append((url, max_bytes))
        result = self.mapping[url]
        if isinstance(result, Exception):
            raise result
        if len(result) > max_bytes:
            raise updater.SupplyChainError("fixture exceeds limit")
        return result


@pytest.fixture
def release_fixture(tmp_path: Path):
    version = "0.9.9+abc123"
    encoded = updater.encode_version(version)
    unix_installer = installer_bytes("unix")
    powershell_installer = installer_bytes("powershell")
    installer_records = {
        "unix": {
            "url": f"{updater.CDN}/install/unix.sh",
            "sha256": updater.sha256(unix_installer),
        },
        "powershell": {
            "url": f"{updater.CDN}/install/powershell.ps1",
            "sha256": updater.sha256(powershell_installer),
        },
    }
    (tmp_path / "upstream").mkdir()
    (tmp_path / "releases").mkdir()
    (tmp_path / "upstream" / "installers.json").write_text(
        updater.canonical_json({"schema": 1, "recipe": 1, "files": installer_records}), encoding="utf-8"
    )

    core_mod = f'name = "moonbitlang/core"\nversion = "{version}"\n'.encode()
    core_tar = tar_bytes({"./core/moon.mod": core_mod, "./core/builtin/moon.pkg": b"core"})
    core_zip = zip_bytes({"core/moon.mod": core_mod, "core/builtin/moon.pkg": b"core"})
    mapping: dict[str, bytes | Exception] = {
        installer_records["unix"]["url"]: unix_installer,
        installer_records["powershell"]["url"]: powershell_installer,
        f"{updater.CDN}/cores/core-latest.tar.gz": core_tar,
        f"{updater.CDN}/cores/core-latest.zip": core_zip,
        updater._core_url(version, "tar.gz"): core_tar,
        updater._core_url(version, "zip"): core_zip,
    }
    archives: dict[str, bytes] = {}
    for platform in updater.PLATFORMS:
        files = toolchain_files(platform.required)
        data = tar_bytes(files) if platform.format == "tar.gz" else zip_bytes(files)
        url = f"{updater.CDN}/binaries/{encoded}/{platform.filename}"
        mapping[url] = data
        mapping[url + ".sha256"] = f"{updater.sha256(data)}  {platform.filename}\n".encode()
        archives[platform.key] = data
    return tmp_path, version, mapping, archives
