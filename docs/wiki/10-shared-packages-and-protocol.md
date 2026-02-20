# 10. Shared Packages and Protocol

## `packages/protocol`

`packages/protocol` defines the contract language for cross-service communication.

Responsibilities:

- protocol version constant,
- event and request/response types,
- validation functions for envelope integrity.

Important files:

- `packages/protocol/src/version.ts`
- `packages/protocol/src/types.ts`
- `packages/protocol/src/validate.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/index.browser.ts`

Design goal: every service can validate inbound/outbound payloads against the same source.

## `packages/shared`

`packages/shared` contains cross-cutting infrastructure that should not be duplicated in apps.

Key modules:

- `packages/shared/src/config.ts`
  - typed config loader and normalization.
- `packages/shared/src/communication.ts`
  - common emit/subscribe helpers for session transport.
- `packages/shared/src/autonomy_policy.ts`
  - path normalization, glob matching, scope invariants, policy scoring helpers.
- `packages/shared/src/repo.ts`
  - repo root detection/context helpers.
- `packages/shared/src/prompts.ts`
  - prompt template loading.

## Why This Split Is Important

Without shared packages:

- each app would parse config differently,
- protocol drift would be likely,
- policy logic would fork and become inconsistent.

With shared packages:

- behavior is more consistent across services,
- migrations happen in one place,
- onboarding is easier once engineers understand package boundaries.

## Tradeoffs

Pros:

- reduced duplication,
- stronger consistency guarantees,
- easier to test shared logic once and reuse everywhere.

Cons:

- shared packages can become dumping grounds if not curated,
- backward compatibility concerns can slow refactors.

## Future Improvements

- Add explicit API stability levels for shared exports.
- Add contract tests that run each service against protocol fixtures.
- Add config deprecation tooling with warning windows and migration hints.
