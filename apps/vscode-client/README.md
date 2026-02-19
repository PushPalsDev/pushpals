# PushPals VS Code Client

`pushpals-vscode-client` is a VS Code extension client that can:

- Start the local PushPals stack (`server`, `localbuddy`, `remotebuddy`, `workerpals` in Docker mode).
- Build/check the worker Docker image if needed.
- Open an in-editor client panel to send prompts and stream session events.

## Commands

- `PushPals: Open VS Code Client`
- `PushPals: Start Local Stack`
- `PushPals: Stop Local Stack`
- `PushPals: Show Extension Output`

## Settings

- `pushpals.serverUrl` (default: `http://127.0.0.1:3001`)
- `pushpals.authToken` (optional)
- `pushpals.workerDockerImage` (default: `pushpals-worker-sandbox:latest`)
- `pushpals.includeSourceControlManager` (default: `false`)
- `pushpals.autoStartStackOnActivate` (default: `false`)

## Packaging

From repo root:

```bash
bun run --cwd apps/vscode-client compile
bun run --cwd apps/vscode-client package
```

This emits a `.vsix` package in `apps/vscode-client`.
