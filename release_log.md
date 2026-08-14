# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.32`
- start_commit: `6f193b3055665b394f813a394c70cbcabffddde2`
- end_commit: `c1672195a31f1db14600e4bbd21c336b5b26c74d`
- commits_in_range: `1`

## Highlights

- Package the complete prompt tree in the WorkerPal sandbox, including the final ReviewAgent rubric that was missing from `v1.2.31` and caused otherwise-successful jobs to terminate during CriticGate review.
- Verify the critical WorkerPal and ReviewAgent prompt assets in the actual npm payload before publication.
- Fall back to a conservative built-in final-review rubric if a packaged reviewer prompt is unexpectedly unavailable instead of failing the whole job.
- Emit a structured `missing_runtime_asset` terminal result for fatal prompt-loading failures and keep incidental timeout wording in worker output from being misclassified as a watchdog timeout.
- Ship synchronized WorkerPal source, generated runtime bundles, sandbox prompts, documentation, and regression coverage.

## Validation

- The complete root suite passed `1,164` tests with `5` intentional platform or opt-in skips and `0` failures on Windows with Bun 1.3.14.
- The focused CLI packaging, Docker executor, job-runner, quality-gate, and session-event suite passed `291` tests with `4` intentional skips and `0` failures.
- WorkerPals, shared-package, and packaged-runtime TypeScript checks passed.
- `bun run cli:bundle` completed and synchronized packaged runtime source, generated service bundles, prompts, and monitor assets.
- `bun run cli:verify-package-payload` verified `257` package files with no external toolchain files.
- Maintained source, tests, prompts, and documentation passed Prettier checks; `git diff --check` passed.
- The exact packaged Linux sandbox loaded the ReviewAgent rubric, exercised the built-in missing-prompt fallback, and resolved CriticGate context through a real SectorCommand Windows bind mount.
- The opt-in Windows-host/Linux-container integration suite passed `35` tests with `1` intentional skip and `0` failures.

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Active runtimes started from an older release must be restarted after installing this release before the corrected sandbox payload and terminal classification take effect.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
