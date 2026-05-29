# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.5`
- start_commit: `00cd6e2a1e847dd9fb5c89fed53eee2e51c9ee34`
- end_commit: `d15c5855e36d4cd52b7ccb829e7227dc1559b0db`
- commits_in_range: `1`

## Highlights

- Bound SourceControlManager startup git binary and remote inspection probes so CLI startup cannot hang indefinitely after RemoteBuddy and WorkerPal are already alive.
- Treat inconclusive SourceControlManager remote inspection as a startup warning and skip SCM startup instead of blocking the whole embedded runtime.
- Preserve a hard failure only when the configured PushPals branch is conclusively missing from an otherwise reachable remote.
- Add regression coverage for a stuck SCM remote inspection to prove the startup precheck returns within the configured timeout budget.

## Validation

- `bun test tests/cli.invocation-logging.test.ts tests/cli.runtime-bootstrap.test.ts tests/client.runtime-bootstrap.test.ts tests/shared.client-preflight.test.ts`
- `bun run test:root`
- `bun run cli:bundle`
- `git diff --check`
- Constrained Windows startup smoke from `C:\Users\data_pi\Documents\programming\SectorCommand` with WorkerPal/autonomy disabled and a missing SCM remote reached `Embedded runtime is ready` with `source_control_manager=64ms(skipped_no_remote)` and no lingering PushPals runtime processes.

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
