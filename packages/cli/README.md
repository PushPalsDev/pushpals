# @pushpalsdev/cli

Terminal-first PushPals client that routes chat through `LocalBuddy -> RemoteBuddy`.

## Install

```bash
npm i -g @pushpalsdev/cli
```

or:

```bash
bun install -g @pushpalsdev/cli
```

## Run

From a git repository that is attached to your running PushPals stack:

```bash
pushpals
```

The CLI hard-fails if:

- current directory is not a git repository
- LocalBuddy is unavailable
- LocalBuddy is attached to a different repo root
- Bun runtime is not installed (for npm-installed entrypoint execution)

## No npm/Bun install

Download native binaries from GitHub Releases:

https://github.com/PushPalsDev/pushpals/releases
