# vfox-moonbit

[日本語](README.ja.md)

This plugin makes the [MoonBit](https://www.moonbitlang.com/) toolchain available through mise (traditional vfox backend) or standalone vfox.

Only `latest` is provided.

## Install

### mise

```shell
mise use 'vfox:maya0513/vfox-moonbit@latest'
moon version
```

Alternatively, add the following configuration to the project's `mise.toml`, then install the toolchain:

```toml
[tools]
"vfox:maya0513/vfox-moonbit" = "latest"
```

```shell
mise install
moon version
```

CI currently tests with mise 2026.9.2.

### Standalone vfox

Add the plugin from its GitHub Release:

```shell
vfox add --source https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.3/vfox-moonbit-0.1.3.zip moonbit
vfox install --yes moonbit@latest
vfox use moonbit@latest
moon version
```

CI currently tests with vfox 1.0.12.

## Supported hosts

| Host | Toolchain | Core |
| --- | --- | --- |
| Linux x86_64, glibc | `tar.gz` | `tar.gz` |
| Linux arm64, glibc | `tar.gz` | `tar.gz` |
| macOS arm64 | `tar.gz` | `tar.gz` |
| Windows x86_64 | `zip` | `zip` |

macOS Intel, Windows ARM64 emulation, 32-bit systems, musl/Alpine, and other operating systems are rejected. NixOS is best-effort when the official glibc-linked ELF files can run, for example through `nix-ld`.

Native MoonBit targets may require platform-specific tools and libraries, which this plugin does not manage. On Windows, installation uses the Windows PowerShell included with the operating system to handle paths safely.

## Environment and mutable state

| Value | Behavior |
| --- | --- |
| `PATH` | Prepends the selected installation's `shims` and `bin` directories. |
| `MOON_TOOLCHAIN_ROOT` | Points to the immutable selected toolchain and core. |
| `MOON_HOME` | Mutable state managed by the caller; the plugin does not export it. |

The current `moon-lsp` and `moon-ide` binaries also consult `MOON_HOME` to locate core, so compatibility shims override it only within those processes. Core bundling also uses an isolated temporary value. Credentials, the package index, and caches remain in the normal `MOON_HOME` (usually `~/.moon`) and persist across toolchain updates.

## Freshness and cache

The updater checks once a day and promotes only releases that are complete and consistent across all supported platforms. vfox caches Available results for up to 12 hours, so the normal update target is up to roughly 36 hours plus CI time after upstream publishing completes.

Refresh the caches if the latest release is unavailable:

```shell
mise cache clear
vfox config cache.availableHookDuration 0
vfox search moonbit
vfox config cache.availableHookDuration 12h
```

## License

The code in this repository is licensed under the MIT License. MoonBit itself is downloaded directly from the official distribution source and is not covered by this repository's license. Third-party code is listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
