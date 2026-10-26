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

Each CI job explicitly installs its required tools from the lock. `MISE_AUTO_INSTALL=false` disables automatic installation through shims and task startup.

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
| `mise run update:lua` | Refresh compatible Lua rocks and their verified hashes |

## Pull request and main CI

[`ci.yml`](../.github/workflows/ci.yml) runs for pull requests, pushes to `main`, and manual dispatches. Starting a new run cancels an older run for the same pull request or ref.

| Job | Environment | Responsibility |
| --- | --- | --- |
| `quality` | Ubuntu 24.04 x86_64 | Exact-manifest immutability, vulnerability review of dependency changes in the PR, all development-tool locks, and `pnpm vp run ci` |
| `dependency_artifacts` | Ubuntu 24.04 x86_64 | Validates selected mise locks and the synchronized Vite+ dependency graph without secrets or writes |
| `mise-e2e` | Ubuntu x86_64 / arm64, macOS arm64, Windows x86_64 | Downloads, installs, and activates official MoonBit through mise, then exercises a fixture project |
| `vfox-e2e` | Ubuntu x86_64 / arm64, macOS arm64, Windows x86_64 | Performs the same real-download checks through standalone vfox |
| `required` | Ubuntu 24.04 x86_64 | Reduces the results of the four groups above to one required result |

For pull requests, `quality` fails if a `releases/<exact-version>.json` file already present on `main` is modified. A new exact manifest and `releases/latest.json` may be added or updated, but a published exact record is immutable.

The repository ruleset treats `required` as the required check. This aggregation keeps the merge condition stable when individual matrix jobs are added or renamed.

## Version locks and latest-mise verification

mise tools use exact declarations. Ordinary installations reuse the recorded dependency graph and checksums.

- Node, pnpm, Lua, LuaRocks, and workflow inspection tools use exact versions in `mise.toml` and pins in `mise.lock`.
- Node dependencies use compatibility ranges in `package.json`; `pnpm-lock.yaml` pins them and their transitive dependencies.
- Lua test dependencies use update series specified in `scripts/lua-rocks.sh`; `lua-rocks.lock` pins versions and source hashes.

mise installs Node and pnpm. `engines.node` and `packageManager` in `package.json` declare the same exact versions for Renovate, and CI checks declarations, locks, and executable versions. `pmOnFail: error` rejects an executable that does not match the declaration. The pnpm lockfile also records the selected package-manager dependencies; mise supplies the executable. Lua stays on 5.1; Node type definitions follow the runtime major.

mise itself is deliberately unpinned to verify compatibility with its latest stable release. Locally owned mise installation steps explicitly set mise-action's `minimum_release_age: "0s"` and `cache: false`, selecting the latest stable release without a publication-age delay. The Action code itself remains pinned to a commit SHA.

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

[Renovate configuration](../renovate.json) inherits the shared default and Vite+ presets from maya0513/renovate-config. Renovate proposes updates on Tuesdays in Asia/Tokyo after a seven-day release-age check. Non-major updates and lock maintenance may auto-merge after required CI and any required CODEOWNERS approval; major updates, runner changes, and shared-workflow revisions require manual review. This is an update window, not a guarantee of a single PR or a precise execution time.

Renovate selects npm, mise, and GitHub Action versions. Node and pnpm declarations in mise and package.json are grouped by tool. The shared mise-pnpm preset disables Renovate's own mise artifact generation and lock maintenance, leaving mise locks to the shared mise preparation action. The independent Vite+ preset delegates derived declarations to the Vite+ preparation action. Native npm artifact generation stays enabled for pnpm updates, including its package-manager lock document. Actions remain pinned by full-length commit SHA, with a version comment; the approved shared actions and publishing workflow use the same SHA with a `# main` comment. The minimum supported mise and vfox runtime versions are reviewed separately.

[`update-dependencies.yml`](../.github/workflows/update-dependencies.yml) composes three shared actions in one preparation job: `mise-pnpm` prepares mise locks and Node/pnpm, `pnpm-viteplus` synchronizes coverage, Vitest overrides and the Vite core alias with the selected Vite+, and `pnpm-outputs` validates the complete result. Each component passes its state to the next; verification mode is inherited. Preparation runs only for Mend Renovate pushes to `renovate/` branches and receives no App credentials. It does not select a newer Vite+ or run the former broad tooling updater. Independent updates of bundled packages are disabled; security fixes not yet available through Vite+ need manual handling.

The separate publishing job calls `publish-pnpm-artifacts.yml` with the validated base, changed flag and immutable artifact ID. It explicitly authorizes mise and Vite+ artifacts and receives the existing App credentials only there. The publisher checks the patch and pushes at most one follow-up commit with a lease against the original SHA. App pushes do not repeat generation; pull-request CI validates their latest SHA.

CI composes the same three actions in verify-only mode without App secrets and includes their result in `required`. Both callers use identical groups: Conda GCC/Lua/LuaRocks on Linux x64/arm64, and other tools on Linux x64/arm64, macOS arm64 and Windows x64. Conda validation installs the recorded graph without re-solving it; other tools are regenerated from their selected exact versions. Configuration checks reject omitted or duplicate tools, incomplete platform coverage, mixed shared revisions, disconnected states and publishing outputs, and credentials in preparation.

The Vite+ preset is named `viteplus`. Presets follow shared `main`; all shared action and workflow implementations are pinned together to a reviewed full-length SHA. The generated `pnpm-workspace.yaml` is excluded from formatting because shared synchronization owns its scalar formatting. Repository checks parse YAML and validate the store, overrides and peer policy regardless of scalar quote style.

Renovate also refreshes npm locks within declared ranges. pnpm has no additional cooldown configured here: Renovate's seven-day check does not guarantee the age of every transitive dependency or lock-maintenance update. Dependency review and frozen installation remain required. `renovate/artifacts` is diagnostic, not a required check for ordinary PRs.

Lock records contain only the platforms assigned to each group; CI rejects out-of-group entries.

## Updating Lua test dependencies

[`update-lua-rocks.yml`](../.github/workflows/update-lua-rocks.yml) runs every Monday at 03:30 JST and on manual dispatch. `mise run update:lua` updates only Lua rocks within the Busted 2, LuaCov 0.16 and Luacheck 1 series, recording versions, rockspec SHA-256 values and extracted source-tree SHA-256 values. Changed content for an already locked version stops the update.

The workflow prepares only Node, GCC, Lua and LuaRocks with `mise install --locked`. It uses `--skip-tools` at task startup to prevent unrelated automatic tool installation from changing `mise.lock`.

Only `lua-rocks.lock` may change. Updates use the single `automation/lua-rocks` branch and a weekly PR for manual review. npm, mise and workflow changes are rejected. The MoonBit daily updater remains independent of Renovate.

## Releasing the plugin

[`release.yml`](../.github/workflows/release.yml) runs when a `v*.*.*` tag is pushed. The tag is the plugin's own SemVer from `metadata.lua`, not the MoonBit version.

The workflow verifies the source again, checks the repository owner, and builds a ZIP and SHA-256 file whose bytes are reproducible from the same inputs. It creates a GitHub artifact attestation, publishes the ZIP and checksum to a GitHub Release named after the tag, and updates `manifest.json` in the `manifest` release to the new plugin version. Updating only the MoonBit latest manifest does not create a plugin release.

Before release, merge a pull request that updates the version in `metadata.lua` and the README download URLs to the same value, then confirm that `required` passes on `main`. Tagging that commit lets the release workflow perform the complete verification and publication process.

## Permissions and repository settings

Workflows set their default permissions to read-only or empty and grant only the permissions required by each job. Checkout does not persist credentials. A short-lived token from the repository-specific GitHub App is used only when the MoonBit and Lua updaters manipulate branches and pull requests; dependency artifact publication uses a Contents-only token in a separate job.

The repository requires the following Actions configuration:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `MOONBIT_UPDATER_CLIENT_ID` | Client ID of the repository-specific GitHub App |
| Secret | `MOONBIT_UPDATER_PRIVATE_KEY` | Private key used to mint an App token |
| Repository setting | Dependency graph | Required for the pull-request dependency review; enable under Settings → Advanced Security |
| Repository setting | Allow auto-merge | Squash-merges eligible MoonBit and Renovate PRs after required checks and approvals |
| Ruleset | Required check `required` | Prevents merging when any CI group fails |

Install the repository-specific GitHub App with Metadata read, Contents write and Pull requests write, without a ruleset bypass. Workflows write is no longer requested: Renovate's own App updates Action pins. The shared artifact publisher requests only Contents write; PR validation receives no App credentials. Issue creation, workflow-history inspection and releases use the relevant workflow's restricted GITHUB_TOKEN.

After deployment, manually run Update Lua test dependencies and inspect any resulting PR. On a real Renovate update, confirm that artifact synchronization produces no unrelated diff and that CI runs on the latest follow-up commit. Existing CODEOWNERS approval, required checks and up-to-date branch rules remain in force.

## Investigating failures

| Symptom | First place to inspect |
| --- | --- |
| Only `quality` fails | The failed Vite Task, formatting diff, coverage report, and repository or documentation checker |
| E2E fails on one operating system | Official archive for that platform, PowerShell or shell log, installation-root containment, and `MOON_HOME` assertions |
| Every E2E job fails together | Official CDN, latest manifest, or a shared mise/vfox change |
| Only `required` appears to fail | One of its four dependency groups that failed or was cancelled |
| Updater creates no change | Output of `Discover a complete upstream release`; an incomplete publication is deferred successfully |
| Updater exits with code 2 | Manual-review PR and issue for installer, recipe, layout, schema, or major-version drift |
| Dependency artifacts fail | Node/pnpm declaration mismatch, missing platforms, stale locks, coverage/Vitest mismatch, or a bundled Vitest major change; regenerate from the selected versions |
| Lua updater fails | Changed content at an existing rock version, incompatible Lua dependencies, a change outside lua-rocks.lock, or a branch conflict |
| Release fails | Tag, `metadata.lua` version, origin URL, deterministic CI, and attestation permissions |

For a transient Renovate artifact-generation failure, find the Update dependency artifacts run for the PR's latest commit and rerun it with `gh run rerun <run-id> --failed`. Fix declaration or main-branch conflicts first, then request a Renovate refresh using the PR body's rebase/retry checkbox. Wait for `required` to pass on the latest follow-up SHA before merging. A bundled Vitest major change or altered content at a published Lua rock version requires manual review, not repeated retries.

Before rerunning a failure, run `pnpm vp run ci` locally at the same commit. Use a GitHub Actions rerun only for a credible transient external-service failure; address reproducible failures in a corrective pull request.
