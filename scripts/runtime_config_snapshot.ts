#!/usr/bin/env bun

import { loadLocalBuddyRuntimeSnapshotFromFiles } from "../packages/shared/src/localbuddy_runtime.js";

const config = loadLocalBuddyRuntimeSnapshotFromFiles(process.cwd(), process.env);

console.log(
  JSON.stringify({
    localbuddy: {
      enabled: Boolean(config.localbuddy.enabled),
      port: config.localbuddy.port,
    },
  }),
);
