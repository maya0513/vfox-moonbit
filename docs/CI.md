# CI and automation

This document describes the GitHub Actions that validate pull requests, perform scheduled updates, and publish plugin releases, together with the equivalent local checks. Workflow definitions live in [`.github/workflows`](../.github/workflows), while [`vite.tasks.ts`](../vite.tasks.ts) defines task dependencies and caching.

## Local verification

After activating mise in the shell, run the following commands. The complete suite, including Lua checks, currently requires Linux x86_64.

```shell
mise install --locked
mise run bootstrap
pnpm vp run ci
```

`mise run bootstrap` installs Node dependencies from `pnpm-lock.yaml`, then verifies each Lua rockspec and extracted source tree against the SHA-256 values in `lua-rocks.lock` before building the Lua dependencies. `pnpm vp run ci` combines the following deterministic checks:

- `git diff --check`
- Formatting and static analysis for Lua and TypeScript, plus GitHub Actions validation
- Lua and TypeScript unit tests with coverage enforcement for first-party code
- Documentation, repository-policy, and release-manifest consistency checks
- Reproducibility checks for the plugin package

CI runs formatting, linting, and unit tests with coverage through the `check` task, then adds documentation, manifest, and package validation. The development task `test:unit` runs the same tests without collecting coverage, so CI does not invoke it a second time.

Node formatting checks use `vp fmt --check`; lint and type checks use `vp lint`. Type checking is enabled by `typeCheck: true` in `vite.config.ts`.

Real-download E2E tests use the official CDN and tool-manager state, so they are deliberately separate from `ci`. Run the required backend explicitly:

```shell
pnpm vp run e2e
pnpm vp run e2e:vfox
```

The standalone vfox E2E test uses vfox user state. It normally runs in an ephemeral CI environment; before running it locally, account for its possible effect on existing vfox configuration.

Use these tasks for individual checks and maintenance:

| Command | Purpose |
| --- | --- |
| `pnpm vp run check` | Run formatting, static analysis, tests, and complete coverage together |
| `pnpm vp run fmt:check` / `pnpm vp run lint` | Formatting and static analysis |
| `pnpm vp run test:unit` / `pnpm vp run coverage` | Run unit tests without / with coverage |
| `pnpm vp run docs:check` / `pnpm vp run update:check` | Documentation and release-manifest validation |
| `pnpm vp run package` | Generate the deterministic plugin package |
| `pnpm vp run update:discover` | Discover a complete upstream MoonBit release |
| `mise run update:tooling` | Refresh compatible tool, npm, Lua rock, and GitHub Action locks |

## Pull request and main CI

[`ci.yml`](../.github/workflows/ci.yml) runs for pull requests, pushes to `main`, and manual dispatches. Starting a new run cancels an older run for the same pull request or ref.

| Job | Environment | Responsibility |
| --- | --- | --- |
| `quality` | Ubuntu 24.04 x86_64 | Exact-manifest immutability, vulnerability review of dependency changes in the PR, all development-tool locks, and `pnpm vp run ci` |
| `mise-lock` | Ubuntu 24.04 x86_64 | Confirms that the latest stable mise can resolve `mise.lock` |
| `mise-e2e` | Ubuntu x86_64 / arm64, macOS arm64, Windows x86_64 | Downloads, installs, and activates official MoonBit through mise, then exercises a fixture project |
| `vfox-e2e` | Ubuntu x86_64 / arm64, macOS arm64, Windows x86_64 | Performs the same real-download checks through standalone vfox |
| `required` | Ubuntu 24.04 x86_64 | Reduces the results of the four groups above to one required result |

For pull requests, `quality` fails if a `releases/<exact-version>.json` file already present on `main` is modified. A new exact manifest and `releases/latest.json` may be added or updated, but a published exact record is immutable.

The repository ruleset treats `required` as the required check. This aggregation keeps the merge condition stable when individual matrix jobs are added or renamed.

## Version locks and latest-mise verification

Versions resolved within compatibility ranges are recorded in locks and reused for ordinary installation.

- Node, pnpm, Lua, LuaRocks, and workflow inspection tools use compatibility ranges in `mise.toml` and pins in `mise.lock`.
- Node dependencies use compatibility ranges in `package.json`; `pnpm-lock.yaml` pins them and their transitive dependencies.
- Lua test dependencies use update series specified in `scripts/lua-rocks.sh`; `lua-rocks.lock` pins versions and source hashes.

mise owns installation and updates of pnpm itself; `engines.pnpm` in `package.json` checks the supported series.

mise itself is deliberately unpinned to verify compatibility with its latest stable release. Every workflow explicitly sets mise-action's `minimum_release_age: "0s"` and `cache: false`, selecting the latest stable release without a publication-age delay. The Action code itself remains pinned to a commit SHA.

Each job's `Record mise version` step runs `mise --version` to log the actual version used. A later rerun of the same commit may use a different mise version, so inspect this log when diagnosing failures. This exception prioritizes latest-mise compatibility while retaining development-tool and dependency locks.

## Caching

GitHub Actions caches the pnpm store by operating system, architecture, and the `pnpm-lock.yaml` hash. It does not share dependency packages under `node_modules`; every run executes either `pnpm install --frozen-lockfile` or the bootstrap task.

`quality` also restores `node_modules/.vite/task-cache`. Vite Task fingerprints the declared inputs for each task and reuses checks whose inputs have not changed. Test inputs include source files and the manifests, documentation, workflows, and vendor files read as fixtures. Coverage reports and `dist` are restored as declared task outputs.

E2E tests, upstream discovery, and releases are not cached because they depend on the network or external state. The `ci` task also runs repository-policy validation and `git diff --check` every time because they depend on Git's tracked-file list, remote, and index state, while still reusing caches for its dependency tasks.

A cache hit affects only performance. Without a cache, the same checks can be completed from the locked dependencies.

## Updating MoonBit latest

[`update-latest.yml`](../.github/workflows/update-latest.yml) runs daily at 00:17 UTC (09:17 JST) and on manual dispatch. The updater changes release manifests only after every supported platform provides the same toolchain and core version and all checksums, archive layouts, and installer recipes pass validation.

| Discovery result | Automation behavior |
| --- | --- |
| No change | Exits successfully without creating anything |
| Publication in progress | Defers the update and stores the first observation time in an artifact |
| Publication remains incomplete for 24 hours | Creates one deduplicated maintenance issue |
| A new release is safe to promote | Creates or updates the single `automation/moonbit-latest` PR and enables squash auto-merge |
| Installer, recipe, layout, version schema, or major version changes | Records the finding on `automation/moonbit-manual-review` and creates a manual-review PR and issue |
| Three consecutive workflow failures | Creates one deduplicated incident issue |

A normal updater PR may change only `releases/*.json`. The workflow allowlist rejects deletion of existing release metadata and changes to any other path. The updater never pushes directly to `main`, and a manual-review PR is never auto-merged.

## Updating development tools and dependencies

[`update-tooling.yml`](../.github/workflows/update-tooling.yml) runs every Monday at 03:30 JST (Sunday at 18:30 UTC) and on manual dispatch. `mise run update:tooling` updates mise tools, npm dependencies, the Vite+ package family, Lua test rocks, and GitHub Action locks together within their configured compatibility ranges.

The updater installs Node and pnpm from the refreshed lock and switches to their executable paths before updating npm dependencies.

GitHub Actions are pinned in workflow files by full-length commit SHA, with a trailing `# vN` recording the allowed major. The updater finds the newest stable release tag in that major and updates only the commit SHA. Because runtime execution never follows the moving major tag, upstream tag changes cannot alter CI code without review.

`scripts/lua-rocks.sh` hardcodes updates to the Busted 2, LuaCov 0.16, and Luacheck 1 series. The updater resolves the direct tools and their transitive dependencies, then records each version, upstream rockspec SHA-256, and extracted source-tree SHA-256 in `lua-rocks.lock`. If content changes for an already locked version, the run treats it as an upstream immutability violation and stops.

The peer policy permits only the Vite+ 1 core alias that occupies the `vite` package name; CI rejects every other peer-dependency mismatch.

Only `.github/workflows/*.yml`, `lua-rocks.lock`, `mise.lock`, `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` may change. When a diff exists, the workflow creates or updates the single `automation/maintenance-tooling` PR. This weekly PR is not auto-merged: a maintainer reviews the diff, the successful `required` check, and the dependency-review result before merging.

Changes to major series, allowed Lua rock ranges, and tooling recipes remain outside automation because they require an explicit compatibility decision. They are handled by a separate manual pull request only when needed.

CI failures, urgent vulnerabilities, and upstream specification changes need attention as they occur, so once a week describes normal maintenance. Dependency review covers dependencies recognized by GitHub and published advisories; the hashes in `lua-rocks.lock` verify Lua rock content.

Dependency resolution runs without a write token. The workflow mints its short-lived GitHub App token only after dependency updates and repository-policy checks complete, then uses it to push allowlisted files to the automation branch.

## Releasing the plugin

[`release.yml`](../.github/workflows/release.yml) runs when a `v*.*.*` tag is pushed. The tag is the plugin's own SemVer from `metadata.lua`, not the MoonBit version.

The workflow verifies the source again, checks the repository owner, and builds a ZIP and SHA-256 file whose bytes are reproducible from the same inputs. It creates a GitHub artifact attestation, publishes the ZIP and checksum to a GitHub Release named after the tag, and updates `manifest.json` in the `manifest` release to the new plugin version. Updating only the MoonBit latest manifest does not create a plugin release.

Before release, merge a pull request that updates the version in `metadata.lua` and the README download URLs to the same value, then confirm that `required` passes on `main`. Tagging that commit lets the release workflow perform the complete verification and publication process.

## Permissions and repository settings

Workflows set their default permissions to read-only or empty and grant only the permissions required by each job. Checkout does not persist credentials. A short-lived token from the repository-specific GitHub App is used only when the MoonBit and development-tool updaters manipulate branches and pull requests.

The repository requires the following Actions configuration:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `MOONBIT_UPDATER_CLIENT_ID` | Client ID of the repository-specific GitHub App |
| Secret | `MOONBIT_UPDATER_PRIVATE_KEY` | Private key used to mint an App token |
| Repository setting | Allow auto-merge | Squash-merges a MoonBit latest PR after required CI succeeds |
| Ruleset | Required check `required` | Prevents merging when any CI group fails |

Install the GitHub App on this repository with Metadata read, Contents write, Pull requests write, and Workflows write. Workflows write is used only to update SHA-pinned Actions in the weekly pull request. Issue creation, workflow-history inspection, and release publication use the restricted `GITHUB_TOKEN` of the relevant workflow. Do not grant the App a ruleset bypass.

To enable weekly updates, open the repository-specific App under [GitHub Apps settings](https://github.com/settings/apps), select Permissions & events, set Workflows under Repository permissions to Read and write, and save. Then approve the updated permissions under [Installed GitHub Apps](https://github.com/settings/installations). This is a one-time setup. After merging the workflow into `main`, manually run Update maintenance tools and confirm that it creates one PR and triggers its CI when updates exist.

## Investigating failures

| Symptom | First place to inspect |
| --- | --- |
| Only `quality` fails | The failed Vite Task, formatting diff, coverage report, and repository or documentation checker |
| E2E fails on one operating system | Official archive for that platform, PowerShell or shell log, installation-root containment, and `MOON_HOME` assertions |
| Every E2E job fails together | Official CDN, latest manifest, or a shared mise/vfox change |
| Only `required` appears to fail | One of its four dependency groups that failed or was cancelled |
| Updater creates no change | Output of `Discover a complete upstream release`; an incomplete publication is deferred successfully |
| Updater exits with code 2 | Manual-review PR and issue for installer, recipe, layout, schema, or major-version drift |
| Tooling updater fails | Compatibility ranges, changed content at an existing Lua rock version, Action release tags, a change outside the allowlist, approval of the App's Workflows write permission, or a merge conflict on the automation branch |
| Release fails | Tag, `metadata.lua` version, origin URL, deterministic CI, and attestation permissions |

Before rerunning a failure, run `pnpm vp run ci` locally at the same commit. Use a GitHub Actions rerun only for a credible transient external-service failure; address reproducible failures in a corrective pull request.
