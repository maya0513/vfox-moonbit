from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import check_repository

REPO = Path(__file__).resolve().parents[2]


def test_current_repository_policy_is_valid():
    check_repository.validate(REPO)


def test_owner_checks_metadata_config_and_placeholders(tmp_path):
    shutil.copytree(REPO / "lib", tmp_path / "lib")
    shutil.copy(REPO / "metadata.lua", tmp_path / "metadata.lua")
    check_repository.check_owner(tmp_path)

    metadata = tmp_path / "metadata.lua"
    original = metadata.read_text(encoding="utf-8")
    metadata.write_text(original.replace("maya0513/vfox-moonbit", "other/vfox-moonbit", 1), encoding="utf-8")
    with pytest.raises(check_repository.RepositoryError, match="homepage"):
        check_repository.check_owner(tmp_path)

    metadata.write_text(
        original.replace('PLUGIN.license = "Apache-2.0"', 'PLUGIN.license = "custom"'), encoding="utf-8"
    )
    with pytest.raises(check_repository.RepositoryError, match="SPDX"):
        check_repository.check_owner(tmp_path)

    metadata.write_text(original.replace("releases/download/manifest", "wrong/manifest"), encoding="utf-8")
    with pytest.raises(check_repository.RepositoryError, match="manifestUrl"):
        check_repository.check_owner(tmp_path)

    metadata.write_text(original, encoding="utf-8")
    config = tmp_path / "lib" / "moonbit_config.lua"
    config.write_text(
        config.read_text(encoding="utf-8").replace('owner = "maya0513"', 'owner = "wrong"'), encoding="utf-8"
    )
    with pytest.raises(check_repository.RepositoryError, match="repository owner"):
        check_repository.check_owner(tmp_path)

    shutil.copy(REPO / "lib" / "moonbit_config.lua", config)
    (tmp_path / ".mise").mkdir()
    (tmp_path / ".mise" / "generated.txt").write_text("<" + "owner>/vfox-moonbit", encoding="utf-8")
    check_repository.check_owner(tmp_path)
    (tmp_path / "README.md").write_text("publish at " + "<" + "owner>/vfox-moonbit", encoding="utf-8")
    with pytest.raises(check_repository.RepositoryError, match="placeholder"):
        check_repository.check_owner(tmp_path)


def test_release_policy_rejects_non_json_and_large_files(monkeypatch, tmp_path):
    release_dir = tmp_path / "releases"
    release_dir.mkdir()
    monkeypatch.setattr(check_repository.update_latest, "validate_local", lambda _repo: None)
    unexpected = release_dir / "binary.zip"
    unexpected.write_bytes(b"x")
    with pytest.raises(check_repository.RepositoryError, match="JSON manifests only"):
        check_repository.check_release_policy(tmp_path)

    unexpected.unlink()
    large = release_dir / "large.json"
    large.write_bytes(b"x" * (1024 * 1024 + 1))
    with pytest.raises(check_repository.RepositoryError, match="exceeds"):
        check_repository.check_release_policy(tmp_path)


def plugin_code_repo(tmp_path: Path, runtime_text: str) -> Path:
    (tmp_path / "hooks").mkdir()
    (tmp_path / "lib").mkdir()
    (tmp_path / "metadata.lua").write_text("PLUGIN = {}", encoding="utf-8")
    (tmp_path / "hooks" / "available.lua").write_text(runtime_text, encoding="utf-8")
    (tmp_path / "lib" / "moonbit_runtime.lua").write_text("return {}", encoding="utf-8")
    return tmp_path


@pytest.mark.parametrize(
    ("runtime_text", "message"),
    [
        ("return { addition = {} }", "addition archives"),
        ("os.execute('moonup install')", "moonup"),
        ("os.execute('moon upgrade')", "moon upgrade"),
    ],
)
def test_plugin_code_forbids_overlapping_managers(tmp_path, runtime_text, message):
    with pytest.raises(check_repository.RepositoryError, match=message):
        check_repository.check_plugin_code(plugin_code_repo(tmp_path, runtime_text))


def test_plugin_code_allows_metadata_warning(tmp_path):
    repo = plugin_code_repo(tmp_path, "return {}")
    (repo / "metadata.lua").write_text("-- Do not run moon upgrade; moonup is not used.", encoding="utf-8")
    check_repository.check_plugin_code(repo)


def test_action_pins_and_missing_workflows(tmp_path):
    workflows = tmp_path / ".github" / "workflows"
    workflows.mkdir(parents=True)
    with pytest.raises(check_repository.RepositoryError, match="no GitHub Actions"):
        check_repository.check_actions(tmp_path)
    workflow = workflows / "ci.yml"
    workflow.write_text("steps:\n  - uses: ./local\n  - uses: actions/checkout@v6\n", encoding="utf-8")
    with pytest.raises(check_repository.RepositoryError, match="not pinned"):
        check_repository.check_actions(tmp_path)
    workflow.write_text("steps:\n  - uses: ./local\n  - uses: actions/checkout@" + "a" * 40 + "\n", encoding="utf-8")
    check_repository.check_actions(tmp_path)


@pytest.mark.parametrize(
    ("output", "returncode", "expected"),
    [
        ("https://github.com/maya0513/vfox-moonbit.git\n", 0, "maya0513/vfox-moonbit"),
        ("git@github.com:maya0513/vfox-moonbit.git\n", 0, "maya0513/vfox-moonbit"),
        ("https://example.test/repo\n", 0, ""),
        ("", 1, None),
    ],
)
def test_origin_slug(monkeypatch, output, returncode, expected):
    monkeypatch.setattr(
        check_repository.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=output, returncode=returncode),
    )
    assert check_repository.origin_slug(REPO) == expected


def test_validate_origin_policy(monkeypatch):
    for name in ("check_owner", "check_release_policy", "check_plugin_code", "check_actions"):
        monkeypatch.setattr(check_repository, name, lambda _repo: None)
    monkeypatch.setattr(check_repository, "origin_slug", lambda _repo: None)
    with pytest.raises(check_repository.RepositoryError, match="required"):
        check_repository.validate(REPO, require_origin=True)
    monkeypatch.setattr(check_repository, "origin_slug", lambda _repo: "wrong/repository")
    with pytest.raises(check_repository.RepositoryError, match="remote origin"):
        check_repository.validate(REPO)
    monkeypatch.setattr(check_repository, "origin_slug", lambda _repo: check_repository.EXPECTED_REPOSITORY)
    check_repository.validate(REPO, require_origin=True)


def test_main_success_and_failure(monkeypatch, capsys):
    monkeypatch.setattr(check_repository, "validate", lambda *_args, **_kwargs: None)
    assert check_repository.main(["--repo", str(REPO), "--require-origin"]) == 0
    assert check_repository.EXPECTED_REPOSITORY in capsys.readouterr().out

    def fail(*_args, **_kwargs):
        raise check_repository.RepositoryError("broken")

    monkeypatch.setattr(check_repository, "validate", fail)
    assert check_repository.main(["--repo", str(REPO)]) == 1
    assert "repository check failed" in capsys.readouterr().out
