# vfox-moonbit

[日本語](README.ja.md)

A security-focused [vfox](https://vfox.dev/) plugin for the latest stable
[MoonBit](https://www.moonbitlang.com/) toolchain. It works through standalone
vfox and mise's traditional vfox backend.

MoonBit is still pre-1.0. This plugin intentionally exposes one channel only:
`latest`. It does not list historical, nightly, or development releases and it
does not accept ranges or partial versions. At installation time, `latest`
resolves to an exact `0.x.y+build-id`; that exact value is accepted later for a
mise lockfile or a reproducible retry.

## Install with mise

Git must already be available on `PATH`. Put this in `mise.toml`:

```toml
[tools]
"vfox:maya0513/vfox-moonbit" = "latest"
```

Then run:

```shell
mise install
mise exec -- moon version --all --json --no-path
```

The initial compatibility floor is mise 2026.5.12.

## Install with standalone vfox

Until the plugin is accepted into the public vfox registry, install its release
archive directly. Replace `0.1.0` with the current plugin release version:

```shell
vfox add --source https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.0/vfox-moonbit-0.1.0.zip moonbit
vfox install --yes moonbit@latest
vfox exec moonbit@latest -- moon version --all --json --no-path
```

`vfox exec` requires vfox 1.0 or newer. With the compatibility-floor vfox
0.4.0, activate a vfox-enabled shell and use `vfox use moonbit@latest` instead.

## What is installed

MoonBit publishes a platform toolchain and a matching `core` standard-library
archive for each stable build. The plugin treats them as one release:

- the toolchain comes from MoonBit's official CDN and is verified with the
  official SHA-256 file;
- the updater verifies that latest and exact core archives are byte-identical,
  then records their SHA-256 in an immutable exact manifest;
- installation refetches that exact manifest, streams core to a `.part` file,
  verifies it before extraction, checks `core/moon.mod`, and runs the two bundle
  commands used by MoonBit's official installers;
- `PATH` points to `<install-root>/bin` and `MOON_HOME` points to the exact
  install root.

The plugin never mirrors or redistributes MoonBit binaries. A historical exact
manifest remains in this repository, but reinstalling it is not guaranteed if
MoonBit removes the corresponding CDN objects.

This project does not execute or query `moonup`, `setup-moonup`,
`moonbit-version`, `moonbit-binaries`, or any moonup distribution service.
moonup is only a design reference; its version-manager, shim, and distribution
responsibilities overlap with mise/vfox.

## Supported hosts

| Host | Toolchain | Core |
| --- | --- | --- |
| Linux x86_64, glibc | `tar.gz` | `tar.gz` |
| Linux arm64, glibc | `tar.gz` | `tar.gz` |
| macOS arm64 | `tar.gz` | `tar.gz` |
| Windows x86_64 | `zip` | `zip` |

macOS Intel, Windows ARM64 emulation, 32-bit hosts, musl/Alpine, and other
operating systems are rejected explicitly. NixOS is best-effort only when the
official glibc-linked ELF binaries can run, for example through a correctly
configured `nix-ld`; it is not a supported test target.

Git is required by MoonBit. Native targets may also need the platform tools and
libraries required by the selected MoonBit backend; those are outside this
plugin's scope.

## State, login, and editors

The plugin does not write `~/.moon`, shell startup files, or credentials.
MoonBit's authentication, package index, and caches live under the versioned
`MOON_HOME`, so after an upgrade you may need to run `moon login` again. This
is deliberate isolation: credentials are not copied between toolchain roots.

Start an editor from the managed environment so its LSP resolves the same
toolchain and core:

```shell
mise exec -- code .
# or, in an activated vfox shell
code .
```

Do not run `moon upgrade` inside an installation managed by this plugin. It can
mutate files behind mise/vfox's back. Update through mise or vfox instead.

## Freshness and cache

The updater polls every six hours and promotes a release only after every
supported artifact is complete and consistent. vfox caches Available results
for up to 12 hours by default, so the normal upper-bound target is roughly 18
hours plus CI time after upstream finishes publishing.

For immediate refresh:

```shell
mise cache clear
vfox config cache.availableHookDuration 0
vfox search moonbit
```

Restore the vfox default afterward with:

```shell
vfox config cache.availableHookDuration 12h
```

## Development

All developer tools are pinned by `mise.toml`, `mise.lock`, `uv.lock`, and
`lua-rocks.lock`:

```shell
mise install
mise run bootstrap
mise run ci
mise run e2e
```

`mise run ci` checks formatting, lint, workflow security, Lua 5.1/5.4 unit
tests, manifest invariants, and line/branch coverage. CI runs real downloads and
MoonBit fixture projects on every supported host through both mise and
standalone vfox. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

The plugin is licensed under Apache-2.0. MoonBit itself is downloaded directly
from its publisher and is not redistributed or relicensed here. The vendored
MIT component is listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
