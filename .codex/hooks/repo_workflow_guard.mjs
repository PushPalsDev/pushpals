#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const COMMIT_DOC = "docs/git_commit.md";
const RELEASE_DOC = "docs/release_playbook.md";

function readStdin() {
  try {
    return JSON.parse((readFileSync(0, "utf8") || "{}").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function findRepoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

function statePath(repoRoot, sessionId) {
  const safeSession = String(sessionId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(repoRoot, ".git", "codex-workflow-guard");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeSession}.json`);
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function commandFromInput(input) {
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object") {
    return "";
  }
  return String(toolInput.command || toolInput.cmd || "");
}

function mentionsCommitIntent(text) {
  return /\b(commit|committing|git\s+push|push(?:ing)?(?:\s+(?:origin\s+)?main)?)\b/i.test(text);
}

function mentionsReleaseIntent(text) {
  return /\b(cut|publish|ship|tag|release)\b/i.test(text) && /\brelease\b/i.test(text);
}

function readsCommitDoc(command) {
  const normalized = normalize(command);
  return /\bgit_commit\.md\b/i.test(normalized) || new RegExp(`\\b${escapeRegex(COMMIT_DOC)}\\b`, "i").test(normalized);
}

function readsReleaseDoc(command) {
  const normalized = normalize(command);
  return /\brelease_playbook\.md\b/i.test(normalized) || new RegExp(`\\b${escapeRegex(RELEASE_DOC)}\\b`, "i").test(normalized);
}

function runsPullRebase(command) {
  const normalized = normalize(command);
  return runsGitSubcommand(command, "pull") && /(?:^|\s)--rebase\b/i.test(normalized);
}

function runsCommit(command) {
  return runsGitSubcommand(command, "commit");
}

function runsGitPush(command) {
  return runsGitSubcommand(command, "push");
}

function runsCommitPush(command) {
  return runsGitPush(command) && !runsReleaseCommand(command);
}

function runsReleaseCommand(command) {
  const normalized = normalize(command);
  return (
    new RegExp(`${gitCommandPrefix()}tag\\s+v?\\d+\\.\\d+\\.\\d+\\b`, "i").test(normalized) ||
    new RegExp(`${gitCommandPrefix()}push\\s+origin\\s+main\\s+v?\\d+\\.\\d+\\.\\d+\\b`, "i").test(normalized) ||
    /\bgh\s+(?:release|workflow\s+run\b.*release)/i.test(normalized)
  );
}

function runsGitSubcommand(command, subcommand) {
  return new RegExp(`${gitCommandPrefix()}${escapeRegex(subcommand)}\\b`, "i").test(normalize(command));
}

function gitCommandPrefix() {
  return "\\bgit(?:\\s+-c\\s+\\S+)*\\s+";
}

function pullRebaseCoversLatestCommit(state) {
  if (!state.gitPullRebaseAt) {
    return false;
  }
  if (!state.gitCommitAt) {
    return true;
  }
  return !timestampAfter(state.gitCommitAt, state.gitPullRebaseAt);
}

function timestampAfter(left, right) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  return Number.isFinite(leftTime) && (!Number.isFinite(rightTime) || leftTime > rightTime);
}

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function addContext(eventName, additionalContext) {
  outputJson({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  });
}

function denyPreToolUse(reason) {
  outputJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function handleSessionStart() {
  addContext(
    "SessionStart",
    [
      "PushPals workflow guard is active.",
      `Before committing, read ${COMMIT_DOC} and follow: git commit, git pull --rebase, git push.`,
      `Before cutting a release, read ${RELEASE_DOC} and follow it end-to-end.`,
    ].join(" "),
  );
}

function handleUserPromptSubmit(input) {
  const prompt = String(input.prompt || "");
  const wantsCommit = mentionsCommitIntent(prompt);
  const wantsRelease = mentionsReleaseIntent(prompt);

  if (!wantsCommit && !wantsRelease) {
    return;
  }

  const notes = [];
  if (wantsCommit) {
    notes.push(`Before committing in this repo, read ${COMMIT_DOC} and follow its required sequence.`);
  }
  if (wantsRelease) {
    notes.push(`Before cutting a release, read ${RELEASE_DOC}; do not tag or publish from memory.`);
  }
  addContext("UserPromptSubmit", notes.join(" "));
}

function handlePreToolUse(command, state) {
  const commandReadsCommitDoc = readsCommitDoc(command);
  const commandReadsReleaseDoc = readsReleaseDoc(command);
  const commandPullsRebase = runsPullRebase(command);

  if ((runsCommit(command) || runsCommitPush(command)) && !state.gitCommitDocReadAt && !commandReadsCommitDoc) {
    denyPreToolUse(`Read ${COMMIT_DOC} in this Codex session before running git commit or git push.`);
    return;
  }

  if (runsCommitPush(command) && !commandPullsRebase && !pullRebaseCoversLatestCommit(state)) {
    denyPreToolUse(`Run git pull --rebase after git commit and before git push, as required by ${COMMIT_DOC}.`);
    return;
  }

  if (runsReleaseCommand(command) && !state.releasePlaybookReadAt && !commandReadsReleaseDoc) {
    denyPreToolUse(`Read ${RELEASE_DOC} in this Codex session before tagging, pushing release tags, or triggering release publication.`);
  }
}

function handlePostToolUse(command, stateFile, state) {
  const nextState = { ...state };

  if (readsCommitDoc(command)) {
    nextState.gitCommitDocReadAt = new Date().toISOString();
  }
  if (readsReleaseDoc(command)) {
    nextState.releasePlaybookReadAt = new Date().toISOString();
  }
  if (runsCommit(command)) {
    nextState.gitCommitAt = new Date().toISOString();
  }
  if (runsPullRebase(command)) {
    nextState.gitPullRebaseAt = new Date().toISOString();
  }

  if (JSON.stringify(nextState) !== JSON.stringify(state)) {
    writeState(stateFile, nextState);
  }
}

const input = readStdin();
const cwd = input.cwd || process.cwd();
const repoRoot = findRepoRoot(cwd);
const stateFile = statePath(repoRoot, input.session_id);
const state = readState(stateFile);
const eventName = input.hook_event_name;
const command = commandFromInput(input);

if (eventName === "SessionStart") {
  handleSessionStart();
} else if (eventName === "UserPromptSubmit") {
  handleUserPromptSubmit(input);
} else if (eventName === "PreToolUse") {
  handlePreToolUse(command, state);
} else if (eventName === "PostToolUse") {
  handlePostToolUse(command, stateFile, state);
}
