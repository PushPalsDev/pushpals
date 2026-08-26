# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.43`
- start_commit: `62898e04155fc8854c72c7da73fcebbab087fc7c`
- end_commit: `66fa7f0ee1fce88634c2753f2a74d4d5befd6131`
- commits_in_range: `1`

## Highlights

- Add a shared RepositoryAgent that every backend service can call for bounded, evidence-cited repository reasoning, with RemoteBuddy hosting isolated model execution and durable request leases.
- Add a separate typed memory interface and SQLite authority with repository isolation, provenance, expiry, invalidation, outcome reinforcement, cache reuse, and cross-session learning.
- Ground autonomous ideation, scoring, validation selection, and review repair in generic repository evidence and `vision.md` priorities without product-specific path rules.
- Harden end-to-end job and publication lifecycles with exact claim generations, stale recovery, provider reconciliation, validation incident fencing, completion backpressure, and bounded process-tree cleanup.
- Improve execution speed and observability through focused-first validation, invariant caching, dependency preparation telemetry, container-native projections, runtime circuit breakers, and phase-level diagnostics.
- Make packaged Windows startup self-repair only missing or stale runtime assets while preserving repository configuration, and ship every required source bundle, prompt, and launch trampoline.
- Finalize transient SQLite statements deterministically so RequestQueue shutdown releases Windows database handles synchronously.

## Validation

- `bun run test:root` passed `1,811` tests with `7` intentional platform or opt-in skips, `0` failures, and `14,631` assertions across `163` files on Windows with Bun 1.3.14.
- RepositoryAgent, memory-store conformance, repository-context fencing, provider reconciliation, autonomy policy, publication recovery, runtime bootstrap, and RequestQueue handle-lifecycle regression suites passed.
- `bun run cli:bundle` rebuilt all packaged service runtimes and source mirrors successfully.
- `bun run cli:verify-package-payload` verified `267` package files with no external toolchain files.
- Server and packaged-runtime builds passed, generated runtime mirrors remained byte-identical, and `git diff --check` passed.

## Install

```bash
npm i -g @pushpalsdev/cli@1.2.43
```

```bash
bun install -g @pushpalsdev/cli@1.2.43
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
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
