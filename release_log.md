# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.93`
- start_commit: `5283dd8e414dd550082f8dc65fa6f7db71e10695`
- end_commit: `0951683adce84d359124b47e921e3e9e2314993f`
- commits_in_range: `1`

## Highlights

- Avoid blocking npm publication on org-wide package-list metadata that package-scoped granular tokens may not be allowed to read.
- Keep the npm token `whoami` and package-owner checks as hard preflight gates, because they verify the secret is valid and belongs to a package owner.
- Switch the write-access metadata check to the package-specific collaborator endpoint and treat that endpoint as best-effort when npm rejects metadata access for a granular token.
- Let `npm publish --access public --provenance` remain the authoritative final publish permission check.

## Validation

- `bun x prettier --check .github/workflows/release-cli.yml`
- `npm access list collaborators '@pushpalsdev/cli' --json --registry=https://registry.npmjs.org`
- `bun run cli:bundle`
- `bun run test:root`
- `git diff --check`

## Install

```bash
npm i -g @pushpalsdev/cli
```

```bash
bun install -g @pushpalsdev/cli
```

## Artifacts

- `pushpals-linux-x64`
- `pushpals-windows-x64.exe`
- `pushpals-macos-x64`
- `pushpals-macos-arm64`
- `SHA256SUMS.txt`

## Breaking Changes

- None.

## Known Issues

- `v1.0.87`, `v1.0.88`, `v1.0.89`, `v1.0.90`, `v1.0.91`, and `v1.0.92` were tagged but did not publish to npm; `v1.0.89` did publish GitHub release assets before the npm token failure, while later releases were blocked before GitHub release asset publication.
- npm publication requires the repository `NPM_TOKEN` secret to have publish rights for `@pushpalsdev/cli` under the `@pushpalsdev` scope.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
