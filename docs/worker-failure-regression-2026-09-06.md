# Worker failure investigation: September 6, 2026

## Observed run

The stopped SectorCommand session used CLI `1.2.49`. Read-only inspection of its
database found four jobs, not a startup crash or another missing-result incident:

| Job prefix | Terminal outcome | Duration     | Evidence                                                                      |
| ---------- | ---------------- | ------------ | ----------------------------------------------------------------------------- |
| `ed17c177` | failed           | 19.7 minutes | Codex timed out during a later critic repair; partial candidate retained.     |
| `1e92e75c` | failed           | 18.9 minutes | Codex timed out during critic repair; partial candidate retained.             |
| `de996808` | publish_blocked  | 24.2 minutes | Worker critic score 8.7; trusted-host account test timed out after 5 seconds. |
| `34837dc5` | failed           | 19.8 minutes | Another late critic repair timed out; partial candidate retained.             |

These durations are database job durations, not model-call latency. The earlier
structured-result transport regression did not recur. Candidate generation,
worker validation, critic acceptance, trusted validation, and publication are
different gates; reaching one is not end-to-end success.

## Failure mechanisms and regression contracts

- Late quality revisions inherited the first-turn minimum coding allocation.
  That could leave zero reserved validation time. A continuation message also
  advertised a fresh fixed budget although the monotonic deadline correctly
  prevented an extension. Revision allocation must reserve gate time and report
  the actual remaining budget. A retained timeout candidate is eligible only
  for independent gates within that original deadline, never automatic success.
- Worker repair summaries led with a deliberately deferred Docker-dependent
  command instead of the concrete runnable test failures. Deferred host gates
  must remain mandatory publication checks without becoming impossible sandbox
  repair instructions.
- The timeout retry matcher interpreted Bun's nested `error: script ... exited
with code 1` summaries as independent errors. The completion therefore recorded
  zero recovery attempts. Regression tests must execute real nested Bun scripts,
  covering both retry recovery and a second failure that remains blocked, plus
  mixed assertions that must not qualify for this retry.
- A terminal trusted-host failure had an exact retained candidate and named test
  evidence, but the repair detector required failures from two different jobs.
  One actionable failure should admit one incident-scoped repair; this is not
  permission to bypass the separate cross-job publication circuit or candidate
  authority checks.
- RepositoryAgent returned invalid autonomy values such as risk `normal`,
  trigger `vision_priority`, and effort `1-2 days`. The consumer discarded the
  proposals and used deterministic fallback ideas, while the cached analysis
  continued to receive evidence confirmations. Producer and consumer must share
  the candidate contract, invalid data must not become a reinforced cache hit,
  and new executed outcomes must inform fresh analysis.
- Phase diagnostics copied the terminal failure onto earlier intervals and
  truncated away the end of long revision loops. Closed log intervals now mean
  `transitioned`, not passed or failed; terminal outcome and omitted intervals
  remain explicit. Validation-run records are the pass/fail authority.

## Verification boundary

Regression fixtures use generic repositories and test names; production fixes
must not recognize SectorCommand paths or business rules. Docker tests, Windows
subprocess contracts, packaged-asset parity, and release smoke checks exercise
the harness failures above. They do not prove that every generated patch is
correct or that this repository's persistent account-test defect is repaired.
Only a new live run can establish new end-to-end job and PR outcomes. Preserve
real validation and critic failures rather than making a dashboard green.
