# PushPals CLI Release Log

## Release Metadata

- version: `v1.0.20`
- start_commit: `dce10e380f0d73c33af0cb71ed635196be2c5469`
- end_commit: `dce10e380f0d73c33af0cb71ed635196be2c5469`
- commits_in_range: `1`

## Highlights

- Remove active support for the legacy `config/` runtime layout so `configs/` is the single supported config location across shared config loading, client preflight, VS Code runtime policy, and startup local-config resolution.
- Align source-checkout, packaged CLI runtime, and sandbox runtime WorkerPal executor defaults on `openai_codex`.
- Centralize the defensive WorkerPal executor fallback through the shared config constant instead of duplicating string literals across loaders and backend selection.
- Make shared runtime config loading fail fast when `configs/default.toml` is missing instead of silently reconstructing behavior from hardcoded code defaults.
- Make WorkerPal backend metadata loading fail fast when `configs/backend.toml` is missing or invalid instead of silently falling back to implicit backend ordering.
- Regenerate embedded CLI runtime and sandbox assets so the packaged runtime matches the canonical source config and shared loader behavior.
- Add parity tests that assert source config, packaged runtime config, and sandbox config stay aligned on executor and backend defaults.
- Add regression coverage that verifies legacy `config/` layouts are rejected and missing required runtime config files raise explicit errors.
- Update stale Windows setup documentation to use `configs\local.example.toml` -> `configs\local.toml`.

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
- Tag and push: `git tag v1.0.20 && git push origin v1.0.20`.

