# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.17`
- start_commit: `5957d955aa3603aa2a317903dda9df22db2beb2d`
- end_commit: `5957d955aa3603aa2a317903dda9df22db2beb2d`
- commits_in_range: `1`

## Highlights

- Add an embedded SourceControlManager Git precheck to the CLI startup path so `pushpals` fails before runtime boot when the embedded Git command chain is unavailable.
- Fix SourceControlManager runtime repo-root resolution so compiled embedded binaries use the configured project root instead of a source-checkout-relative working directory.
- Harden Windows Git discovery by resolving `cmd.exe` and `where.exe` from `ComSpec` and `SystemRoot` before PATH-only fallback.
- Replace the old boolean SCM remote probe with a status-returning check so Git execution failures are no longer mislabeled as "remote not configured".
- Reuse the same SCM remote inspection logic during embedded runtime startup so preflight and startup do not diverge on Git and remote availability.
- Extend CLI and SourceControlManager regression coverage for missing remote, remote-inspection failure, Windows command lookup, and pre-start Git probe failure cases.

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

- None.

## Release Checklist

- Confirm `release_log.md` content before tagging.
- Tag and push: `git tag v1.0.17 && git push origin v1.0.17`.

