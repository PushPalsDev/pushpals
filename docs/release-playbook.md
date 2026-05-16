# PushPals Release Playbook

This is the maintainer checklist for cutting a PushPals CLI release. PushPals
releases are tag-driven: pushing a `vX.Y.Z` tag starts the `Release CLI` GitHub
Actions workflow, which publishes npm, builds runtime binaries, and creates the
GitHub release.

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
bun run test:root
git diff --check
```

If `bun run cli:bundle` changes `packages/cli/runtime` or monitor UI assets,
commit those generated updates before tagging. The published package uses those
packaged assets.

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

Commit `release_log.md` and any new/updated release docs:

```powershell
git add release_log.md docs/release-playbook.md
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
bun install -g @pushpalsdev/cli@X.Y.Z
pushpals --version
pushpals --clear
```

## Common Failure Modes

- `release_log.md` was not updated, so the GitHub release body is stale.
- `packages/cli/runtime` was not regenerated after runtime changes.
- The npm package published, but a platform binary smoke failed.
- Docker is unavailable in an installed-CLI smoke environment; cleanup should be
  best-effort, not a hard failure.
- User-local `runtime/configs/local.toml` overrides new defaults during manual
  smoke testing.
- Git cannot fetch or push on Windows due to certificate backend mismatch; retry
  with `git -c http.sslBackend=schannel`.
