# PushPals VS Code Client

`pushpals-vscode-client` is a VS Code extension client that can:

- Start the local PushPals stack for the current git repo.
- Use the installed `pushpals` CLI for arbitrary repos, or the repo-local Bun scripts when the workspace is a PushPals source checkout.
- Build/check the worker Docker image if needed.
- Open an in-editor client panel to send prompts and stream session events.

## Commands

- `PushPals: Open VS Code Client`
- `PushPals: Start Local Stack`
- `PushPals: Stop Local Stack`
- `PushPals: Show Extension Output`

## Settings

- `pushpals.serverUrl` (default: `http://127.0.0.1:3001`)
- `pushpals.workerDockerImage` (default: `pushpals-worker-sandbox:latest`)
- `pushpals.includeSourceControlManager` (default: `false`)
- `pushpals.autoStartStackOnActivate` (default: `false`)
- `pushpals.cliCommand` (default: `pushpals`, or `pushpals.cmd` on Windows when unset)

## Packaging

From repo root:

```bash
bun run --cwd apps/vscode-client compile
bun run --cwd apps/vscode-client package
```

This emits a `.vsix` package in `apps/vscode-client`.
