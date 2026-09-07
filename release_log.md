# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.52`
- start_commit: `393461e6154afa7b00e68fa3c467dd9e6df88e86`
- end_commit: `81cb703aff8bd376b4993616efe83acbbabb3032`
- commits_in_range: `1`

## Highlights

- Route inferred focused tests through the repository's own Bun/Vitest/Jest scripts when test ownership is supported by configuration evidence. Preserve required validation gates and decline ambiguous imports, dynamic selectors, unknown plugin hooks, and incompatible glob semantics instead of claiming unrelated tests as coverage.
- Persist exact-revision PR review decisions and repair counts across SCM restarts and HTTPS/SSH remote aliases. Reuse a retained verdict rather than repeatedly scoring unchanged rejected code until it passes.
- Keep review and merge-conflict repairs active through trusted validation and publication. Resume lifecycle checks after restart, circuit settlement, and exhaustion; verify the provider revision immediately before side effects and atomically pin merges to the reviewed head SHA.
- Safely upgrade older repair databases, preserving historical exhausted/succeeded records without granting new repair capabilities. Authenticated exact-revision lifecycle lookups protect repairs that predate the local review journal.
- Preserve actual failed-test names, paths, and compiler diagnostics ahead of expected negative-path logs. Prevent passing labels, zero-failure summaries, and incidental timeout messages from corrupting failure classification and repair context.
- Refresh packaged runtime bundles and source mirrors. Expand real SQLite migration/restart, mixed-runner ownership, completion-to-autonomy evidence, bounded subprocess health, and Windows release regression gates.

## Validation

- Bun 1.3.14 passed the full CLI bundle and actual npm payload check in an isolated container limited to one CPU and 768 MiB memory, with native Linux dependencies. The package contains `272` files and no external toolchains; the Windows payload check also passed.
- The final root suite passed `2,308` tests, with `12` platform/opt-in skips, `0` failures, and `12,899` assertions across `173` files. Tests include real temporary SQLite upgrades and close/reopen recovery, not only fresh in-memory fixtures.
- Server, RemoteBuddy, WorkerPal, and SourceControlManager TypeScript checks passed. All `77` checked canonical shared/worker/config mirrors matched the generated runtime after line-ending normalization; an independent compiled-bundle audit verified current migration, review, and routing behavior. Formatting and `git diff --check` passed.
- The consolidated reliability harness passed all seven phases, including Python worker watchdog and bounded runtime/repair contracts. Local Docker-dependent opt-ins remained skipped because the isolated container has no Docker socket.
- Product commit `81cb703aff8bd376b4993616efe83acbbabb3032` passed cross-platform CLI E2E run `34114999593`: Windows runtime paths, recovery, trusted validation and isolated startup; Linux WorkerPal control-plane E2E and dependency projection; and packaged CLI E2E. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.52
```

```bash
bun install -g @pushpalsdev/cli@1.2.52
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.52
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

- Astra still requires account access and a compatible Codex CLI. Explicit custom launcher pins are preserved; users retaining an older custom pin may need to upgrade it themselves. The compatibility fallback does not grant model access or bypass authentication failures.
- This release is not a long-duration SectorCommand job soak and does not repair users' repository tests. The observed account-test timeout remains a genuine validation failure; persistent test failures and substantive critic findings must still block publication.
- Focused-runner inference intentionally leaves opaque or unsupported configuration unresolved. Legacy corrupted repair records without a valid owning job require authoritative reconciliation; this release does not fabricate replacement jobs or permissions.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
