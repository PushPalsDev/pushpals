# 05. LocalBuddy (`apps/localbuddy`)

## Purpose

LocalBuddy is an optional fast-ingress service for callers that want lightweight replies before deeper orchestration.

Main responsibilities:

- accept user prompts on `POST /message`,
- answer lightweight questions locally when appropriate,
- route execution-heavy requests into the Request Queue for RemoteBuddy,
- provide status lookup and read-only helper behaviors.

## Component Contract

- Receives: a repo-scoped session and prompt through `POST /message`.
- Owns: ingress validation, local-versus-remote routing, and lightweight read-only responses.
- Produces: an immediate session reply or a durable request for RemoteBuddy.
- Does not own: deep planning, code execution, queue persistence, or commit integration.

The handoff is intentionally small: `message -> local reply` or `message -> request enqueue`.

## Key Files

- `apps/localbuddy/src/localbuddy_main.ts` - HTTP entrypoint and routing logic.
- `apps/localbuddy/src/local_readonly.ts` - local read-only query handling.
- `apps/localbuddy/src/request_status.ts` - request/job status response helpers.

`apps/localbuddy/src/planner.ts` and `apps/localbuddy/src/tools.ts` are dormant
legacy modules: the production entrypoint does not import them. In particular,
the broad tool registry in `tools.ts` is not an active LocalBuddy capability or
permission boundary. The composition root also constructs the shared
RepositoryAgent/memory client bundle for lifecycle consistency, but the current
LocalBuddy request path does not call either capability.

## Behavioral Model

When a message arrives, LocalBuddy decides:

- Local quick reply path:
  - short conversational response,
  - status/read-only answer,
  - no worker dispatch.
- Remote dispatch path:
  - enqueue request for RemoteBuddy planning and execution.

It also supports explicit routing via `/ask_remote_buddy ...`.

## Routing Heuristics (Conceptual)

- Lightweight and status/read-only prompts:
  - prefer local response path.
- Explicit execution prompts or `/ask_remote_buddy`:
  - force RemoteBuddy enqueue path.
- Other prompts without an execution cue:
  - handle locally when they are at most 120 characters,
  - enqueue longer prompts for RemoteBuddy.

## Why This Layer Exists

For callers that use it, LocalBuddy keeps simple chat, status, and read-only requests out of deeper orchestration paths.

LocalBuddy provides:

- low-latency UX,
- better handling of simple prompts,
- explicit handoff when deeper work is needed.

## Reliability Details

- Prompt sanitization for local LLM replies.
- Fallback reply behavior when structured output is malformed.
- Lightweight failure summarization for user-visible status.

## Quick Debugging

1. Confirm LocalBuddy resolved the expected repository root and Server URL.
2. Check whether the prompt chose the local or remote path.
3. For remote work, follow the returned `requestId` in the Server queue and session events.

## Safe Change Guidance

When editing LocalBuddy:

1. Preserve explicit `/ask_remote_buddy` override behavior.
2. Keep local-reply fallbacks deterministic for malformed model output.
3. Avoid adding hidden routing side effects that bypass request queue visibility.

## Tradeoffs

Pros:

- faster perceived responsiveness,
- fewer expensive remote planning cycles,
- clearer UX boundary between "chat" and "execute".

Cons:

- additional intent-routing complexity,
- possible false positives/negatives in local vs remote routing,
- duplicated prompt parsing concerns across layers.

## Future Improvements

- Add explicit confidence score emission for routing decisions (for telemetry and tuning).
- Add configurable policy profiles for local-only teams vs worker-heavy teams.
- Add incremental streaming responses for local quick replies in UI.
