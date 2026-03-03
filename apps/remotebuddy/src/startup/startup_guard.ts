import {
  guardStartupWithSystemPreflight,
  type GuardSystemPreflightOptions,
} from "./system_preflight.js";

export interface StartupCliArguments {
  server: string;
  sessionId: string | null;
  authToken: string | null;
}

export type StartupLauncher = (cli: StartupCliArguments) => Promise<void> | void;

export interface StartupPreflightHooks {
  guard?: typeof guardStartupWithSystemPreflight;
  guardOptions?: GuardSystemPreflightOptions;
}

export const guardStartupAndLaunchRemoteBuddy = async (
  cli: StartupCliArguments,
  start: StartupLauncher,
  hooks: StartupPreflightHooks = {},
): Promise<void> => {
  const guardFn = hooks.guard ?? guardStartupWithSystemPreflight;
  await guardFn(async () => {
    await start(cli);
  }, hooks.guardOptions);
};
