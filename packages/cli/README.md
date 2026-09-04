# @pushpalsdev/cli

The PushPals CLI is the terminal client and optional local runtime supervisor. It submits messages through the Server session control plane, streams lifecycle events, and can start the packaged Server, LocalBuddy, RemoteBuddy, and SourceControlManager when no healthy runtime is already serving the current repository. Planning, execution, and publication remain owned by those services.

## Install

```bash
npm install -g @pushpalsdev/cli
```

`bun install -g @pushpalsdev/cli` is also supported. On Windows hosts with a
managed certificate store, use
`bun install -g --use-system-ca @pushpalsdev/cli` so Bun trusts the system CAs.

The npm entrypoint requires Node.js 20+ and Bun 1.3.14+. Native binaries are also available from [GitHub Releases](https://github.com/PushPalsDev/pushpals/releases).

### Windows Bun resolution

It is possible to have more than one Bun installation on Windows, especially
after installing Bun both from bun.sh and npm. The CLI checks the Bun
executables reported by `where.exe bun` in PATH order and uses the first one
that satisfies its minimum version. Global and project-local npm `bun` and
`bun.cmd` shims are resolved to their native `node_modules/bun/bin/bun.exe`
target before launch.

To inspect or repair a runtime mismatch:

```powershell
where.exe bun
Get-Command bun -All
bun upgrade
```

For an npm-managed installation, use `npm install -g bun@1.3.14`. You can also
pin the launcher to a specific native executable for the current shell:

```powershell
$env:PUSHPALS_BUN_BIN = "$env:APPDATA\npm\node_modules\bun\bin\bun.exe"
pushpals --version
```

## Common Commands

Run from inside the Git repository you want PushPals to manage.

| Command                         | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `pushpals`                      | Connect or auto-start, then open interactive chat and event streaming. |
| `pushpals --runtime-tag vX.Y.Z` | Pin embedded assets and binaries to a release.                         |
| `pushpals --no-auto-start`      | Require an existing healthy runtime.                                   |
| `pushpals --runtime-only`       | Supervise the local runtime without interactive chat.                  |
| `pushpals --status-once`        | Print endpoints and readiness once, then exit.                         |
| `pushpals --version`            | Print CLI, Bun runtime, and platform versions, then exit.              |
| `pushpals --open-config`        | Open the active local runtime configuration.                           |
| `pushpals --clear`              | Stop the repo's managed runtime and remove repo-local PushPals state.  |

The CLI refuses to run outside a Git repository or against a Server attached to a different repository. Embedded release assets live under `~/.pushpals/runtime`; repo-specific CLI state lives in the repository's Git metadata directory.

## Implementation Map

- `bin/pushpals.cjs` - npm shim, Bun version check, bootstrap watchdog, and signal forwarding.
- `bin/bun-runtime.cjs` - Windows Bun candidate discovery, version selection, and probe budgeting.
- `../../scripts/pushpals-cli.ts` - bundled CLI, preflights, runtime supervision, session transport, and interactive commands.
- `../../scripts/sync-cli-runtime-assets.ts` - packaged runtime mirror generation.
- `package.json` - package payload and build contract.

For startup flow, component boundaries, and troubleshooting, see [Client Surfaces](../../docs/wiki/09-client-surfaces.md).
