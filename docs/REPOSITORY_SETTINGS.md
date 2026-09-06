# Repository settings

This file records settings that cannot be enforced by files in the repository.
Configure them before enabling scheduled updates or creating the first release.

## Repository

- Repository: public `maya0513/vfox-moonbit` with default branch `main`.
- Enable pull-request auto-merge and squash merging; disable merge commits.
- Enable private vulnerability reporting.
- Keep Actions allowed for this repository. Every external action in the
  workflows is pinned to a full commit SHA.

## Main ruleset

Create a ruleset targeting `main` with no GitHub App bypass:

- require a pull request;
- require conversation resolution;
- require CODEOWNERS approval when a matched path changes;
- require the stable `required` aggregate check, which depends on `quality`,
  mise lock compatibility, and all mise/vfox E2E jobs;
- require branches to be up to date before merge;
- block force pushes and deletion;
- allow squash merge only.

`releases/**` intentionally has no CODEOWNER entry. A bot PR that changes only
those manifests can auto-merge after full CI. Runtime code, executable scripts,
workflows, schemas/recipe inputs, and dependency locks require `@maya0513`.

## MoonBit updater GitHub App

Create a repository-dedicated GitHub App and install it only on this repository.
Grant exactly:

- Metadata: read (mandatory baseline)
- Contents: read and write
- Pull requests: read and write

Do not grant bypass permissions. Store its values as Actions secrets:

- `MOONBIT_UPDATER_APP_ID`
- `MOONBIT_UPDATER_PRIVATE_KEY`

The update workflow uses this installation token for the bot branch and pull
request because pull requests authored by the normal `GITHUB_TOKEN` do not
trigger subsequent workflows. The workflow-scoped `GITHUB_TOKEN`, with Issues
write only, reports maintenance failures; the App itself does not receive Issue
permission.

The updater runs every six hours and on manual dispatch. It force-updates only
`automation/moonbit-latest`, never `main`, keeps one PR, enables squash
auto-merge, and rejects any diff outside `releases/**`. Three consecutive hard
failures create one deduplicated issue. Consecutive partial-publish observations
carry a small workflow artifact; after 24 hours they create one deduplicated
stagnation issue. Recipe, layout, version-schema, or major-version drift creates
an immediate deduplicated issue plus a non-auto-merged
`automation/moonbit-manual-review` PR under CODEOWNERS review.

Pull-request CI compares `releases/**` with the base commit. It permits a new
exact manifest and an updated `latest.json` pointer, but rejects modification,
deletion, or renaming of every exact manifest that already exists on the base
branch.

## Releases

Protect tags matching `v*`. A matching SemVer tag runs full deterministic CI,
then publishes:

- `vfox-moonbit-X.Y.Z.zip`
- `vfox-moonbit-X.Y.Z.zip.sha256`
- a GitHub artifact attestation
- `manifest.json` on the movable `manifest` release

The tag version must equal `PLUGIN.version`. MoonBit manifest updates do not
create a plugin release. After the first stable release succeeds, submit the
manifest URL and an exact current test version to the vfox public registry.
