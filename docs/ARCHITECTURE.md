# Architecture

## Trust and version model

The public channel is `latest`, but installation always resolves it to one
exact pre-1.0 version matching `0.x.y+build-id`. `releases/latest.json` is a
small mutable pointer; `releases/<exact-version>.json` is immutable. Exact
versions exist for lockfiles and retries, not as a historical catalog.

Schema 1 contains `schema`, `recipe`, `version`, and four platform records.
Each platform has `toolchain` and `core` objects with exactly `url`, `sha256`,
and `format`. A plus sign is encoded as `%2B` in CDN URLs.

The supported keys are:

- `linux-x86_64`
- `linux-aarch64`
- `darwin-aarch64`
- `windows-x86_64`

Schema changes describe metadata compatibility. Recipe changes describe an
installation semantic change, such as different bundle commands or layout.
Either change requires a plugin code review.

## Runtime flow

1. `Available` fetches the latest pointer and returns one exact version.
2. `PreInstall` accepts only `latest` or a strict exact version, validates the
   exact record and host, then returns the official toolchain URL and SHA-256.
3. vfox/mise downloads, verifies, and extracts the toolchain.
4. `PostInstall` checks Git and the toolchain layout, refetches only the exact
   manifest, downloads core into `.part`, hashes it through pure Lua, and
   extracts it into a staging directory. The pinned upstream implementation is
   used on standard Lua; a small derived MIT implementation covers GopherLua's
   non-standard assignment semantics.
5. The core `moon.mod` version must exactly match the toolchain. The staged core
   is moved into place, permissions are repaired on Unix, and both official
   core bundle commands run with `MOON_TOOLCHAIN_ROOT` plus an ephemeral
   `MOON_HOME`. A failure restores the previous core.
6. `moonx` and the `moon-lsp`/`moon-ide` compatibility shims are constructed.
7. `EnvKeys` prepends the shim and binary directories, exports
   `MOON_TOOLCHAIN_ROOT`, and deliberately leaves the caller's mutable
   `MOON_HOME` unchanged.

Git is declared both as a mise-managed hook dependency (`depends`) and as a
host executable prerequisite (`systemDependencies`). Runtimes predating the
system-dependency preflight still receive the same actionable hard failure from
`PostInstall`.

The tested standalone runtime baseline is vfox 1.0.12, and plugin metadata
requires that version or newer. No maximum is imposed: newer compatible vfox
runtimes are expected to work and replace the pinned baseline during routine
toolchain refreshes. The plugin does not fall back to an unverified external
archive command.

The runtime adapter also normalizes the real vfox extraction/context shapes:
standalone vfox identifies the main SDK root through `ctx.sdkInfo.moonbit.path`
and may strip a single archive root, while mise provides the install root
directly and preserves `core/`. Only the verified `stage/core/moon.mod` and
`stage/moon.mod` layouts are accepted.

On Windows, GopherLua launches `os.execute` commands through `cmd.exe`, whose
second round of parsing breaks command strings containing quoted paths. The
adapter therefore sends filesystem, hardlink, and bundle operations through
Windows PowerShell `-EncodedCommand` using UTF-16LE/Base64. Paths never appear
in the outer command line, including paths with spaces, Unicode, or shell
metacharacters.

The additional-file hook is not used because mise and standalone vfox have had
different handling semantics for additional archives. Core installation is a
single explicit transaction under `PostInstall` instead.

## Comparison with moonbit-overlay

This comparison is pinned to
[`moonbit-community/moonbit-overlay` commit `831fa47`](https://github.com/moonbit-community/moonbit-overlay/tree/831fa47147eb8b9878b61d5d658102a699d8ea6b)
so later overlay changes do not silently make the table inaccurate.

| Concern | mise through vfox-moonbit | moonbit-overlay |
| --- | --- | --- |
| Primary role | A traditional vfox plugin selected and installed by mise; it also runs under standalone vfox. | A Nix flake/overlay exposing derivations, apps, and MoonBit project builders. |
| Public versions | Stable `latest` only; an exact upstream version is accepted only for lockfiles and retries. | Stable `latest`, rolling `nightly`, and many historical exact package attributes. |
| Version identity | Uses the exact upstream toolchain/core version, such as `0.x.y+build-id`. | Adds the `moon` source revision to the compiler version, such as `v0.x.y+compiler-rev+moon-rev`. |
| Artifact origin | Downloads toolchain and core from the official MoonBit CDN and never redistributes either. | Uses official rolling URLs while updating, then publishes pinned toolchain/core archives on overlay GitHub Releases; nightly stays on the official CDN. |
| Integrity and pairing | Verifies official toolchain SHA-256, vendored core SHA-256, exact core metadata, and a single version across all supported hosts. | Uses Nix fixed-output hashes for separately fetched toolchain and core derivations and joins the selected pair. |
| Installation model | A mutable manager install directory is populated transactionally; a failed core promotion rolls back. | Toolchain and core are composed with `symlinkJoin` into an immutable Nix store result. |
| `MOON_TOOLCHAIN_ROOT` | Exported as the selected install root for normal commands. | Wrapped into `moon` as the selected Nix store output. |
| `MOON_HOME` | Preserves caller-owned mutable state; only `moon-lsp` and `moon-ide` shims set it to the install root for that process. | Preserves caller-owned state for `moon`; its current `moon-lsp` and `moon-ide` wrappers set both variables to the store output. |
| `moonx` | Relative symlink on Unix; verified hardlink or copy on Windows. | Relative symlink to `moon`. |
| Core bundles | Runs the two official installer bundles: `--all` and quiet `--target wasm-gc`. | Builds `--all`, `--target llvm`, and `--target wasm-gc`, all verbose. |
| Current host records | Linux x86_64/arm64 glibc, macOS arm64, and Windows x86_64. | The pinned records currently contain Linux x86_64 and macOS arm64 hashes; its Nix target mapping also includes macOS x86_64. |
| Linux adaptation | Leaves the official ELF payload unchanged; NixOS is best-effort with `nix-ld` or equivalent. | Applies `autoPatchelfHook` and replaces the bundled Linux `tcc` with nixpkgs `tinycc`. |
| Project builds | Installs only the toolchain; project builds and registries remain MoonBit/mise user concerns. | Provides `buildMoonPackage`, cached-registry support, and a complete bundled `MOON_HOME` builder. |
| Update path | Six-hour gated bot PR; immutable manifests, archive safety checks, installer-drift gates, required CI, then auto-merge. | Daily workflow fetches and executes the staged toolchain to derive a combined version, pushes version data to `master`, and creates mirrored releases. |

The shared environment split is intentional: normal `moon` commands receive
the immutable toolchain through `MOON_TOOLCHAIN_ROOT`, while current native
helpers receive both variables in a process-local shim. Nix-specific patching,
artifact mirroring, historical/nightly channels, the combined version, project
builders, and the LLVM bundle remain outside this plugin's scope.

## Compatibility verification policy

CI verifies one current mise baseline (2026.9.2) and one current standalone
vfox baseline (1.0.12) on every supported host. These are point-in-time tested
versions, not compatibility bounds: newer compatible manager versions are
expected to work, and the pinned versions move forward with routine
development-tool updates. The project intentionally does not spend CI capacity
maintaining older manager versions.

## Automated promotion

The updater downloads but never executes upstream data. It enforces compressed
and expanded size limits, member-count limits, canonical relative paths,
non-escaping links, no device/special files, required layouts, official
toolchain checksum files, exact/latest core byte identity, and one coherent
version across formats. It rechecks latest after all platform downloads to
detect a rollout race.

Official Unix and PowerShell installer digests plus known recipe markers are
pinned separately. Installer/layout drift, a new version schema, or MoonBit 1.0
stops promotion and opens an issue plus a CODEOWNERS-gated manual-review PR.
Partial platform publication is deferred.

The latest-version bot may change only `releases/**`; pull-request CI compares
that directory with the base commit and rejects any change to an existing exact
manifest. All other paths are protected by CODEOWNERS and repository rules.

## moonup boundary

moonup solves version selection, shims, `moonbit-version`, and artifact
distribution. Those responsibilities already belong to mise/vfox plus this
small manifest. No moonup executable, API, setup action, binary repository, or
distribution endpoint is part of the runtime or updater.
