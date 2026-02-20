# 05. LocalBuddy (`apps/localbuddy`)

## Purpose

LocalBuddy is the user ingress service and fast responder. It sits between client UX and deeper orchestration.

Main responsibilities:

- accept user prompts on `POST /message`,
- answer lightweight questions locally when appropriate,
- route execution-heavy requests into the Request Queue for RemoteBuddy,
- provide status lookup and read-only helper behaviors.

## Key Files

- `apps/localbuddy/src/localbuddy_main.ts` - HTTP entrypoint and routing logic.
- `apps/localbuddy/src/local_readonly.ts` - local read-only query handling.
- `apps/localbuddy/src/request_status.ts` - request/job status response helpers.
- `apps/localbuddy/src/planner.ts` - heuristic/LLM planning adapter for local tasks.

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
- Ambiguous prompts:
  - bias toward safe local clarification or explicit routing prompt.

## Why This Layer Exists

Without LocalBuddy, every user interaction would hit deep orchestration paths, increasing latency and noise.

LocalBuddy provides:

- low-latency UX,
- better handling of simple prompts,
- explicit handoff when deeper work is needed.

## Reliability Details

- Prompt sanitization for local LLM replies.
- Fallback reply behavior when structured output is malformed.
- Lightweight failure summarization for user-visible status.

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
