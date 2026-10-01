# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.64`
- start_commit: `65c0b8043c9f1358cf97e45f284ed85ba227eb4b`
- end_commit: `a34a885c32e624085af3be6bf3d7e665a11dd0c0`
- commits_in_range: `2` (one product fix and the prior release's verification record)

## Highlights

- Avoid unnecessary review repairs for legitimate parameterized-test refactors. Shared test-hygiene evidence distinguishes suites, cases, disabled/focused tests, and uncertain coverage; demonstrated coverage loss still blocks publication.
- Require complete, byte-bounded diff evidence for worker criticism and PR review. Oversized, missing, or truncated evidence produces an explicit retained-candidate hold instead of approval from a partial patch. Review evidence records the changed-file manifest and digest, with head/base race checks.
- Bind publication validation to the exact candidate tree for ordinary jobs as well as PR repairs. Changed or unreadable trees require the complete frozen worker plan; unchanged trees can reuse worker results and run only deferred gates. Missing legacy plans have bounded retries and a durable hold, allowing other completions to progress.
- Let RepositoryAgent request a small amount of additional same-commit evidence within its existing deadline and two-call ceiling. Distinguish insufficient evidence from no actionable work, preserve evidence cache dependencies, and avoid treating rejected, never-dispatched ideas as recently completed work. No repository-specific rules were added.
- Separate executed, deferred, and not-started validation checks in durable diagnostics and autonomy metrics. Trusted-host handoffs and unstarted checks no longer masquerade as executed failures; all required gates remain authoritative.
- Capture reported Codex usage separately from text estimates, without counting tool transcripts as generated tokens. Persist bounded attempt-level usage, command durations, validation substeps, and actual-output quiet age. The commit-message helper uses a bounded, isolated, tool-disabled task and reports why it falls back.
- Keep server health probes independent of database and log writes. Add bounded log-sink and active-operation diagnostics to help explain correlated stalls without weakening recovery thresholds or claiming an unproven root cause. Refresh all packaged runtime mirrors and extend reliability harness coverage.

## Four-Hour Observation Behind This Release

- Observed the prior release, `v1.2.63`, from `2026-10-01 07:48:09 UTC` through `11:48:09 UTC`, without restarting or modifying the live installation or target repository.
- Seven jobs completed with zero terminal failures; six product PRs merged. Five of the six PRs passed review first time. One parameterized-test refactor triggered an unnecessary repair, motivating the shared test-hygiene fix.
- Original product jobs averaged `15.63` minutes through publication. The final `104m27s` had no new product job despite healthy idle workers, motivating bounded evidence follow-up and clearer discovery outcomes.
- Of fourteen non-passing validation observations, only three represented failed executions; nine were trusted-host deferrals and two were unstarted checks. Reported token totals also mixed measured and inflated estimated usage.
- One roughly twenty-second correlated service responsiveness incident recovered without restart. Its cause remains unproven; minute-level successful probes do not establish uninterrupted uptime. The new release has not itself undergone a four-hour deployed soak.

## Validation

- Complete root suite in an isolated Linux container: `3,296` passed, `12` platform/opt-in skips, `0` failures, and `19,843` assertions across `209` files (299.24 seconds), including the monitoring UI tests.
- Protocol integration: `51` passed. Prompt policy: `2` passed. Python Codex streaming/command-timing regressions: `12` passed. The final focused worker/review/observability run passed `329` tests; harness registration/cleanup passed `12` tests.
- Server, WorkerPals, RemoteBuddy, and SourceControlManager TypeScript checks passed. Full CLI bundle and monitoring UI export passed. Actual npm package payload verification passed with `286` files and no vendored external toolchains. Formatting and diff checks passed.
- Final product commit `a34a885c32e624085af3be6bf3d7e665a11dd0c0` passed [CLI E2E run 36862134039](https://github.com/PushPalsDev/pushpals/actions/runs/36862134039): complete Linux release preflight, real-Docker WorkerPals control-plane execution, packaged CLI E2E, and Windows contracts/source-only runtime startup. The manual-only Windows Host Docker E2E job was skipped as configured.
- Hosted preflight's complete root suite passed `3,297` tests with `12` platform/opt-in skips, `0` failures, and `19,853` assertions across `209` files (204.07 seconds).
- The exact commit's hosted generated-runtime artifact was downloaded and inspected: `runtime-assets.patch` is empty, confirming the committed runtime bundles match the hosted build.
- Independent reviews covered validation authority, cache provenance, complete review evidence, usage accounting, and helper isolation. Resulting fixes and regression tests were included before the final full-suite run.
- Local Bun execution stayed inside disposable Docker containers capped at two CPUs and 4 GiB RAM, without a Docker socket, host bind mounts, or exposed service ports. Dependencies were installed with explicit public managed-CA trust; TLS verification was not disabled. No live SectorCommand installation or services were changed.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.64
```

```bash
bun install -g @pushpalsdev/cli@1.2.64
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.64
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No manual database migration is required. Upgrade all services together for full validation-plan and diagnostic support; old queued candidates without a complete authoritative validation plan may need intervention after their bounded retries.
- The existing `quality_critic_max_diff_chars` config key now represents a complete UTF-8 byte budget; the default is `65,536`. Explicit local overrides, including the former `16,000` value, are preserved and may hold larger patches. SCM review has a separate `150,000`-byte ceiling. Increase an obsolete small worker override or split the patch; incomplete evidence is never silently approved.
- Required validation order, publication backpressure, exact-candidate checks, and candidate-specific lifecycle hooks remain authoritative. Failures are not converted into successful jobs or bypassed for speed. Changed candidate trees can require more validation than before because prior results no longer prove the new tree.
- Codex helper launch and usage handling follow the official noninteractive/configuration guidance. Reported input/output totals and labeled estimates are not a billable-cost calculation; command categories and bounded retained details are diagnostic evidence, not proof of successful validation.

## Known Issues

- Exact-version metadata/tarball visibility can precede the package-index visibility needed by Bun installation. The current availability gate does not check both package-index variants; retry only a failed installed-package smoke after confirming propagation, never npm publication.
- Bounded evidence follow-up cannot guarantee actionable work exists, that every generated change has product impact, or that infrastructure remains healthy. Honest deferrals and review holds remain possible.
- This release does not claim a clean repository-wide standalone CLI TypeScript check; the scoped service/package checks listed above passed.
- Hosted tests and bounded smokes do not substitute for a long deployed Windows-host Docker soak of this release or establish a sub-ten-minute job average, improved vision alignment, or 100% success/uptime. The four-hour observations above apply to the previous release, not the new fixes.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
