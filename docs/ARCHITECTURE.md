# Architecture

This document describes the guarantees enforced by the current tests and implementation. When changing the design, define the specification through tests first, bring the implementation into alignment, then reflect the result here.

## Public contract

The only channel exposed through vfox is `latest`. `Available` fetches `releases/latest.json` and returns an exact version in `0.x.y+build-id` form. `PreInstall` accepts only `latest` or an exact version and returns the official toolchain URL and SHA-256 from the corresponding immutable manifest.

This document calls a manifest for an exact version an exact manifest. A schema version 1 exact manifest contains `schema`, `recipe`, `version`, and a record for each of these platforms:

- `linux-x86_64`
- `linux-aarch64`
- `darwin-aarch64`
- `windows-x86_64`

Each record contains the `url`, `sha256`, and `format` of both `toolchain` and `core`. A `+` in an HTTP URL path is encoded as `%2B`. Existing exact manifests are immutable. The schema version represents compatibility of the manifest format, while the recipe version represents compatibility of the installation procedure, including bundling and layout.

## Plugin runtime

The distributed plugin runs on Lua 5.1. Hooks remain thin, with responsibilities divided among `lib/moonbit_*.lua` as follows.

| Module | Responsibility |
| --- | --- |
| `moonbit_manifest` | Fetching latest and exact manifests; validating versions, schemas, and canonical CDN URLs |
| `moonbit_platform` | Normalizing the vfox/mise execution context, OS and architecture aliases, paths, and supported hosts |
| `moonbit_encoding` | UTF-16LE, Base64, and PowerShell encoded commands |
| `moonbit_process` | Shell quoting, Lua 5.1/5.4 exit status handling, command execution, and safe filesystem operations |
| `moonbit_runtime` | Runtime adapter integrating platform, process, and encoding operations |
| `moonbit_files` | Streaming copies, byte comparison, I/O for atomic shim creation, and reading `moon.mod` |
| `moonbit_core` | Core validation and the promotion, commit, and rollback transaction |
| `moonbit_prepare` | Permissions, bundling, `moonx`, and LSP/IDE shims |
| `moonbit_toolchain` | Ordering core preparation after toolchain validation |
| `moonbit_installer` | The complete `PostInstall` flow from download through cleanup |

The runtime adapter keeps differences between vfox objects and dependency injection in one place. On Windows, filesystem and bundle operations use UTF-16LE/Base64 PowerShell `-EncodedCommand`; paths are handled inside PowerShell and kept out of the `cmd.exe` command line.

## Installation process

1. `PostInstall` validates the exact version resolved from `latest`, the host, Git, and the toolchain layout.
2. It fetches the exact manifest for that version again. This keeps the toolchain and core on the same version even if `latest` changes after `PreInstall`.
3. It downloads the core archive to a `.part` file inside the installation root and verifies it with pure-Lua SHA-256.
4. It extracts only the verified archive into a staging directory and normalizes the difference in top-level archive handling between vfox and mise into two known layouts.
5. It validates the version in `moon.mod` and the presence of `builtin/moon.pkg`, backs up the existing core, and promotes the staged core.
6. It prepares permissions, bundles, `moonx`, and helper shims. If any step fails, it quarantines the new core and restores the previous core.
7. After success, it removes the backup, staging directory, archive, and temporary bundle home.

Lua 5.1 cannot yield across a `pcall` boundary, so HTTP downloads and archiver calls that may yield remain outside `pcall`. Cleanup is restricted to `.vfox-moonbit-*` paths inside the installation root, and broader recursive deletion is rejected.

## Environment variables

`EnvKeys` returns `PATH=<root>/shims`, `PATH=<root>/bin`, and `MOON_TOOLCHAIN_ROOT=<root>`. Mutable state in `MOON_HOME` belongs to the caller and is not overwritten by hooks.

The current native `moon-lsp` and `moon-ide` binaries also require `MOON_HOME` to locate core. Only for these two commands, a shim sets `MOON_HOME` and `MOON_TOOLCHAIN_ROOT` to the installation root within the helper process. Bundling uses a temporary home isolated from credentials and the registry.

On Unix, `moonx` is a relative symlink to `moon`. On Windows, the plugin first attempts to create a hardlink; only if that fails does it fall back to a streaming copy and verify byte-for-byte equality.

## Updater trust boundary

The TypeScript updater uses downloaded archives only for inspection. It computes the received size and SHA-256 while downloading and always cleans up temporary files used during processing.

It scans every tar/ZIP member without extracting the archive and checks absolute paths, `..`, links that escape the destination, special files such as devices and FIFOs, encrypted ZIP entries, CRC mismatches, name collisions on case-insensitive filesystems, member count, expanded size, and required layout.

After retrieving artifacts for every platform, it checks `latest` again and verifies that it still identifies the release seen at the start. The outcomes and CLI exit codes are:

| State | Treatment | Exit code |
| --- | --- | --- |
| Some platforms have not been published | Defer promotion until the next run | `0` |
| Installer, layout, version schema, or MoonBit 1.0 change detected | Require manual review | `2` |
| Any other error | Fail the run | `1` |

The scheduled GitHub Actions workflow runs once a day. It uses a GitHub App token to create a PR limited to `releases/**`, then enables auto-merge after required CI passes. It never pushes directly to `main` and rejects changes to an existing exact manifest.

## Development and maintenance tools

### Tests

`pnpm vp run coverage` requires 100% line coverage for each first-party Lua runtime file and 100% statements, branches, functions, and lines for each maintenance TypeScript file. The Lua checker uses hit/miss counts as well as reported percentages, so rounding cannot hide missed lines.

Tests use local archive fixtures and injected I/O failures to validate unsafe paths, bounded downloads, cleanup, immutable manifests, and deterministic packages without contacting upstream services. Vendored SHA code and the real-download E2E harness have separate checks.

Large Lua SHA vectors use Busted's standard `#large` tag. The coverage task runs regular tests with line tracing, then only these two cases without tracing, avoiding excessive instrumentation overhead and duplicate tests. A shared runner centralizes Lua startup settings.

### Tool responsibilities

Maintenance TypeScript CLIs run directly through Node 24 type stripping without prior transpilation. Vite Task manages execution order and caching for checks and packaging.

mise installs development tools and prepares the environment. Bootstrapping the project-local Vite+ CLI and updating the tools themselves remain mise tasks; all other tasks are consolidated in Vite Task.

### Dependency version management

Compatibility ranges determine the choices available during updates; locks specify the concrete versions used for ordinary installation. Tools and dependencies use locks appropriate to their ecosystems, with mise itself as the sole exception to prioritize latest-stable compatibility checks.

The Vite core, Vitest runner, and coverage provider must stay aligned with Vite+ and are updated together.

### Configuration and documentation checks

The repository checker validates ownership, approved dependency ranges and workflow references, manifests, and the absence of prohibited Python files. The documentation checker compares documented versions, commands, platforms, environment variables, and local links with the implementation.

## Comparison with moonbit-overlay

The comparison target is [`moonbit-community/moonbit-overlay` commit `3adbe60d`](https://github.com/moonbit-community/moonbit-overlay/tree/3adbe60dcc6c4ee0e862173bb83418ee747d1784) (2026-10-05).

| Aspect | vfox-moonbit | moonbit-overlay |
| --- | --- | --- |
| Management | mise / standalone vfox | Nix flake / overlay |
| Supported platforms | Linux x86_64 / arm64 (glibc), macOS arm64, Windows x86_64 | The flake exposes Linux x86_64 and macOS arm64; each version is exposed only when a hash exists for the target platform |
| Environment application | `EnvKeys` applied through manager shell activation or command environment | Environment applied through a dev shell, profile, or wrapper; the `moon` wrapper sets `PATH` and `MOON_TOOLCHAIN_ROOT` so helpers are discoverable even through `nix run` |
| Version | Stable `latest` and exact versions used for locking | Latest, nightly, dated nightly snapshots, and historical versions from 0.10.0 onward |
| Distribution source | Downloaded directly from the official CDN without redistribution | Hash-pinned archives mirrored to GitHub Releases |
| Installation | Rollback-capable transaction into a mutable installation root | `symlinkJoin` in the immutable Nix store |
| User state | Normal `moon` commands retain the caller's `MOON_HOME` | Normal bundles retain the caller's `MOON_HOME` |
| LSP / IDE | Helper shims override both variables with the installation root | Helper wrappers set `MOON_TOOLCHAIN_ROOT`; `MOON_HOME` retains the caller's value and defaults to the Nix store root only when unset |
| Core bundle | Same `--all` and `wasm-gc --quiet` commands as the official stable installer | Bundles `--all`, `llvm`, and `wasm-gc` with `-v` and without `--quiet` |
| `moonx` | Relative symlink on Unix; hardlink or verified copy on Windows | Relative symlink to `moon` in the Unix package |
| Linux | Leaves the official ELF files unchanged | Uses `autoPatchelfHook` and replaces `tinycc` |
| Project builds | Provides only the toolchain | Provides only the toolchain; project builds and Mooncakes dependency packaging have moved to moon2nix |

The [official Unix installer](https://cli.moonbitlang.com/install/unix.sh) and [PowerShell installer](https://cli.moonbitlang.com/install/powershell.ps1) bundle `--all` and `wasm-gc` for stable releases. LLVM bundling is performed only for nightly releases. This plugin therefore follows the official stable recipe rather than matching the [overlay's unconditional LLVM bundle](https://github.com/moonbit-community/moonbit-overlay/blob/3adbe60dcc6c4ee0e862173bb83418ee747d1784/lib/bundle.nix).

In the same implementation, overlay helpers use `--set-default MOON_HOME` to honor caller-provided values. This plugin retains its overrides of both variables inside helper processes to ensure they use the selected core. Project builds have moved to [moon2nix](https://github.com/moonbit-community/moon2nix).

## Reference implementation

During the design, [moonup](https://github.com/chawyehsu/moonup) was studied as a reference implementation. Whereas moonup provides toolchain acquisition, version selection, and environment switching as an integrated system, this plugin delegates version selection and environment switching to mise/vfox and installs the toolchain and core as a coherent pair.
