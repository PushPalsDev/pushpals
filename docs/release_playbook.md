# PushPals Release Playbook

This is the maintainer checklist for cutting a PushPals CLI release. PushPals
releases are tag-driven: pushing a `vX.Y.Z` tag starts the `Release CLI` GitHub
Actions workflow, which publishes npm, builds runtime binaries, and creates the
GitHub release.

## npm Trusted Publishing

The release workflow publishes `@pushpalsdev/cli` through npm trusted publishing
with short-lived GitHub OIDC credentials. It must not depend on a long-lived
`NPM_TOKEN` secret.

Configure the package once in npm package settings with these exact trusted
publisher values:

- provider: GitHub Actions
- organization: `PushPalsDev`
- repository: `pushpals`
- workflow filename: `release-cli.yml`
- environment: none
- allowed action: `npm publish`

The publish job requires `id-token: write`, Node `22.14.0` or newer, and npm
`11.5.1` or newer. `npm whoami` does not validate OIDC publishing because npm
exchanges the workflow identity only during `npm publish`.

Do not set `registry-url` on `actions/setup-node` in the publish job. That option
writes a classic `_authToken` entry to npm's user config; without a
`NODE_AUTH_TOKEN`, the empty entry can prevent npm from attempting the OIDC
exchange. npm already defaults to `https://registry.npmjs.org`.

## When To Cut A Release

Cut a patch release when a committed change affects any published CLI behavior,
embedded runtime behavior, WorkerPal sandbox behavior, or startup/release smoke
coverage.

Examples:

- Runtime service changes under `apps/*`.
- Shared runtime packages under `packages/shared` or `packages/protocol`.
- CLI entrypoint changes under `scripts/pushpals-cli.ts`.
- Packaged runtime or sandbox changes under `packages/cli/runtime`.
- Release, startup, or installed-package smoke-test fixes.
- Config/default changes that users should receive through `@pushpalsdev/cli`.

## Required Pre-Release Checks

Run these before tagging unless there is a clear environment blocker:

```powershell
git status --short --branch
bun run cli:bundle
bun run cli:verify-package-payload
bun run test:root
git diff --check
```

If `bun run cli:bundle` changes `packages/cli/runtime` or monitor UI assets,
commit those generated updates before tagging. The published package uses those
packaged assets.

The npm package must not vendor external toolchains. Run
`bun run cli:verify-package-payload` to inspect the actual `npm pack --dry-run`
file list and fail if the package would include real `node_modules`
directories, virtualenvs, standalone executables, native libraries, or external
tool names such as Bun, Node, Git, Docker, Codex, or UV.

The GitHub release still publishes PushPals-built standalone CLI/runtime
artifacts. Do not add separate third-party tool binaries to the release asset
set; the release workflow verifies artifact names before upload.

## Version Numbering

Use normal patch releases until the patch number reaches `99`. After patch `99`,
roll the minor version and reset the patch to `0`.

Examples:

- `v1.0.98` -> `v1.0.99`
- `v1.0.99` -> `v1.1.0`
- `v1.1.99` -> `v1.2.0`

Do not intentionally create patch versions above `.99`. If a patch-above-99
release already exists, leave it published and cut the next release at the
policy-correct minor version. For example, after a published `v1.0.100`, the
next release should be `v1.1.0`, not `v1.0.101`.

## Prepare Release Notes

Update `release_log.md` before tagging.

Use the previous release tag as the start point:

```powershell
git tag --list "v*" --sort=-v:refname | Select-Object -First 5
git log --oneline vX.Y.Z..HEAD
git rev-parse vX.Y.Z
git rev-parse HEAD
```

Recommended metadata:

- `version`: the new tag, for example `v1.0.80`.
- `start_commit`: the previous release tag commit.
- `end_commit`: the final product-change commit before the release-prep commit.
- `commits_in_range`: product-change commits since the previous release, excluding
  the release-prep commit itself when possible.

Keep highlights user-facing and operational. Include known issues if a release
has environment caveats.

## Commit Release Prep

Commit `release_log.md` and any new/updated release docs. For ordinary
direct-to-main commits, follow `docs/git_commit.md`: `git commit`, then
`git pull --rebase`, then `git push`.

```powershell
git add release_log.md docs/release_playbook.md
git commit -m "docs(release): prepare vX.Y.Z"
```

If there are already staged runtime asset changes from `bun run cli:bundle`, keep
them in the relevant feature/fix commit when possible. If they were missed, include
them in the release-prep commit rather than tagging stale packaged assets.

## Tag And Push

Create the tag on the release-prep commit and push `main` plus the tag:

```powershell
git tag vX.Y.Z
git push origin main vX.Y.Z
```

On Windows, if Git fails with a local certificate-store error, retry using the
Windows certificate backend for that command:

```powershell
git -c http.sslBackend=schannel push origin main vX.Y.Z
```

Do not tag before the release-prep commit is on `main`.

## Watch The Workflow

The tag starts `.github/workflows/release-cli.yml`.

```powershell
gh run list --repo PushPalsDev/pushpals --workflow release-cli.yml --limit 5
gh run watch <run_id> --repo PushPalsDev/pushpals
gh run view <run_id> --repo PushPalsDev/pushpals --json status,conclusion,jobs
```

Required jobs:

- npm publish for `@pushpalsdev/cli`.
- GitHub release asset publish.
- Published CLI smoke on Linux.
- Published CLI smoke on Windows.
- Runtime binary smoke jobs for supported platforms.

## Verify Publication

After the workflow finishes:

```powershell
npm view @pushpalsdev/cli@X.Y.Z version
gh release view vX.Y.Z --repo PushPalsDev/pushpals
```

Optionally smoke the installed package locally:

```powershell
bun install -g --use-system-ca @pushpalsdev/cli@X.Y.Z
pushpals --version
pushpals --clear
```

## Common Failure Modes

- `release_log.md` was not updated, so the GitHub release body is stale.
- `packages/cli/runtime` was not regenerated after runtime changes.
- The npm package published, but a platform binary smoke failed.
- npm publish reports `ENEEDAUTH`; verify the npm trusted publisher matches
  `PushPalsDev/pushpals` and `release-cli.yml` exactly, including case and file
  extension, verify the publish job retains `id-token: write`, and verify its
  npm config does not contain a classic `_authToken` entry.
- The CLI package payload check fails because an external tool binary, native
  library, virtualenv, or `node_modules` directory would be shipped. Remove the
  vendored artifact and rely on environment discovery/downloads instead.
- Docker is unavailable in an installed-CLI smoke environment; cleanup should be
  best-effort, not a hard failure.
- User-local `runtime/configs/local.toml` overrides new defaults during manual
  smoke testing.
- Git cannot fetch or push on Windows due to certificate backend mismatch; retry
  with `git -c http.sslBackend=schannel`.
- Bun cannot reach npm on Windows because a managed root CA is not in Bun's
  bundled trust store; retry installation with `--use-system-ca`.
