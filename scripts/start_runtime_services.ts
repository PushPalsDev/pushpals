export {
  computeLocalBuddyRestartBackoffMs,
  resolveLocalBuddyRuntimeAction,
  resolveLocalBuddyStartGate,
  type LocalBuddyRuntimeAction,
  type LocalBuddyStartGateReason,
} from "../packages/shared/src/localbuddy_runtime.js";

export type ManagedServiceSpec = {
  name: string;
  color: string;
  command: string;
};

export function buildCoreManagedServiceSpecs(): ManagedServiceSpec[] {
  return [
    { name: "server", color: "blue", command: "bun run server:only" },
    { name: "remotebuddy", color: "red", command: "bun run remotebuddy:only" },
    { name: "workerpals", color: "yellow", command: "bun run workerpals:only:docker" },
    {
      name: "source_control_manager",
      color: "cyan",
      command: "bun run source_control_manager:only:dev",
    },
    { name: "client", color: "green", command: "bun run client:only:offline" },
  ];
}
