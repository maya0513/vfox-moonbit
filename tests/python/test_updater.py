from __future__ import annotations

import copy
import hashlib
import io
import json
import tarfile
import urllib.error
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import update_latest as updater
from tests.python.conftest import FakeDownloader, installer_bytes, tar_bytes, zip_bytes


def test_small_helpers():
    assert updater.sha256(b"abc") == hashlib.sha256(b"abc").hexdigest()
    assert updater.encode_version("0.10.2+abc-def.1") == "0.10.2%2Babc-def.1"
    assert updater.latest_pointer("0.1.0+a") == {
        "schema": 1,
        "recipe": 1,
        "version": "0.1.0+a",
        "manifest": "0.1.0+a.json",
    }
    assert updater.canonical_json({"z": 1, "a": 2}) == '{\n  "a": 2,\n  "z": 1\n}\n'


@pytest.mark.parametrize(
    "version",
    ["latest", "1.0.0+abc", "0.01.0+abc", "0.1.01+abc", "0.1", "0.1.0", "0.1.0+", "0.1.0+a/b"],
)
def test_encode_version_rejects_unsupported_versions(version):
    with pytest.raises(updater.ManualReviewRequired):
        updater.encode_version(version)


class FakeResponse:
    def __init__(self, data: bytes, content_length: str | None = None):
        self.data = io.BytesIO(data)
        self.headers = {} if content_length is None else {"Content-Length": content_length}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, size):
        return self.data.read(size)


def test_downloader_fetches_in_chunks(monkeypatch):
    captured = {}

    def urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse(b"payload", "7")

    monkeypatch.setattr(updater.urllib.request, "urlopen", urlopen)
    assert updater.Downloader(timeout=3).fetch("https://example.test/a", 8) == b"payload"
    assert captured["timeout"] == 3
    assert captured["request"].get_header("User-agent").startswith("maya0513/")


def test_downloader_rejects_non_https():
    with pytest.raises(updater.UpdateError, match="non-HTTPS"):
        updater.Downloader().fetch("http://example.test/a", 8)


@pytest.mark.parametrize(
    "code,expected", [(404, updater.IncompleteRelease), (403, updater.IncompleteRelease), (500, updater.UpdateError)]
)
def test_downloader_classifies_http_errors(monkeypatch, code, expected):
    def urlopen(*_args, **_kwargs):
        raise urllib.error.HTTPError("https://example.test", code, "bad", {}, None)

    monkeypatch.setattr(updater.urllib.request, "urlopen", urlopen)
    with pytest.raises(expected):
        updater.Downloader().fetch("https://example.test", 20)


@pytest.mark.parametrize("error", [urllib.error.URLError("offline"), TimeoutError(), OSError("broken")])
def test_downloader_wraps_transport_errors(monkeypatch, error):
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    with pytest.raises(updater.UpdateError):
        updater.Downloader().fetch("https://example.test", 20)


def test_downloader_enforces_header_and_stream_limits(monkeypatch):
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"x", "99"))
    with pytest.raises(updater.SupplyChainError):
        updater.Downloader().fetch("https://example.test", 2)
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"abc"))
    with pytest.raises(updater.SupplyChainError):
        updater.Downloader().fetch("https://example.test", 2)
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(b"x", "bad"))
    with pytest.raises(updater.UpdateError):
        updater.Downloader().fetch("https://example.test", 2)


@pytest.mark.parametrize(
    "name", ["/etc/passwd", "C:/escape", "../escape", "a/../../escape", "a\\..\\..\\escape", "a\x00b"]
)
def test_safe_name_rejects_escapes(name):
    with pytest.raises(updater.SupplyChainError):
        updater._safe_name(name)


def test_safe_name_normalizes_dot_and_root():
    assert updater._safe_name("./core/moon.mod") == "core/moon.mod"
    assert updater._safe_name(".") == ""


def test_safe_link_accepts_relative_and_rejects_escape():
    updater._safe_link("core/docs/readme", "../README.md")
    with pytest.raises(updater.SupplyChainError):
        updater._safe_link("core/readme", "../../outside")
    with pytest.raises(updater.SupplyChainError):
        updater._safe_link("core/readme", "/outside")
    with pytest.raises(updater.SupplyChainError, match="NUL"):
        updater._safe_link("core/readme", "bad\x00target")


def test_tar_hardlinks_are_archive_root_relative():
    archive = tar_bytes({"core/target": b"ok"}, hardlinks={"core/link": "core/target"})
    updater.inspect_tar(archive, required=("core/link",), label="core")
    escaping = tar_bytes({"core/target": b"ok"}, hardlinks={"core/link": "../outside"})
    with pytest.raises(updater.SupplyChainError, match="escapes"):
        updater.inspect_tar(escaping, required=(), label="core")


def test_tar_and_zip_inspection_happy_paths():
    tar = tar_bytes({"./bin/moon": b"moon", "./readme": b"ok"}, links={"./docs/link": "../readme"})
    assert "bin/moon" in updater.inspect_tar(tar, required=("bin/moon",), label="tool")
    zip_data = zip_bytes({"bin/moon.exe": b"moon"}, link=("docs/link", "../bin/moon.exe"))
    assert "bin/moon.exe" in updater.inspect_zip(zip_data, required=("bin/moon.exe",), label="tool")
    assert updater.inspect_archive(tar, "tar.gz", required=("bin/moon",), label="tool")
    assert updater.inspect_archive(zip_data, "zip", required=("bin/moon.exe",), label="tool")
    with pytest.raises(updater.SupplyChainError, match="unsupported archive format"):
        updater.inspect_archive(b"", "7z", required=(), label="tool")


@pytest.mark.parametrize(
    "data,format_name",
    [
        (tar_bytes({"../escape": b"x"}), "tar.gz"),
        (tar_bytes({"ok": b"x"}, links={"link": "../outside"}), "tar.gz"),
        (tar_bytes({"ok": b"x"}, special="pipe"), "tar.gz"),
        (zip_bytes({"../escape": b"x"}), "zip"),
        (zip_bytes({"ok": b"x"}, link=("link", "../outside")), "zip"),
        (zip_bytes({"ok": b"x"}, special="pipe"), "zip"),
    ],
)
def test_archive_inspection_rejects_unsafe_members(data, format_name):
    with pytest.raises(updater.SupplyChainError):
        updater.inspect_archive(data, format_name, required=(), label="unsafe")


def test_archive_inspection_rejects_missing_duplicate_corrupt_and_limits(monkeypatch):
    with pytest.raises(updater.SupplyChainError, match="missing required"):
        updater.inspect_tar(tar_bytes({"other": b"x"}), required=("bin/moon",), label="tool")
    with pytest.raises(updater.SupplyChainError, match="invalid"):
        updater.inspect_tar(b"not tar", required=(), label="tool")
    with pytest.raises(updater.SupplyChainError, match="invalid"):
        updater.inspect_zip(b"not zip", required=(), label="tool")

    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name in ("Same", "same"):
            info = tarfile.TarInfo(name)
            info.size = 1
            archive.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(updater.SupplyChainError, match="colliding"):
        updater.inspect_tar(output.getvalue(), required=(), label="tool")

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("Same", b"x")
        archive.writestr("same", b"x")
    with pytest.raises(updater.SupplyChainError, match="colliding"):
        updater.inspect_zip(output.getvalue(), required=(), label="tool")

    monkeypatch.setattr(updater, "MAX_MEMBERS", 0)
    with pytest.raises(updater.SupplyChainError, match="too many"):
        updater.inspect_zip(zip_bytes({"one": b"1"}), required=(), label="tool")
    with pytest.raises(updater.SupplyChainError, match="too many"):
        updater.inspect_tar(tar_bytes({"one": b"1"}), required=(), label="tool")
    monkeypatch.setattr(updater, "MAX_MEMBERS", 100_000)
    monkeypatch.setattr(updater, "MAX_UNCOMPRESSED_BYTES", 0)
    with pytest.raises(updater.SupplyChainError, match="expands"):
        updater.inspect_tar(tar_bytes({"one": b"1"}), required=(), label="tool")
    with pytest.raises(updater.SupplyChainError, match="expands"):
        updater.inspect_zip(zip_bytes({"one": b"1"}), required=(), label="tool")


def test_archive_root_entries_and_defensive_zip_checks(monkeypatch):
    updater.inspect_tar(tar_bytes({".": b""}), required=(), label="root")
    updater.inspect_zip(zip_bytes({".": b""}), required=(), label="root")

    class FakeZip:
        def __init__(self, member, bad=None):
            self.member = member
            self.bad = bad

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def infolist(self):
            return [self.member]

        def testzip(self):
            return self.bad

    encrypted = SimpleNamespace(filename="secret", flag_bits=1, external_attr=0, file_size=0)
    monkeypatch.setattr(updater.zipfile, "ZipFile", lambda *_args, **_kwargs: FakeZip(encrypted))
    with pytest.raises(updater.SupplyChainError, match="encrypted"):
        updater.inspect_zip(b"fixture", required=(), label="tool")

    regular = SimpleNamespace(filename="file", flag_bits=0, external_attr=0, file_size=0)
    monkeypatch.setattr(updater.zipfile, "ZipFile", lambda *_args, **_kwargs: FakeZip(regular, "file"))
    with pytest.raises(updater.SupplyChainError, match="corrupt"):
        updater.inspect_zip(b"fixture", required=(), label="tool")


def test_core_version_reads_both_formats():
    mod = b'name = "moonbitlang/core"\nversion = "0.2.3+abc"\n'
    assert updater.core_version(tar_bytes({"./core/moon.mod": mod}), "tar.gz") == "0.2.3+abc"
    assert updater.core_version(zip_bytes({"core/moon.mod": mod}), "zip") == "0.2.3+abc"


@pytest.mark.parametrize(
    "data,format_name",
    [
        (tar_bytes({"core/nope": b"x"}), "tar.gz"),
        (zip_bytes({"core/nope": b"x"}), "zip"),
        (tar_bytes({"core/moon.mod": b"name = 1"}), "tar.gz"),
        (zip_bytes({"core/moon.mod": b"\xff"}), "zip"),
    ],
)
def test_core_version_rejects_bad_metadata(data, format_name):
    with pytest.raises(updater.SupplyChainError):
        updater.core_version(data, format_name)
    with pytest.raises(updater.SupplyChainError):
        updater.core_version(b"", "7z")


def test_core_version_size_and_unreadable_stream(monkeypatch):
    oversized = zip_bytes({"core/moon.mod": b"x" * (1024 * 1024 + 1)})
    with pytest.raises(updater.SupplyChainError, match="size limit"):
        updater.core_version(oversized, "zip")

    member = SimpleNamespace(name="core/moon.mod", isfile=lambda: True)

    class FakeTar:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def getmembers(self):
            return [member]

        def extractfile(self, _member):
            return None

    monkeypatch.setattr(updater.tarfile, "open", lambda *_args, **_kwargs: FakeTar())
    with pytest.raises(updater.SupplyChainError, match="cannot read"):
        updater.core_version(b"fixture", "tar.gz")


def test_parse_checksum_strictness():
    digest = "a" * 64
    assert updater.parse_checksum(f"{digest}  moon.zip\n".encode(), "moon.zip") == digest
    assert updater.parse_checksum(f"{digest.upper()} *moon.zip".encode(), "moon.zip") == digest
    for malformed in (b"no", f"{digest} wrong.zip".encode(), b"\xff"):
        with pytest.raises(updater.SupplyChainError):
            updater.parse_checksum(malformed, "moon.zip")


def test_load_json_errors(tmp_path):
    path = tmp_path / "value.json"
    path.write_text("[]", encoding="utf-8")
    with pytest.raises(updater.SupplyChainError, match="root"):
        updater.load_json(path)
    path.write_text("{", encoding="utf-8")
    with pytest.raises(updater.SupplyChainError, match="cannot read"):
        updater.load_json(path)
    with pytest.raises(updater.SupplyChainError, match="cannot read"):
        updater.load_json(tmp_path / "missing")


def test_check_installers(release_fixture):
    repo, _, mapping, _ = release_fixture
    updater.check_installers(repo, FakeDownloader(mapping))
    changed = dict(mapping)
    changed[f"{updater.CDN}/install/unix.sh"] = b"changed"
    with pytest.raises(updater.ManualReviewRequired, match="installer changed"):
        updater.check_installers(repo, FakeDownloader(changed))


def test_check_installers_validates_lock_and_recipe(release_fixture):
    repo, _, mapping, _ = release_fixture
    lock_path = repo / "upstream" / "installers.json"
    lock = json.loads(lock_path.read_text())
    lock["files"]["unix"]["sha256"] = "bad"
    lock_path.write_text(updater.canonical_json(lock))
    with pytest.raises(updater.SupplyChainError, match="lock record"):
        updater.check_installers(repo, FakeDownloader(mapping))

    data = installer_bytes("unix").replace(b"ln -sfn moon", b"different recipe")
    lock["files"]["unix"]["sha256"] = updater.sha256(data)
    lock_path.write_text(updater.canonical_json(lock))
    mapping[f"{updater.CDN}/install/unix.sh"] = data
    with pytest.raises(updater.ManualReviewRequired, match="no longer matches"):
        updater.check_installers(repo, FakeDownloader(mapping))


def test_check_installers_rejects_schema_and_origin(release_fixture):
    repo, _, mapping, _ = release_fixture
    lock_path = repo / "upstream" / "installers.json"
    lock = json.loads(lock_path.read_text())
    lock["schema"] = 2
    lock_path.write_text(updater.canonical_json(lock))
    with pytest.raises(updater.SupplyChainError, match="lock schema"):
        updater.check_installers(repo, FakeDownloader(mapping))
    lock["schema"] = 1
    lock["files"]["unix"]["url"] = "https://evil.test/unix.sh"
    lock_path.write_text(updater.canonical_json(lock))
    with pytest.raises(updater.SupplyChainError, match="official CDN"):
        updater.check_installers(repo, FakeDownloader(mapping))


def test_discover_complete_release(release_fixture):
    repo, version, mapping, archives = release_fixture
    exact = updater.discover(repo, FakeDownloader(mapping))
    assert exact["version"] == version
    assert set(exact["platforms"]) == {platform.key for platform in updater.PLATFORMS}
    for platform in updater.PLATFORMS:
        assert exact["platforms"][platform.key]["toolchain"]["sha256"] == updater.sha256(archives[platform.key])
        assert "%2B" in exact["platforms"][platform.key]["toolchain"]["url"]


def test_discover_defers_partial_and_cross_platform_version_skew(release_fixture):
    repo, version, mapping, _ = release_fixture
    encoded = updater.encode_version(version)
    partial = dict(mapping)
    platform = updater.PLATFORMS[0]
    partial[f"{updater.CDN}/binaries/{encoded}/{platform.filename}"] = updater.IncompleteRelease("not ready")
    with pytest.raises(updater.IncompleteRelease):
        updater.discover(repo, FakeDownloader(partial))

    skewed = dict(mapping)
    skew_mod = b'version = "0.9.10+different"\n'
    skewed[f"{updater.CDN}/cores/core-latest.zip"] = zip_bytes(
        {"core/moon.mod": skew_mod, "core/builtin/moon.pkg": b"core"}
    )
    with pytest.raises(updater.IncompleteRelease, match="different"):
        updater.discover(repo, FakeDownloader(skewed))


def test_discover_rejects_exact_core_or_toolchain_tampering(release_fixture):
    repo, version, mapping, _ = release_fixture
    encoded = updater.encode_version(version)
    core_changed = dict(mapping)
    core_changed[updater._core_url(version, "zip")] = zip_bytes(
        {"core/moon.mod": f'version = "{version}"'.encode(), "extra": b"new"}
    )
    with pytest.raises(updater.SupplyChainError, match="latest and exact"):
        updater.discover(repo, FakeDownloader(core_changed))

    checksum_changed = dict(mapping)
    platform = updater.PLATFORMS[0]
    checksum_changed[f"{updater.CDN}/binaries/{encoded}/{platform.filename}.sha256"] = (
        f"{'0' * 64}  {platform.filename}\n".encode()
    )
    with pytest.raises(updater.SupplyChainError, match="checksum mismatch"):
        updater.discover(repo, FakeDownloader(checksum_changed))


@pytest.mark.parametrize("format_name", ["tar.gz", "zip"])
def test_discover_detects_latest_race(release_fixture, format_name):
    repo, _, mapping, _ = release_fixture
    latest_url = f"{updater.CDN}/cores/core-latest.{format_name}"

    class RacingDownloader(FakeDownloader):
        def __init__(self, values):
            super().__init__(values)
            self.latest_calls = 0

        def fetch(self, url, max_bytes):
            if url == latest_url:
                self.latest_calls += 1
                if self.latest_calls == 2:
                    return b"new latest"
            return super().fetch(url, max_bytes)

    with pytest.raises(updater.IncompleteRelease, match="changed during"):
        updater.discover(repo, RacingDownloader(mapping))


def valid_exact(version="0.1.2+abc"):
    encoded = updater.encode_version(version)
    platforms = {}
    for platform in updater.PLATFORMS:
        url = f"{updater.CDN}/binaries/{encoded}/{platform.filename}"
        core_extension = "zip" if platform.format == "zip" else "tar.gz"
        platforms[platform.key] = {
            "toolchain": {"url": url, "sha256": "a" * 64, "format": platform.format},
            "core": {
                "url": updater._core_url(version, core_extension),
                "sha256": "b" * 64,
                "format": platform.format,
            },
        }
    return {"schema": 1, "recipe": 1, "version": version, "platforms": platforms}


def test_validate_exact_accepts_complete_manifest():
    updater.validate_exact(valid_exact(), expected_version="0.1.2+abc")


@pytest.mark.parametrize(
    "mutator",
    [
        lambda d: d.update(schema=2),
        lambda d: d.update(version="latest"),
        lambda d: d["platforms"].pop("linux-x86_64"),
        lambda d: d["platforms"]["linux-x86_64"].update(extra={}),
        lambda d: d["platforms"]["linux-x86_64"]["core"].update(format="zip"),
        lambda d: d["platforms"]["linux-x86_64"]["core"].update(sha256="bad"),
        lambda d: d["platforms"]["linux-x86_64"]["core"].update(url="http://evil.test/core"),
        lambda d: d["platforms"]["linux-x86_64"]["core"].update(url=f"{updater.CDN}/cores/other/core.tar.gz"),
        lambda d: d["platforms"]["linux-x86_64"]["toolchain"].update(
            url=f"{updater.CDN}/binaries/0.1.2%2Babc/moonbit-linux-aarch64.tar.gz"
        ),
        lambda d: d["platforms"]["linux-x86_64"]["core"].update(extra="field"),
    ],
)
def test_validate_exact_rejects_schema_mutations(mutator):
    document = valid_exact()
    mutator(document)
    with pytest.raises(updater.SupplyChainError):
        updater.validate_exact(document)


def write_vendor_lock(repo: Path):
    vendor = repo / "sha.lua"
    vendor.write_bytes(b"vendored")
    (repo / "vendor-lock.json").write_text(
        updater.canonical_json(
            {"schema": 1, "pure_lua_SHA": {"file": "sha.lua", "sha256": updater.sha256(b"vendored")}}
        ),
        encoding="utf-8",
    )


def test_promote_and_validate_local(tmp_path):
    (tmp_path / "releases").mkdir()
    exact = valid_exact()
    assert updater.promote(tmp_path, exact)
    assert not updater.promote(tmp_path, exact)
    write_vendor_lock(tmp_path)
    updater.validate_local(tmp_path)
    assert json.loads((tmp_path / "releases" / "latest.json").read_text())["version"] == exact["version"]


def test_promote_dry_run_and_immutable_guard(tmp_path):
    (tmp_path / "releases").mkdir()
    exact = valid_exact()
    assert updater.promote(tmp_path, exact, dry_run=True)
    assert not list((tmp_path / "releases").iterdir())
    updater.promote(tmp_path, exact)
    changed = copy.deepcopy(exact)
    changed["platforms"]["linux-x86_64"]["core"]["sha256"] = "c" * 64
    with pytest.raises(updater.SupplyChainError, match="immutable"):
        updater.promote(tmp_path, changed)


def test_validate_local_rejects_pointer_canonical_vendor_and_filename(tmp_path):
    (tmp_path / "releases").mkdir()
    exact = valid_exact()
    updater.promote(tmp_path, exact)
    write_vendor_lock(tmp_path)

    pointer = tmp_path / "releases" / "latest.json"
    original = pointer.read_text()
    pointer.write_text(original.rstrip(), encoding="utf-8")
    with pytest.raises(updater.SupplyChainError, match="canonical"):
        updater.validate_local(tmp_path)
    pointer.write_text(original, encoding="utf-8")

    vendor = json.loads((tmp_path / "vendor-lock.json").read_text())
    vendor["pure_lua_SHA"]["sha256"] = "0" * 64
    (tmp_path / "vendor-lock.json").write_text(updater.canonical_json(vendor))
    with pytest.raises(updater.SupplyChainError, match="vendored"):
        updater.validate_local(tmp_path)

    write_vendor_lock(tmp_path)
    exact_path = tmp_path / "releases" / f"{exact['version']}.json"
    exact_path.rename(tmp_path / "releases" / "0.2.0+wrong.json")
    with pytest.raises(updater.SupplyChainError, match="filename"):
        updater.validate_local(tmp_path)


def make_local_repo(path: Path):
    (path / "releases").mkdir()
    exact = valid_exact()
    updater.promote(path, exact)
    write_vendor_lock(path)
    return exact


@pytest.mark.parametrize(
    "mutation,match",
    [
        (lambda repo, exact: (repo / "releases" / "latest.json").write_text("{}"), "unexpected fields"),
        (
            lambda repo, exact: (repo / "releases" / "latest.json").write_text(
                updater.canonical_json({**updater.latest_pointer(exact["version"]), "schema": 2})
            ),
            "unsupported schema",
        ),
        (
            lambda repo, exact: (repo / "releases" / "latest.json").write_text(
                updater.canonical_json({**updater.latest_pointer(exact["version"]), "version": "latest"})
            ),
            "invalid version",
        ),
        (
            lambda repo, exact: (repo / "releases" / "latest.json").write_text(
                updater.canonical_json({**updater.latest_pointer(exact["version"]), "manifest": "other.json"})
            ),
            "filename is inconsistent",
        ),
        (
            lambda repo, exact: (repo / "releases" / f"{exact['version']}.json").unlink(),
            "no exact",
        ),
        (
            lambda repo, exact: (repo / "releases" / "latest.json").write_text(
                updater.canonical_json({**updater.latest_pointer(exact["version"]), "manifest": "0.0.0+missing.json"})
            ),
            "filename is inconsistent",
        ),
        (lambda repo, exact: (repo / "vendor-lock.json").write_text("{}"), "invalid vendor lock"),
        (lambda repo, exact: (repo / "sha.lua").unlink(), "cannot read vendored"),
    ],
)
def test_validate_local_defensive_failures(tmp_path, mutation, match):
    exact = make_local_repo(tmp_path)
    mutation(tmp_path, exact)
    with pytest.raises(updater.SupplyChainError, match=match):
        updater.validate_local(tmp_path)


def test_validate_local_rejects_noncanonical_exact_and_missing_target(tmp_path):
    exact = make_local_repo(tmp_path)
    exact_path = tmp_path / "releases" / f"{exact['version']}.json"
    exact_path.write_text(exact_path.read_text().rstrip(), encoding="utf-8")
    with pytest.raises(updater.SupplyChainError, match="not canonical"):
        updater.validate_local(tmp_path)

    exact_path.write_text(updater.canonical_json(exact), encoding="utf-8")
    pointer = updater.latest_pointer("0.2.0+missing")
    (tmp_path / "releases" / "latest.json").write_text(updater.canonical_json(pointer), encoding="utf-8")
    with pytest.raises(updater.SupplyChainError, match="missing exact"):
        updater.validate_local(tmp_path)


def test_promote_updates_pointer_when_exact_already_exists(tmp_path):
    (tmp_path / "releases").mkdir()
    old = valid_exact("0.1.1+old")
    new = valid_exact("0.1.2+new")
    updater.promote(tmp_path, old)
    updater.promote(tmp_path, new)
    pointer = tmp_path / "releases" / "latest.json"
    pointer.write_text(updater.canonical_json(updater.latest_pointer(old["version"])), encoding="utf-8")
    assert updater.promote(tmp_path, new)
    assert json.loads(pointer.read_text())["version"] == new["version"]


def test_parse_args_and_main_check(tmp_path, capsys):
    (tmp_path / "releases").mkdir()
    updater.promote(tmp_path, valid_exact())
    write_vendor_lock(tmp_path)
    args = updater.parse_args(["--repo", str(tmp_path), "--check"])
    assert args.check and args.repo == tmp_path
    assert updater.main(["--repo", str(tmp_path), "--check"]) == 0
    assert "are valid" in capsys.readouterr().out


def test_main_reports_deferred_manual_and_failure(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(updater, "validate_local", lambda _repo: None)
    cases = [
        (updater.IncompleteRelease("partial"), 0, "deferred"),
        (updater.ManualReviewRequired("drift"), 2, "manual review"),
        (updater.SupplyChainError("bad"), 1, "update failed"),
    ]
    for error, code, text in cases:
        monkeypatch.setattr(updater, "discover", lambda *_args, exc=error, **_kwargs: (_ for _ in ()).throw(exc))
        assert updater.main(["--repo", str(tmp_path)], downloader=FakeDownloader({})) == code
        assert text in capsys.readouterr().err


def test_main_discovers_and_promotes(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(updater, "validate_local", lambda _repo: None)
    monkeypatch.setattr(updater, "discover", lambda *_args, **_kwargs: valid_exact())
    monkeypatch.setattr(updater, "promote", lambda *_args, **_kwargs: True)
    assert updater.main(["--repo", str(tmp_path), "--dry-run"], downloader=FakeDownloader({})) == 0
    assert "would update" in capsys.readouterr().out
