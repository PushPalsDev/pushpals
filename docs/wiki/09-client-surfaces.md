# 09. Client Surfaces (CLI, Expo, and VS Code)

## Why There Are Three Clients

PushPals has three user surfaces with different strengths:

- `packages/cli` (terminal):
  - repo-scoped chat and embedded runtime supervision,
  - minimal terminal-first setup.

- `apps/client` (Expo web/mobile):
  - mission-control dashboard,
  - live event timeline,
  - request/job/system observability.
- `apps/vscode-client` (VS Code extension):
  - in-editor control,
  - local stack start/stop,
  - editor-native chat panel and logs.

## Terminal CLI (`packages/cli`)

### Key Files

- `scripts/pushpals-cli.ts` - terminal UX, repo attachment, and embedded runtime supervision.
- `packages/cli/bin/pushpals.cjs` - installed npm launcher and Bun bootstrap watchdog.
- `packages/cli/README.md` - installation and common command reference.
- `packages/cli/runtime/` - packaged configuration, prompts, schemas, and runtime bundles.

### Runtime Model

The CLI runs from the current git repository and submits chat through the Server session API. If the local stack is unavailable, it can start the packaged control services and WorkerPal capacity, storing repo attachment state in the repository's Git metadata directory and installed assets under `~/.pushpals/runtime`. `pushpals --clear` removes repo-local PushPals state. The CLI owns terminal interaction and supervision; planning, execution, and publication remain with their runtime services.

## Expo Client (`apps/client`)

### Key Files

- `apps/client/app/index.tsx` - page shell and tab orchestration.
- `apps/client/src/components/*` - extracted panes and dashboard primitives.
- `apps/client/src/lib/usePushPalsSession.ts` - session/event hook and state reducer plumbing.
- `apps/client/src/lib/pushpalsApi.ts` - transport and API calls.

### UX Model

- "Coordination-first" UI:
  - flow ribbon,
  - queue tiles,
  - tabbed panes (coordination, chat, requests, jobs, system).
- Session stream drives real-time UI state.
- Polling snapshots augment event stream for queue/system summaries.

### Developer Workflow

- Start stack (`bun run start`) then open web client.
- Use Coordination tab for pipeline state.
- Use Chat tab to submit prompts and route remote work.
- Use Requests/Jobs/System tabs for queue and service diagnostics.

### Tradeoffs

Pros:

- strong observability for multi-service workflow,
- clearer mental model for "where is my request now?".

Cons:

- more complex than a plain chat UI,
- requires careful synchronization between stream and polled snapshots.

### Future Improvements

- Replace some polling paths with unified streaming snapshots.
- Add drill-down inspectors for individual request/job/completion lineage.
- Add keyboard-driven power-user actions in web client.

## VS Code Extension (`apps/vscode-client`)

### Key Files

- `apps/vscode-client/src/extension.ts` - activation, commands, trust checks.
- `apps/vscode-client/src/serviceManager.ts` - local stack orchestration and preflights.
- `apps/vscode-client/src/clientPanel.ts` - webview chat/events panel and reconnect handling.

### Core Behavior

- Commands to start/stop local stack.
- Preflight checks:
  - Bun runtime,
  - protocol build,
  - Docker daemon and worker image availability/build.
- Optional include of SourceControlManager in startup profile.
- Workspace trust gating for stack operations.

### Startup Preconditions

- Workspace root must be the PushPals repo.
- Required local config files must exist (`.env`, `configs/local.toml`).
- Bun and Docker must be available for stack orchestration.

### Notable Engineering Detail

The extension scripts use `bunx tsc` / `bunx @vscode/vsce` instead of raw `tsc`/`vsce` binaries so package/lint commands work in environments without global installs.

### Tradeoffs

Pros:

- excellent developer ergonomics in editor workflow,
- central place to bootstrap local stack.

Cons:

- process orchestration complexity in extension host,
- platform-specific process shutdown edge cases (especially Windows).

### Troubleshooting Quick Hits

- `tsc` not found while packaging:
  - use extension scripts that call `bunx tsc`.
- Stack start fails in extension:
  - inspect extension output channel preflight logs.
- Client panel disconnected:
  - verify `pushpals.serverUrl` and server runtime status.

### Future Improvements

- Add extension health panel with service-level readiness diagnostics.
- Add per-service restart command and recovery workflows.
- Add richer inline event filters and request routing shortcuts.
