# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.49`
- start_commit: `82e388d0a942f9b707f2d3717b0518e3d266ac5b`
- end_commit: `f679a3c7bbf1924dfa557a5df50b29529abe4c7d`
- commits_in_range: `3`

## Highlights

- Preserve worker completion messages independently of ordinary log truncation, including candidate commits, trusted-validation handoffs, and accumulated usage. Large test output and shutdown noise can no longer silently discard a successful worker's structured result.
- Bound result frames and compact verbose output while failing explicitly on oversized or malformed results; never fall back to an older success after a newer invalid result.
- Recover an open WorkerPal runtime circuit even when every earlier job has finished and the queue is empty. After cooldown, admit one durable probe, retain the atomic canary fence, and recover expired planner leases without admitting duplicate probes.
- Check runtime admission before spending RepositoryAgent, ideation, or scoring tokens. Persist specific enqueue rejection reasons and apply bounded backoff to transport errors, malformed responses, confirmation failures, and new admission codes.
- Retry an explicit timeout-only trusted test-runner failure once while preserving failed-test evidence. Repeated failures still block publication; mixed assertions do not qualify for the timeout retry.
- Emit immediate trusted-validation start, completion, and retry progress with job/completion/candidate identity and credential-redacted commands.
- Regenerate all packaged runtime bundles and WorkerPal source mirrors so installed clients receive the fixes. Add regression coverage to the release reliability harness and isolate image-preparation tests from the developer checkout.

## Validation

- Bun 1.3.14 passed `bun run cli:bundle` and `bun run cli:verify-package-payload` in a resource-capped container checkout with native dependencies; the package contains `271` files and no external toolchain payloads.
- `bun run test:root` passed in the same isolated native-dependency container: `2,025` tests passed, `12` platform/opt-in skips, `0` failures, and `11,561` assertions across `170` files.
- `341` distinct targeted tests passed across resource-capped Docker suites; `149` Windows tests passed, including actual subprocess result delivery and process-tree timeout coverage.
- Server, RemoteBuddy, WorkerPal, and SourceControlManager TypeScript checks passed in Docker.
- `23` packaged runtime parity and package-payload regression tests passed on Windows after regenerating the assets.
- Final product commit `f679a3c7bbf1924dfa557a5df50b29529abe4c7d` passed CLI E2E run `34013126870`: hosted Windows package/startup contracts, Linux packaged CLI E2E, Linux WorkerPal control-plane E2E, and Linux dependency-projection coverage. The separate opt-in Windows-host Docker job was not run.
- Independent reviews closed malformed-handoff backoff, credential-redaction, mixed-failure retry, and test-isolation gaps. Prettier and `git diff --check` passed.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.49
```

```bash
bun install -g @pushpalsdev/cli@1.2.49
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.49
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
