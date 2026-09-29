# PushPals CLI Release Log

## Release Metadata

- version: `v1.2.60`
- start_commit: `8a269fa471a34f6ad0cf658e54e1e185e5cc3991`
- end_commit: `85ebbf66d0b32b1092bcbda37c7919d9820b3715`
- commits_in_range: `1`

## Highlights

- Schedule bounded discovery follow-ups after five seconds instead of thirty when workers are verified idle. Rank repository evidence by explicit vision priorities, preserve exact-path precedence, and spread initial evidence across relevant components without dropping eventual coverage. Non-goals and unclassified guardrail sections never become positive autonomy retrieval topics.
- Give workers an explicit, host-derived validation ownership manifest so editing uses focused checks without repeating required aggregate suites. Preserve complete quoted validation commands, including fallback prompts, and retain the required final gate sequence. Disabled or missing ownership no longer promises a nonexistent validation handoff.
- Fence Codex's early watchdog and recovery handoffs with the enabled validation owner. Without a configured final gate, partial work remains non-passing or continues within its deadline; prompt prose cannot authorize an automatic success.
- Bound validation-file inspection by file type, physical repository containment, byte limits, and reference counts. Pipes, unsafe links, and oversized manifests cannot stall the new pre-executor inspection path. Unsafe existing vision requirements fail explicitly rather than silently disappearing.
- Preserve Bun's native warm dependency cache by default. Add opt-in isolated package-artifact reuse with candidate-specific lifecycle hooks and a copy backend that prevents hook mutations from poisoning later candidates. Respect operator npmrc/Bun configuration, including offline and XDG caches.
- Emit bounded, observation-only validation substep timings and persist them with job diagnostics. Nested or ambiguous markers remain incomplete rather than inventing short durations or passes. Add regression coverage, update the Repository Agent/memory architecture diagram and operational docs, and regenerate the packaged runtime.

## Validation

- Full root suite: `3,069` passed, `12` platform/opt-in skips, `0` failures, and `17,097` assertions across `197` files (322.65 seconds).
- Final Python backend suite: `153` tests passed, including composed ownership/recovery prompts, complete fallback commands, and enabled/disabled watchdog handoffs. Independent review findings were fixed and regression-tested.
- Final packaged-runtime/prompt/payload checks: `54` passed, `1` image-dependent skip, and `0` failures. Nine source/runtime mirrors were byte-identical after copying back the generated assets.
- Full `cli:bundle`, including monitoring UI export, and package-payload verification passed in an isolated Docker checkout limited to one CPU, 768 MiB memory, and 512 PIDs. The package contains `278` files with no external toolchains. Shared, WorkerPals, RemoteBuddy, Server, and SCM TypeScript checks passed.
- Native offline-install regressions verify operator-cache preservation and candidate-hook isolation. Bounded child-process regressions cover FIFO inspection; timing tests cover nested markers, duplicate labels, limits, redaction, and persistence.
- Product commit `85ebbf66d0b32b1092bcbda37c7919d9820b3715` passed [CLI E2E run `36517723232`](https://github.com/PushPalsDev/pushpals/actions/runs/36517723232): packaged CLI and real-Docker WorkerPal control-plane tests on Linux, plus Windows worktree/recovery/trusted-validation/source-only startup contracts. The separate manual-only Windows-host Docker job was skipped as configured.

## Install

```bash
npm install -g @pushpalsdev/cli@1.2.60
```

```bash
bun install -g @pushpalsdev/cli@1.2.60
```

For environments using a managed certificate store:

```bash
bun install -g --use-system-ca @pushpalsdev/cli@1.2.60
```

## Artifacts

- Standalone CLI and PushPals runtime binaries for Linux x64, Windows x64, macOS x64, and macOS arm64.
- `SHA256SUMS.txt`.
- No separately vendored third-party toolchains.

## Compatibility Notes

- No configuration migration is required. Existing repository memory and bounded discovery coverage are retained; changed evidence ordering is reconciled through existing fingerprints.
- Required validation commands and their deterministic final execution sequence remain authoritative. Focused-check suggestions are guidance, not reusable pass evidence or permission to bypass a gate.
- Set `PUSHPALS_TRUSTED_ISOLATED_ARTIFACT_CACHE=1` only to opt into the new isolated dependency-artifact mode. Normal installs keep native/operator cache behavior. Candidate lifecycle hooks still run; validation results are not cached by this optimization.
- Substep timing is best-effort observability. Scripts without supported markers retain command-level timing; child markers cannot determine job success, renew health leases, or authorize publication.

## Known Issues

- The Windows installed-package smoke observed a SourceControlManager singleton-lock collision during an immediate same-repository restart (`--status-once` followed by `--runtime-only`) in [release attempt 2](https://github.com/PushPalsDev/pushpals/actions/runs/36518343608/attempts/2). The first session passed readiness; the second reported another SCM instance and exited. Available logs cannot distinguish incomplete shutdown, stale PID reuse, or another lock-file acquisition error. This release does not fix that restart finding; a passing retry is not proof that it is resolved.
- npm accepted this version before making it publicly installable. The first installed-package smoke attempts received version-not-found errors during registry processing and were retried after `1.2.60` became visible. No npm reauthentication or duplicate publication was needed.
- These tests do not establish a production average job duration, first-pass PR merge rate, or a 100% success/uptime guarantee. A fresh isolated artifact cache can be colder than an operator's existing cache; the optional mode is not a proven universal speedup.
- Regular-file inspection is byte-bounded and rejects special files, but this does not guarantee a wall-clock deadline for every operating-system or network-filesystem call. An unsafe or oversized existing `vision.md` now reports an explicit inspection failure.
- Linux preflight and bounded CI smoke tests do not substitute for a long deployed Windows-host Docker soak. The manual-only Windows-host Docker E2E job is not part of ordinary push-triggered gates. Development and monitoring did not modify the live installation or external repository.
- The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Docker-backed WorkerPal execution requires Docker to be installed and running.
- Some Windows environments require `--use-system-ca` for Bun installs or Schannel for Git remote operations.
