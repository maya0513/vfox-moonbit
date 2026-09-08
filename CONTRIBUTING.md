# Contributing

## Local checks

Install the pinned toolset with mise, then bootstrap locked Python and Lua test
dependencies:

```shell
mise install
mise run bootstrap
mise run ci
```

The repository currently requires and verifies mise 2026.9.2 and vfox 1.0.12.
They are moving tested baselines rather than maximum versions; update the
configuration, lockfile, workflows, documentation, and metadata together when
advancing either manager.

Run the networked mise E2E separately with `mise run e2e`. Standalone vfox
writes its own manager state under the current user's home, so that backend is
run by GitHub-hosted ephemeral workers. To opt in locally, run:

```shell
python scripts/e2e.py --backend vfox --allow-vfox-user-state
```

The tests set an isolated mutable `MOON_HOME` and assert that the real
`~/.moon` is unchanged.

## Release manifests

Do not edit an existing `releases/<exact-version>.json`. Run
`mise run update:check` for an offline validation or
`python scripts/update_latest.py --dry-run` for a networked discovery without
writes. The scheduled workflow is the normal path for updates.

If the installer recipe, archive layout, version schema, or major version
changes, update the recipe only after manual review and tests. Never add
MoonBit archives to the repository.

## Plugin releases

Plugin code follows SemVer independently from MoonBit. Update
`PLUGIN.version` in `metadata.lua`, merge it through normal review, and push a
matching `vX.Y.Z` tag. The release workflow builds a deterministic ZIP,
checksum, manifest, and GitHub artifact attestation. A release-manifest-only
MoonBit update does not create a plugin release.
