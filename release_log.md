# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.50`
- start_commit: `29c27dd08164eaec6a1031e140a870dc78c2cd13`
- end_commit: `1965d8fe14e93db295775bddaa28244db84282f5`
- commits_in_range: `1`

## Highlights

- Reserve validation and critic time during short worker revisions without extending the original job deadline. Give executors their actual turn budget and focus revision instructions on actionable failures instead of repeating full discovery or unavailable Docker checks.
- Let an explicitly retained timeout candidate undergo independent validation and critic review inside its remaining budget. Missing verdicts, unresolved must-fix findings, assertions, empty diffs, and expired deadlines still prevent success; environment-only checks remain held for trusted-host validation.
- Preserve earlier validation, patch, and critic evidence when a later executor turn fails. Keep terminal phase intervals visible and stop labeling every earlier phase with the final job failure.
- Fix trusted-validation retries for real nested Bun commands: ordinary script-exit summaries no longer suppress the single timeout retry. Mixed failures do not qualify, and a repeated timeout still blocks publication.
- Dispatch one exact-candidate repair after a single actionable trusted-host rejection, without waiting for another full job to hit the same gate. Concurrent ticks retain one repair lease; worker diagnostics cannot impersonate or erase trusted-host evidence.
- Align RepositoryAgent and autonomy candidate contracts, permit one bounded schema correction, and reject invalid cache entries. Feed executed outcomes back into analysis without reinforcing cache reads as successful jobs; a retained-outcome watermark prevents stale advice from returning when detailed history ages out.
- Use the platform temporary directory for critic output, refresh packaged runtime bundles and source mirrors, and gate the new real-process recovery tests on Windows before tagging and publication.

## Validation

- Bun 1.3.14 passed `bun run cli:bundle` and `bun run cli:verify-package-payload` in a resource-capped container checkout with native dependencies; the package contains `271` files and no external toolchain payloads.
- `bun run test:root` passed in the same isolated native-dependency container: `2,051` tests passed, `12` platform/opt-in skips, `0` failures, and `11,867` assertions across `171` files. The additional Windows workflow coverage checks passed in a subsequent `11`-test Docker run.
- Focused Docker suites passed `242` server/planning tests, `113` worker/harness tests, `47` trusted-validation tests, and `126` Python executor tests. Both new real nested-Bun retry scenarios also passed on Windows.
- Server, RemoteBuddy, WorkerPal, and SourceControlManager TypeScript checks passed in Docker.
- All `151` staged runtime source mirrors have identical Git blob hashes to their canonical sources.
- Final product commit `1965d8fe14e93db295775bddaa28244db84282f5` passed CLI E2E run `34065677306`: Windows package/path/startup contracts including the new timeout-candidate and trusted-validation regressions, Linux WorkerPal control-plane E2E, and Linux packaged CLI E2E. The separate manual-only Windows-host Docker job was skipped as configured.
- Independent reviews closed critic-bypass, evidence-loss, trusted-source spoofing, and stale-cache resurrection gaps. Prettier and `git diff --check` passed.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.50
```

```bash
bun install -g @pushpalsdev/cli@1.2.50
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.50
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

- This release does not change users' repository tests. Persistent test failures and substantive critic findings still block publication; regression and release smoke checks do not establish new live job or PR outcomes for a stopped repository session.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
