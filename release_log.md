# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.23`
- start_commit: `a6ca3702621fcbe01262f52e2b165e6f530bd5f6`
- end_commit: `c6c43e73ffbab35fa848b916b6fa54c6a1233f0b`
- commits_in_range: `2`

## Highlights

- Harden packaged WorkerPal runtime path resolution so OpenHands, OpenAI Codex, and MiniSWE load prompts from the effective embedded runtime prompt root when `pushpals` runs against external repos.
- Remove the last legacy `config/` source-checkout probe from CLI bootstrap so `configs/` remains the only supported source layout.
- Improve ReviewAgent PR comments so both rejected and accepted reviews surface fallback reasoning from `fix_instruction` or `summary` when `issues[]` is empty.
- Add WorkerPal LLM usage reporting into the shared telemetry pipeline so the monitoring hub shows WorkerPal token totals instead of `0 calls / 0 tokens`.
- Add per-session token budget tracking and enforce a global session token cap that pauses new work once a session exceeds the configured limit.
- Raise the shipped default `server.session_token_budget` to `2,000,000` tokens and regenerate the packaged CLI runtime/sandbox assets to keep source and installed CLI behavior aligned.

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
- Tag and push: `git tag v1.0.23 && git push origin v1.0.23`.

