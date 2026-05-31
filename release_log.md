# PushPals CLI Release Log

## Release Metadata

- version: `v1.1.9`
- start_commit: `873e8d36396ffab2098cc9bcf95406589a36b5fc`
- end_commit: `7ee46f23577cc138d454dccc082d750befa67693`
- commits_in_range: `2`

## Highlights

- Harden autonomy PR feedback ingestion so stale legacy PR feedback is ignored safely instead of breaking the runtime, while still preserving pattern learning for resolvable review contexts.
- Add startup diagnostics for slow embedded service launches, including clearer Windows binary-scanning guidance when service startup crosses the slow threshold.
- Add deterministic ReviewAgent PR hygiene gates for obvious low-quality branches before LLM review, including unrelated `.gitignore`/`node_modules` churn, disconnected React Native mocks, deleted coverage, unintegrated helpers, and PushPals-internal concepts leaking into user repos.
- Add repeated-review finding memory so persistent ReviewAgent findings become hard constraints and non-converging PRs are closed earlier instead of burning review-fix loops.
- Strengthen WorkerPal pre-publish quality gates and repo-native validation inference so TypeScript/lint checks are inferred for changed repos and unrelated hygiene churn is blocked before publication.
- Filter autonomy candidates that mention PushPals orchestration concepts while targeting ordinary user-repo app paths, keeping autonomous work focused on repo-native product/test improvements.
- Package the WorkerPal sandbox runtime copy with the same pre-publish hygiene and validation inference behavior for installed CLI users.

## Validation

- `bun run cli:bundle`
- `bun test tests/source-control-manager.review-agent.test.ts tests/workerpals.validation-command-safety.test.ts tests/server.autonomy-store.test.ts`
- `bun x tsc --noEmit --project apps/server/tsconfig.json`
- `bun x tsc --noEmit --project apps/source_control_manager/tsconfig.json`
- `bun x tsc --noEmit --project apps/workerpals/tsconfig.json`
- `bun x tsc --noEmit --project packages/cli/runtime/sandbox/apps/workerpals/tsconfig.json`
- `bun run lint` completed with 2 pre-existing client warnings.
- `bun run test:root` completed successfully: 770 pass, 1 skip, 0 fail.
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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
