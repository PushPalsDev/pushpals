# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.87`
- start_commit: `0bd477557f562fd9662b3d52dde176dce4320881`
- end_commit: `99f3bba80f631ef88fc5b2d565f7acd48075a532`
- commits_in_range: `1`

## Highlights

- Treat WorkerPal `target_paths` and `write_globs` as review/relevance hints instead of hard write boundaries, so workers can edit the behavior-owning files needed to complete a task inside their isolated sandbox.
- Allow autonomy-generated work to use repo-wide reads and mixed-root/broad scope hints while preserving repo-relative path validation and review-based relevance checks.
- Stage the full WorkerPal sandbox diff for `task.execute` commits while explicitly excluding transient workspace, output, and `.codex` artifacts.
- Update OpenAI Codex, OpenHands, and MiniSWE prompts/backends to explain the new full-sandbox write model and require workers to justify any expansion beyond target hints.
- Keep forbidden/transient artifact protections and validation/review gates in place so ReviewAgent and quality gates decide whether broad edits are relevant and shippable.
- Sync packaged CLI runtime and sandbox assets so installed CLI users receive the updated autonomy, prompt, and WorkerPal behavior.

## Validation

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

- Docker-backed WorkerPal execution still requires Docker to be installed and running when WorkerPal auto-spawn is enabled; `pushpals --clear` cleanup is best-effort when Docker is unavailable or times out.
- Codex `gpt-5.5` requires a recent Codex CLI; older Codex CLIs fall back to `gpt-5.4` for WorkerPal and RemoteBuddy Codex execution when they report model incompatibility.
- GitHub contribution credit for WorkerPal commits requires the configured commit email to be associated with the target GitHub account.
- Native WSL source-tree `cli:bundle` runs can still hang in the Expo monitor export path when building from a Windows-mounted checkout under `/mnt/c/...`; the published CLI package cold-start path is covered separately.
