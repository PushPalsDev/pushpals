# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.61`
- start_commit: `d4e82dc8a52bf7f83c7f11ca985b809cad517f27`
- end_commit: `3ac905dba3259473c211c580ba104dcf7f07c0df`
- commits_in_range: `2`

## Highlights

- Avoid unnecessary worker revisions when a normal code change includes conditional guidance such as "update tests if needed." Explicit test targets and mandatory test-edit clauses still require coverage; required validation and critic gates are unchanged.
- Preserve Repository Agent discovery progress when more active/recent targets are excluded, instead of revisiting candidates that remain ineligible. Persist bounded, fingerprint-bound exclusion paths; removals and legacy or malformed memory retain conservative replay.
- Do not repeat a full trusted validation suite merely because a test title mentions an infrastructure error. Concrete assertion, compiler, or lint diagnostics veto the retry. Genuine infrastructure failures retain one bounded retry, and progress logs now include safe exit-code, failure-class, and failed-test-count fields.
- Wait for exact-version npm metadata and the complete hash-verified tarball before published Linux/Windows installation smokes. The availability check has strict request, byte, attempt, and overall deadlines; it never republishes a version or skips smoke validation.
- Add regression cases, fix independent-review findings, refresh embedded runtime assets, and record the live-run findings in `docs/run-observations-v1.2.60-2026-09-29.md`. All runtime behavior remains repository-generic.

## Validation

- Full root suite: `3,115` passed, `12` platform/opt-in skips, `0` failures, and `17,586` assertions across `198` files (338.20 seconds).
- Final release-helper/workflow/installed-smoke contracts: `39` passed, `0` failures. Final packaged-runtime/prompt/payload contracts: `25` passed, `0` failures.
- WorkerPals, RemoteBuddy, and SCM TypeScript checks passed, plus standalone strict typechecking for the registry helper and its tests. A standalone type-narrowing issue was corrected and its targeted suite rerun after the full root suite.
- Full `cli:bundle`, including monitoring UI export, and package-payload verification passed in an isolated Docker checkout limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `278` files with no external toolchains. Four generated runtime files were refreshed and the worker source/sandbox mirror hashes match.
- Independent reviews covered worker-intent classification, exclusion-memory compatibility, and trusted-validation retry authority. Findings involving formatted instructions, separate mandatory clauses, and genuine "Failed to connect" diagnostics were fixed and regression-tested.
- Product commit `3ac905dba3259473c211c580ba104dcf7f07c0df` passed [CLI E2E run 36545191425](https://github.com/PushPalsDev/pushpals/actions/runs/36545191425): packaged CLI and real-Docker WorkerPal control-plane tests on Linux, plus Windows worktree, recovery, trusted-validation, and source-only startup contracts. The manual-only Windows Host Docker E2E job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.61
```

```bash
bun install -g @pushpalsdev/cli@1.2.61
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.61
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No configuration or database migration is required. Older discovery memory without exclusion-path metadata continues conservatively.
- Required validation order, publication backpressure, exact-candidate checks, and candidate-specific lifecycle hooks remain authoritative. These optimizations do not cache a validation pass for a different candidate.
- Ambiguous container/database failures still require existing recovery evidence; they are not blindly retried or marked successful. Telemetry fields are observations, not publication authority.

## Known Issues

- The prior v1.2.60 Windows installed-package smoke observed a SourceControlManager singleton-lock collision during an immediate same-repository restart in [attempt 2](https://github.com/PushPalsDev/pushpals/actions/runs/36518343608/attempts/2). Available logs cannot distinguish incomplete shutdown, stale PID reuse, or another lock-file acquisition error. This patch does not claim to fix that finding; a passing retry is not proof of resolution.
- The observed v1.2.60 run completed nine of ten jobs, all nine PRs approved on their first PR review, but three needed worker-side revisions. Completed jobs averaged 15.8 minutes; required host validation alone averaged about five minutes. No deployed speedup or 100% success/uptime guarantee is established by these pre-release tests.
- Discovery still needs grounded evidence for higher-priority product work. Progress preservation does not prove better vision alignment or justify speculative jobs. The observed failed job correctly refused an unsupported gameplay-copy change.
- The optional local container live-registry check was blocked by managed-CA trust. TLS verification was not bypassed; deterministic tests passed and public metadata was checked through the Windows trust store. Published CI smokes exercise the live availability gate.
- Linux preflight and bounded CI smoke tests do not substitute for a long deployed Windows-host Docker soak. Development and inspection did not modify the live installation or external repository.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
