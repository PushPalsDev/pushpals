# September 7 run: validation routing and durable PR reviews

## Evidence and scope

The supplied SectorCommand transcript ran CLI/runtime **v1.2.50**, starting at
`2026-09-07T01:05:08Z`. It predates v1.2.51's Astra migration. This investigation
read the target repository's SQLite databases and bootstrap logs without changing
them. The session was still running; counts below use jobs created before
`2026-09-07T09:54:00Z` to keep later jobs out of the comparison.

| Terminal attempt status         | Count | Average duration |
| ------------------------------- | ----: | ---------------: |
| Completed/publication succeeded |     5 |     18.4 minutes |
| Failed                          |    10 |     14.4 minutes |
| Publication blocked             |     6 |     20.7 minutes |

Publication success is not itself proof that a PR passed review without revisions.
The defects below explain repeated wasted attempts, not every possible rejection.

## Confirmed defects

### Focused tests used the wrong runner

Shared validation inference and the worker's fallback command builder assumed
that JavaScript test paths in a Bun-owned repository could use `bun test`.
That mixed Bun tests with Vitest tests and bypassed repository-selected Vitest
configuration. One attempt used a direct `.vitest.ts` filter that Bun did not
recognize at all; another unconfigured Vitest command selected the wrong suite.

The generic fix resolves ownership from the nearest package manifest, test-runner
imports, package scripts, and statically readable configuration. It retains the
repository's complete script, including its environment, setup, and runner pool.
Ambiguous or dynamic configuration is not treated as proven test coverage.
Mandatory validation gates are retained. Tests cover mixed runners, nested
packages, custom selectors, exclusions, and wrong-suite false positives.

### Restart and retry could rescore an unchanged rejected PR

SCM retained review decisions in memory. After the `07:05Z` health-triggered
restart, PR #700's unchanged head was reviewed again: its score changed from 7.8
to 8.3 while an existing repair was still validating. The PR merged, the repair
then hit a stale-base publication guard, and a subsequent repair tried to fetch
the deleted branch. PR #699 also underwent repeated review after repair admission
reported an exhausted lifecycle.

The fix persists exact-revision review decisions and repair admission state,
reuses a saved verdict after restart/transport retry, and checks active repairs
before review or merge. A transient admission failure must not become another
chance for an unchanged candidate to receive a different AI score. New revision
or review-policy evidence is distinguished from retrying the same decision.

### Expected error logs displaced the actual failure evidence

Five publication-blocked attempts encountered the same trusted-host account test
timeout. Their repair prompts included expected negative-path application logs
ahead of the test runner's failure. This also introduced unrelated test paths.
Alphabetical ordering and truncation could discard the useful diagnostic before
the durable handoff. Bun's repeated failure summary could attribute failures to
the last passing file, and passing test names containing “compile” or “timeout”
could distort classification.

The fix prioritizes named failures and actual diagnostics before bounding evidence,
keeps output tails on line boundaries, preserves distinct files with identical
test names, and excludes passing-test labels from failure classification. Tests
exercise the complete completion-to-autonomy incident path, noisy multi-job
fingerprints, huge neighboring logs, and nominal-zero child-process failure vetoes.

## What is not established

- Two repeatedly observed Bun-suite failures were repository-test defects, not
  dependency projection: a source assertion assumed a one-line dynamic import,
  and an executable-file fixture lacked POSIX execute permissions. The first job
  repaired both in candidate commit
  `cc0ce18dc5c503d7d04e3c91e5831f06d76663be`; its first Bun validation failed and
  its next two passed. The separate trusted-host account timeout then blocked
  publication. Later jobs could therefore encounter the original baseline
  defects again. A later passing result is not contradictory evidence for the
  unchanged original candidate.
- The SCM health failures were HTTP transport deadlines, not explicit unhealthy
  tick responses. They overlapped trusted validation and SCM-to-server request
  delays. No specific synchronous event-loop blocking defect was reproduced.
  Watchdog bounds remain unchanged. An isolated real-child regression checks that
  HTTP health stays responsive during validation, timeout termination, and pipe
  draining; Windows CI and release gates exercise it.
- The account timeout was a real repository validation failure. Incorrect runner
  selection and noisy repair context made its repair harder; neither a model
  upgrade nor a test-routing fix proves that the repository test is repaired.
- Some worker failures correctly rejected substantive problems, including a test
  change that could pass without exercising real socket behavior. Quality gates
  must continue rejecting such candidates.
- These changes do not retroactively mark failed jobs successful, mutate the live
  target repository, or establish a new live-job soak result. Heavy regression
  validation runs in a resource-capped isolated container, not another target-repo
  workload on the Windows host.

## Pre-release review corrections

Independent review found and corrected additional edge cases before publication:

- Legacy databases must add the repository-identity column before building its
  index. Strict URL-derived backfill preserves exhausted history without granting
  new repair capabilities or silently resetting retry limits.
- Dispatching a merge-conflict repair is not a finalized review. Its retained
  verdict remains eligible for lifecycle checks after restart, finalization,
  circuit settlement, and exhaustion.
- Imported/dynamic runner configuration and commented-out selectors are not
  proof that a script discovers a changed test. Ambiguous configurations remain
  unresolved rather than replacing a focused command with unrelated coverage.
- Compiler evidence retains priority after coordinate normalization, including
  TypeScript's pretty-output format. Incidental timeout logs and zero-failure
  summaries must not redirect a compiler/dependency repair.

The regression fixtures exercise database upgrades and close/reopen recovery,
not just fresh in-memory state. Release validation remains separate from a
long-duration live target-repository soak. In particular, historical corruption
such as a repair lifecycle pointing at a nonexistent job requires authoritative
reconciliation; this change does not invent replacement jobs or permissions.

## Local release validation

The final isolated Bun 1.3.14 run passed **2,308 tests**, with **12 platform/opt-in
skips**, **0 failures**, and **12,899 assertions** across **173 files**. The
container was limited to one CPU and 768 MiB memory, with native Linux dependency
storage and no target-repository mount or Docker socket.

The full CLI bundle and actual npm payload inspection passed. The package had
272 files and no external toolchain payloads; the Windows payload inspection also
passed. All 77 checked canonical shared/worker/config source mirrors matched the
generated runtime after line-ending normalization. Cross-platform installed-CLI
and Docker integration gates must still pass on the final product commit before
tagging, as required by the release playbook.
