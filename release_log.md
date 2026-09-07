# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.51`
- start_commit: `5c566ef46c44c5da39838200ee4f62fd2f796634`
- end_commit: `bfc1c19a8e5a21a664f8dfa324a532421f48fa6a`
- commits_in_range: `1`

## Highlights

- Upgrade the default OpenAI Codex model from `gpt-5.6-sol` to `gpt-6-astra` across LocalBuddy, RemoteBuddy/RepositoryAgent, WorkerPal, and SCM PR review. Preserve existing reasoning-effort policies, deadlines, and validation requirements.
- Pin generated WorkerPal launchers to `@openai/codex@0.153.2`, verified to support Astra. Migrate exact legacy generated model defaults and the old `0.146.0` worker pin while preserving custom models, explicit alternate pins, non-Codex backends, and custom launchers.
- Make WorkerPal quality review inherit the configured worker model unless an explicit critic override is supplied. Give SCM PR review an explicit Astra default and an optional model setting, while respecting model/profile selections in custom launchers, including Bun, npm, and Python wrappers.
- Retain a bounded, one-time fallback to Sol for an explicit older-Codex model-version rejection. Ordinary authentication, rate-limit, and network failures do not trigger model downgrade. SCM review fallback shares the original deadline and clears stale output before retrying.
- Refresh all packaged runtime bundles and source/config mirrors, expand model-routing and migration regression coverage, and document the live compatibility probes in the model-upgrade playbook.

## Validation

- Bun 1.3.14 passed `bun run cli:bundle` and `bun run cli:verify-package-payload` in a resource-capped container checkout with native dependencies; the package contains `271` files and no external toolchain payloads. The final host payload check also passed.
- `bun run test:root` passed in the isolated container: `2,118` tests passed, `12` platform/opt-in skips, `0` failures, and `12,296` assertions across `171` files. After the final equivalent string-normalization adjustment for the SCM TypeScript target, all `122` SCM tests, SCM typecheck, bundle, and payload checks passed again.
- Python executor coverage passed `133` tests; CLI integration coverage passed `189` tests. Selected installed-package checks passed, and focused Windows fake-executable tests exercised model routing, custom overrides, fallback classification, stale-output removal, and bounded retry deadlines.
- RemoteBuddy, WorkerPal, and SourceControlManager TypeScript checks passed in Docker. Independent review checked `155` canonical source/config-to-runtime mirror pairs with no mismatches after line-ending normalization. Prettier and `git diff --check` passed.
- Live isolated probes verified the exact Bun-launched Codex `0.153.2` pin with Astra/`xhigh` on Windows and Linux, including overwriting an existing tracked file in a disposable Windows worktree. The actual RepositoryAgent client and SCM review argument builder also completed Astra requests without fallback. The old `0.146.0` pin was confirmed to reject Astra.
- Final product commit `bfc1c19a8e5a21a664f8dfa324a532421f48fa6a` passed CLI E2E run `34106946008`: Windows package/path/recovery/startup contracts, Linux WorkerPal control-plane E2E, and the full Linux packaged CLI E2E suite. This closes the earlier local runner's missing-Docker E2E gap. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.51
```

```bash
bun install -g @pushpalsdev/cli@1.2.51
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.51
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
- Live model probes and regression/release smokes are not a long-duration SectorCommand job soak. This release does not change users' repository tests; persistent test failures and substantive critic findings still block publication.
- The npm entrypoint requires Node.js 20+ and at least one Bun 1.3.14+ installation. Standalone GitHub release binaries remain available when installing Bun is not practical.
- `PUSHPALS_BUN_BIN` is authoritative when set; unset or correct it if it points to a removed or outdated runtime.
- The immutable `v1.2.44`, `v1.2.45`, and `v1.2.46` tags remain unpublished on npm; install `v1.2.47` or newer.
- Docker-backed WorkerPal execution still requires Docker to be installed and running when auto-spawn is enabled. `pushpals --clear` treats a stopped Docker daemon as a best-effort cleanup skip.
- Some Windows Git installations may need Schannel certificate handling for remote operations, for example `git -c http.sslBackend=schannel fetch origin`.
