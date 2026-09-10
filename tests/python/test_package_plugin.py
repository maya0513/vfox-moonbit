from __future__ import annotations

import hashlib
import json
import os
import shutil
import zipfile
from pathlib import Path

import pytest

from scripts import package_plugin

REPO = Path(__file__).resolve().parents[2]


def copy_release_source(destination: Path) -> Path:
    for source in package_plugin.release_files(REPO):
        target = destination / source.relative_to(REPO)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    return destination


def test_parse_metadata_reads_required_fields_and_lists():
    metadata = package_plugin.parse_metadata(REPO / "metadata.lua")
    assert metadata["name"] == "moonbit"
    assert metadata["version"] == "0.1.0"
    assert metadata["depends"] == ["git"]
    assert metadata["legacyFilenames"] == []
    assert len(metadata["notes"]) == 2


def test_build_is_deterministic_and_complete(tmp_path):
    first = package_plugin.build(REPO, tmp_path / "first")
    second = package_plugin.build(REPO, tmp_path / "second", "0.1.0")
    assert first[0].read_bytes() == second[0].read_bytes()

    digest = hashlib.sha256(first[0].read_bytes()).hexdigest()
    assert first[1].read_text(encoding="ascii") == f"{digest}  vfox-moonbit-0.1.0.zip\n"
    manifest = json.loads(first[2].read_text(encoding="utf-8"))
    assert manifest["downloadUrl"].endswith("/v0.1.0/vfox-moonbit-0.1.0.zip")
    assert manifest["minRuntimeVersion"] == "1.0.12"

    with zipfile.ZipFile(first[0]) as archive:
        assert archive.namelist() == sorted(archive.namelist())
        assert "metadata.lua" in archive.namelist()
        assert "hooks/post_install.lua" in archive.namelist()
        assert "lib/sha2.lua" in archive.namelist()
        assert "lib/moonbit_sha256_portable.lua" in archive.namelist()
        assert "lib/moonbit_toolchain.lua" in archive.namelist()
        assert "releases/latest.json" not in archive.namelist()
        for info in archive.infolist():
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert (info.external_attr >> 16) & 0o777 == 0o644


@pytest.mark.parametrize("version", ["v1.2.3", "1.2", "01.2.3", "1.2.3-beta"])
def test_build_rejects_invalid_version(tmp_path, version):
    with pytest.raises(package_plugin.PackageError, match="not SemVer"):
        package_plugin.build(REPO, tmp_path, version)


def test_build_rejects_tag_metadata_mismatch(tmp_path):
    with pytest.raises(package_plugin.PackageError, match="does not match"):
        package_plugin.build(REPO, tmp_path, "1.2.3")


def test_parse_metadata_rejects_read_missing_and_wrong_name(tmp_path):
    with pytest.raises(package_plugin.PackageError, match="cannot read"):
        package_plugin.parse_metadata(tmp_path / "missing.lua")

    metadata = tmp_path / "metadata.lua"
    metadata.write_text('PLUGIN.name = "moonbit"\n', encoding="utf-8")
    with pytest.raises(package_plugin.PackageError, match="missing fields"):
        package_plugin.parse_metadata(metadata)

    text = (
        (REPO / "metadata.lua").read_text(encoding="utf-8").replace('PLUGIN.name = "moonbit"', 'PLUGIN.name = "wrong"')
    )
    metadata.write_text(text, encoding="utf-8")
    with pytest.raises(package_plugin.PackageError, match="must name"):
        package_plugin.parse_metadata(metadata)


def test_build_rejects_wrong_homepage(tmp_path):
    source = copy_release_source(tmp_path / "source")
    metadata = source / "metadata.lua"
    metadata.write_text(
        metadata.read_text(encoding="utf-8").replace(
            "https://github.com/maya0513/vfox-moonbit", "https://example.test/wrong"
        ),
        encoding="utf-8",
    )
    with pytest.raises(package_plugin.PackageError, match="homepage"):
        package_plugin.build(source, tmp_path / "dist")


def test_release_files_rejects_missing_required_and_symlink(tmp_path):
    source = copy_release_source(tmp_path / "source")
    (source / "LICENSE").unlink()
    with pytest.raises(package_plugin.PackageError, match="missing"):
        package_plugin.release_files(source)

    source = copy_release_source(tmp_path / "source-two")
    (source / "hooks" / "available.lua").unlink()
    with pytest.raises(package_plugin.PackageError, match="required hook"):
        package_plugin.release_files(source)

    source = copy_release_source(tmp_path / "source-three")
    readme = source / "README.md"
    readme.unlink()
    try:
        readme.symlink_to(source / "README.ja.md")
    except OSError:
        pytest.skip("symlinks are unavailable on this host")
    with pytest.raises(package_plugin.PackageError, match="symlink"):
        package_plugin.release_files(source)


def test_zip_info_and_canonical_json():
    info = package_plugin.zip_info("file")
    assert info.filename == "file"
    assert info.compress_type == zipfile.ZIP_DEFLATED
    assert package_plugin.canonical_json({"b": 1, "a": 2}) == '{\n  "a": 2,\n  "b": 1\n}\n'


def test_main_success_and_error(tmp_path, capsys):
    assert package_plugin.main(["--repo", str(REPO), "--output", str(tmp_path / "dist")]) == 0
    assert "manifest.json" in capsys.readouterr().out
    assert package_plugin.main(["--repo", str(REPO), "--output", str(tmp_path), "--version", "bad"]) == 1
    assert "package failed:" in capsys.readouterr().out


def test_release_files_rejects_missing_vendor_module(tmp_path):
    source = copy_release_source(tmp_path / "source")
    (source / "lib" / "sha2.lua").unlink()
    with pytest.raises(package_plugin.PackageError, match="vendored SHA"):
        package_plugin.release_files(source)


def test_build_default_output_argument_parsing(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    args = package_plugin.parse_args(["--repo", str(REPO)])
    assert args.output == Path("dist")
    assert args.version is None
    assert os.fspath(args.repo) == str(REPO)
