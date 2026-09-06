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

The minimum standalone runtime is vfox 0.5.0. Versions 0.4.0 through 0.4.2
contain the archiver implementation but do not preload it into plugin Lua
states, so secure in-process core extraction is unavailable. The plugin does
not fall back to an unverified external archive command.

The runtime adapter also normalizes the two real vfox extraction/context
shapes: standalone vfox 0.x identifies the main SDK root through
`ctx.sdkInfo.moonbit.path` and may strip a single archive root, while mise
provides the install root directly and preserves `core/`. Only the verified
`stage/core/moon.mod` and `stage/moon.mod` layouts are accepted.

The additional-file hook is not used because mise and standalone vfox have had
different handling semantics for additional archives. Core installation is a
single explicit transaction under `PostInstall` instead.

This environment split follows Moon's package-manager layout and the approach
used by `moonbit-community/moonbit-overlay`: normal `moon` commands receive the
immutable root through `MOON_TOOLCHAIN_ROOT`, while current native helpers are
given both variables in a process-local shim. The overlay's Nix-specific
patchelf, tinycc replacement, artifact mirror, historical/nightly channels,
combined version identifier, and LLVM bundle are intentionally not adopted.

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
