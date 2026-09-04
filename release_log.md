# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.48`
- start_commit: `26e48bd1c6158ff415da364812e955f5d0cb449a`
- end_commit: `9fc5385b0bc9840e4cc33d3f3fe3e0706df9cbce`
- commits_in_range: `2`

## Highlights

- Fix Windows startup when an outdated Bun installation appears before a compatible npm-managed Bun on `PATH`; the launcher now checks candidates in order and selects the first runtime satisfying Bun 1.3.14+.
- Resolve global and project-local npm `bun`/`bun.cmd` shims to their native executable, deduplicate equivalent paths, honor the authoritative `PUSHPALS_BUN_BIN` override, and keep discovery within one bounded probe budget.
- Report every checked Bun path and version with actionable upgrade, timeout, and shadowed-installation diagnostics when startup cannot continue.
- Package the new runtime resolver with the npm CLI and exercise its selection and payload contracts in hosted Windows CI before release.
- Synchronize Node and browser protocol validators, schemas, and packaged mirrors with the current structured session-ingress and session-event-frame contracts.
- Refresh the canonical architecture diagram and operational documentation to match the implemented service topology, queue scheduling, authority boundaries, configuration, and client surfaces.

## Validation

- Bun 1.3.14 passed `bun run test:root`: `1,987` tests passed, `7` intentional platform-gated skips, `0` failures, and `15,581` assertions across `169` files.
- `bun test tests/cli.bun-runtime-resolver.test.ts` passed all `9` focused resolver tests, including outdated-first/compatible-npm-second, project-local shim, explicit override, fallback-shell, and shared-timeout cases.
- `bun run test:protocol` passed all `51` Node/browser contract checks, and `bun run protocol:typecheck` passed.
- `bun run cli:bundle` rebuilt the packaged CLI successfully without producing stale generated-asset changes.
- `bun run cli:verify-package-payload` verified `270` package files, including `bin/bun-runtime.cjs`, with no external toolchain files.
- The exact final product commit passed hosted Windows resolver/startup contracts, Linux packaged CLI E2E, Linux WorkerPal control-plane E2E, and Linux dependency-projection coverage in CLI E2E run `33847165864`.
- Source and installed-package launcher smokes passed with Bun 1.3.14, including the explicit executable override.
- Two independent review passes found and closed hosted-CI, project-local-shim, timeout-diagnostic, documentation-map, and Windows line-ending gaps; Prettier, Node syntax checks, and `git diff --check` passed.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.48
```

```bash
bun install -g @pushpalsdev/cli@1.2.48
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.48
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

- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
