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
   manifest, downloads core into `.part`, hashes it through vendored pure Lua,
   and extracts it into a staging directory.
5. The core `moon.mod` version must exactly match the toolchain. The staged core
   is moved into place, `moonx` is constructed, permissions are repaired on
   Unix, and both official core bundle commands run with the versioned
   `MOON_HOME`.
6. `EnvKeys` returns only `PATH` and `MOON_HOME`.

Git is declared both as a mise-managed hook dependency (`depends`) and as a
host executable prerequisite (`systemDependencies`). Runtimes predating the
system-dependency preflight still receive the same actionable hard failure from
`PostInstall`.

The runtime adapter also normalizes the two real vfox extraction/context
shapes: standalone vfox 0.4 identifies the main SDK root through
`ctx.sdkInfo.moonbit.path` and may strip a single archive root, while mise
provides the install root directly and preserves `core/`. Only the verified
`stage/core/moon.mod` and `stage/moon.mod` layouts are accepted.

The additional-file hook is not used because mise and standalone vfox have had
different handling semantics for additional archives. Core installation is a
single explicit transaction under `PostInstall` instead.

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
