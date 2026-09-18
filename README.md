# vfox-moonbit

[日本語](README.ja.md)

A vfox plugin for the latest stable [MoonBit](https://www.moonbitlang.com/)
toolchain. It works with standalone vfox and mise's traditional vfox backend.

MoonBit is pre-1.0, so this plugin intentionally exposes only `latest`.
Installation resolves it to an exact `0.x.y+build-id`; that exact version is
accepted later for lockfiles and reproducible retries. Historical listings,
ranges, partial versions, nightly, and development channels are out of scope.

## Install

Git must already be on `PATH`.

### mise

```toml
[tools]
"vfox:maya0513/vfox-moonbit" = "latest"
```

```shell
mise install
mise exec -- moon version --all --json --no-path
```

CI currently exercises mise 2026.9.2. This is a moving tested version, not a
compatibility floor or maximum.

### Standalone vfox

Until the plugin enters the public registry, add the release archive directly:

```shell
vfox add --source https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.3/vfox-moonbit-0.1.3.zip moonbit
vfox install --yes moonbit@latest
vfox use moonbit@latest
moon version --all --json --no-path
```

CI currently exercises vfox 1.0.12. `install` and `use` resolve `latest`, but
non-interactive `vfox exec` requires the exact installed version:

```shell
vfox exec moonbit@0.x.y+build-id -- moon version --all --json --no-path
```

Use `moon.exe` in the final command on Windows.

## Installation contract

MoonBit publishes a platform toolchain and matching `core` standard library.
This plugin installs them as one verified release:

- the toolchain comes from the official CDN and uses MoonBit's SHA-256 file;
- the updater records an exact core SHA-256 only after latest and exact core
  archives are byte-identical;
- installation refetches the immutable exact manifest, downloads core to a
  `.part` file, verifies it before extraction, and checks `core/moon.mod`;
- core is promoted transactionally and rolled back if bundle or shim creation
  fails;
- the two bundle commands used by MoonBit's official installers are run with an
  isolated temporary home.

The repository contains only manifests and plugin code. It does not mirror or
redistribute MoonBit archives. Old exact manifests remain, but reinstalling an
old version depends on the corresponding official CDN object still existing.

moonup is a design reference only. This project does not call its executable,
API, setup action, binary repository, or distribution service.

## Supported hosts

| Host | Toolchain | Core |
| --- | --- | --- |
| Linux x86_64, glibc | `tar.gz` | `tar.gz` |
| Linux arm64, glibc | `tar.gz` | `tar.gz` |
| macOS arm64 | `tar.gz` | `tar.gz` |
| Windows x86_64 | `zip` | `zip` |

macOS Intel, Windows ARM64 emulation, 32-bit systems, musl/Alpine, and other
operating systems are rejected. NixOS is best-effort when the official
glibc-linked ELF files can run, for example through `nix-ld`.

Native MoonBit targets may require additional platform tools and libraries.
Those dependencies are outside this plugin's scope. Windows installation uses
the in-box Windows PowerShell for path-safe filesystem and bundle operations.

## Environment and mutable state

| Value | Behavior |
| --- | --- |
| `PATH` | Prepends the selected installation's `shims` and `bin` directories. |
| `MOON_TOOLCHAIN_ROOT` | Points to the immutable selected toolchain and core. |
| `MOON_HOME` | Remains caller-owned mutable state and is not exported by the plugin. |

Current `moon-lsp` and `moon-ide` binaries still consult `MOON_HOME` for core.
Their compatibility shims override it only for the helper process. Core bundle
generation likewise uses a temporary isolated value. Login, package index, and
cache state therefore remain in the caller's normal `MOON_HOME` (usually
`~/.moon`) across toolchain upgrades.

Start editors from the managed environment:

```shell
mise exec -- code .
# or from a vfox-activated shell
code .
```

Do not run `moon upgrade` inside a managed installation. Upgrade through mise
or vfox so the manager remains authoritative.

## Freshness and cache

The updater polls every six hours and promotes only a release that is complete
and coherent on all supported platforms. vfox caches Available results for up
to 12 hours, giving a normal target of roughly 18 hours plus CI time after
upstream publishing completes.

```shell
mise cache clear
vfox config cache.availableHookDuration 0
vfox search moonbit
vfox config cache.availableHookDuration 12h
```

## Development

The development toolchain is locked by mise, pnpm, and LuaRocks. Vite+ owns the
cached task graph; mise provides stable entrypoints and pinned executables.

```shell
mise install
mise run bootstrap
mise run ci
mise run e2e
```

`mise run ci` checks formatting, lint, types, workflows, documentation facts,
unit tests, coverage, manifests, and deterministic packaging. GitHub Actions
adds real-download mise and standalone-vfox E2E on all supported hosts. See
[CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

The plugin is Apache-2.0. MoonBit is downloaded from its publisher and is not
relicensed here. Vendored MIT code is listed in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
