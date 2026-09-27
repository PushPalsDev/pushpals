# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.56`
- start_commit: `3e3a70a6d77762cdfc41ec5b9071ff1593576348`
- end_commit: `12d70d713e78441ff8efd030061ee70b8d63dcb0`
- commits_in_range: `1`

## Highlights

- Break the observed Repository Agent planning loop: apply snapshot-stable candidate admission before caching fresh advice and when reading cached advice. If no admissible proposals remain, advance bounded, persisted exploration instead of replaying rejected positive results indefinitely.
- Admit narrowly source-verified repository naming repairs without treating a quoted existing product name as an instruction to change PushPals internals. Require matching repository identity, revision/tree, target blob, citation coordinates, and literal text; retain original evidence while rendering the admitted observation safely for downstream dispatch. Genuine internal-work instructions remain blocked.
- Share static policy and native validation inference between Repository Agent and autonomy dispatch. Use a bounded, immutable tracked-file view for manifests; do not follow repository symlinks into the host or treat missing/truncated inventory as proof that validation is absent.
- Invalidate admission-unaware analysis cache keys and include execution platform, configured confidence/scope, and explicitly disabled objective/component settings in cache identity. Keep transient capacity, cooldowns, open work, and ranking decisions downstream rather than caching them as structural absence.
- Make explicit `pushpals --clear` truthful: local cleanup still runs, but unconfirmed requested Docker cleanup now produces an incomplete summary and exit code `1`. Confirmed absent/removed resources retain success; automatic startup/shutdown cleanup stays bounded and warning-only.
- Regenerate the packaged RemoteBuddy runtime; expand regression coverage, composed analysis-to-request dispatch tests, reliability harness coverage, and operational documentation. No-worker release smokes now explicitly disable Docker configuration; worker-enabled smokes retain Docker requirements.

## Validation

- Full `cli:bundle`, including a fresh monitoring UI export, and actual npm payload verification passed in an isolated Linux container limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `276` files with no external toolchains.
- Final `bun run test:root`: `2,857` passed, `12` platform/opt-in skips, `0` failures, and `15,972` assertions across `192` files (297.74 seconds).
- RemoteBuddy TypeScript checking, two prompt-policy checks, and 51 protocol checks passed. Installed-smoke contract checks passed all 10 tests. Formatting and diff checks passed.
- Composed regressions exercise real Repository Agent analysis, persisted SQLite memory, engine ticks, Server eligibility/reservation, and confirmed request enqueueing in generic temporary repositories. They prove verified repairs can dispatch and repeatedly rejected proposals advance exploration; they do not establish live job execution or PR quality.
- Final product commit `12d70d713e78441ff8efd030061ee70b8d63dcb0` passed [CLI E2E run `36347326297`](https://github.com/PushPalsDev/pushpals/actions/runs/36347326297): packaged CLI on Linux, Linux WorkerPal control-plane/dependency projection, and Windows worker-path/recovery/trusted-validation/source-only startup contracts. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.56
```

```bash
bun install -g @pushpalsdev/cli@1.2.56
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.56
```

## Artifacts

- `pushpals-linux-x64`
- `pushpals-windows-x64.exe`
- `pushpals-macos-x64`
- `pushpals-macos-arm64`
- `SHA256SUMS.txt`

## Compatibility Notes

- Explicit `pushpals --clear` now exits `1` when requested Docker cleanup is unavailable, times out, or fails. Local-state removal still proceeds; callers must not interpret that partial cleanup as success. Retry when Docker is responsive. Startup and shutdown cleanup remain best-effort.

## Known Issues

- A deployed Windows-host Docker cold start and long-duration job-quality soak of these changes have not been demonstrated. The observed v1.2.55 run completed 27 repository analyses but dispatched no jobs. The live installation and external repository were not modified during development. These changes do not guarantee 100% uptime or job success; genuine validation failures and substantive critic findings must still block publication.
- The brief observed local health timeouts recovered without a restart; their underlying host/transport cause was not established. The planning-loop fix does not establish a root-cause fix for every transient runtime stall.
- Exploration remains bounded to 16 pages of six additional paths plus stable seed anchors, not a full repository audit. Admission is structural, not a guarantee of score/capacity eligibility, execution success, browser acceptance, or first-pass PR approval. Incomplete validation evidence defers analysis instead of declaring structural absence.
- Astra still requires account access and a compatible Codex CLI. Explicit custom launcher pins are preserved; users retaining an older custom pin may need to upgrade it themselves. The compatibility fallback does not grant model access or bypass authentication failures.
- Cold image builds and pulls retain separate ten-minute limits, startup self-checks have five minutes, and the default shared absolute startup ceiling is 27.5 minutes. These are upper bounds, not expected warm-start latency or a guarantee that unavailable dependencies will recover.
- Capability holds do not provision missing browsers or repair users' tests. Unconfirmed worker cleanup intentionally delays replacement rather than risking duplicate workers or removal of unrelated containers.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution requires Docker to be installed and running when auto-spawn is enabled.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
