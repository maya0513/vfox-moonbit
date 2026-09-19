# Contributing

## Development workflow

Install the locked toolchain and dependencies, then run the same deterministic suite used by GitHub Actions:

```shell
mise install
mise run bootstrap
mise run ci
```

mise 2026.9.2 and vfox 1.0.12 are moving tested versions, not compatibility floors. Advance configuration, lockfiles, workflows, metadata, tests, and documentation together.

Vite+ owns the task graph behind the public mise commands. Cacheable tasks use source/configuration inputs; coverage reports and `dist` are the only restored outputs. Real downloads and mutable manager state are deliberately uncached.

Useful focused commands are:

```shell
mise run fmt:check
mise run lint
mise run test:unit
mise run coverage
mise run docs:check
mise run update:check
mise run package
mise run e2e
```

Run a task twice to inspect a local cache hit. Clear Vite Task results with `pnpm exec vp cache clean`. The cache lives under ignored `node_modules` and is never part of a release archive.

Standalone vfox writes manager state under the current home. GitHub-hosted ephemeral workers run that E2E by default. Explicit local opt-in is:

```shell
pnpm exec vp run e2e:vfox
```

The harness isolates mutable `MOON_HOME` and verifies that the real `~/.moon` is unchanged.

## Release manifests

Existing `releases/<exact-version>.json` files are immutable. Use `mise run update:check` for offline validation. Networked discovery is:

```shell
pnpm exec vp run update:discover
```

The scheduled workflow is the normal promotion path. It stops for manual review when installer markers, archive layout, version schema, recipe, or the MoonBit major version changes. Never add MoonBit archives to this repository.

## Plugin releases

Plugin SemVer is independent of the installed MoonBit version. Its only source of truth is `PLUGIN.version` in `metadata.lua`; the private maintenance package has no separate version.

After a normal reviewed merge and successful main CI:

1. create an annotated `vX.Y.Z` tag matching `PLUGIN.version`;
2. push the tag without rewriting it;
3. let the release workflow run full CI and create the deterministic ZIP, checksum, registry manifest, and artifact attestation;
4. verify the published checksum, attestation, and standalone-vfox install.

A MoonBit manifest-only update does not create a plugin release.
