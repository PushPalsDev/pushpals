#!/usr/bin/env bun
// @bun

// packages/shared/src/repo.ts
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";

// packages/shared/src/bounded_process.ts
var DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
var DEFAULT_DRAIN_TIMEOUT_MS = 2000;
var DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
var DEFAULT_EXIT_GRACE_MS = 250;
var MAX_STREAMING_LINE_CHARS = 64 * 1024;
function defaultSpawner(argv, options) {
  return Bun.spawn(argv, options);
}
function buildWindowsProcessTreeTerminationArgv(pid) {
  return ["taskkill", "/PID", String(Math.max(0, Math.floor(pid))), "/T", "/F"];
}
function buildWindowsDescendantSweepArgv(pid) {
  const rootPid = Math.max(0, Math.floor(pid));
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$rootPid = ${rootPid}`,
    "$processes = @(Get-CimInstance Win32_Process)",
    "$children = @{}",
    "foreach ($process in $processes) {",
    "  $parent = [int]$process.ParentProcessId",
    "  if (-not $children.ContainsKey($parent)) { $children[$parent] = [System.Collections.Generic.List[int]]::new() }",
    "  $children[$parent].Add([int]$process.ProcessId)",
    "}",
    "$stack = [System.Collections.Generic.Stack[int]]::new()",
    "$targets = [System.Collections.Generic.List[int]]::new()",
    "$stack.Push($rootPid)",
    "while ($stack.Count -gt 0) {",
    "  $parent = $stack.Pop()",
    "  if (-not $children.ContainsKey($parent)) { continue }",
    "  foreach ($child in $children[$parent]) { $targets.Add($child); $stack.Push($child) }",
    "}",
    "for ($index = $targets.Count - 1; $index -ge 0; $index--) { Stop-Process -Id $targets[$index] -Force -ErrorAction SilentlyContinue }"
  ].join(`
`);
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ];
}
async function settleWithin(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timer)
      clearTimeout(timer);
  }
}
function captureBoundedStream(stream, maxBytes, options = {}) {
  if (!stream || typeof stream === "number" || typeof stream.getReader !== "function") {
    return { done: Promise.resolve(""), cancel: () => {
      return;
    } };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder;
  const headLimit = options.retainTail ? Math.max(1, Math.floor(maxBytes / 2)) : maxBytes;
  const tailLimit = options.retainTail ? Math.max(0, maxBytes - headLimit) : 0;
  let head = "";
  let tail = "";
  let observedChars = 0;
  let lineBuffer = "";
  let truncated = false;
  let cancelled = false;
  const emitLine = (line) => {
    try {
      options.onLine?.(line);
    } catch {}
  };
  const retainAndEmit = (text) => {
    if (!text)
      return;
    observedChars += text.length;
    const headRemaining = Math.max(0, headLimit - head.length);
    const headPart = headRemaining > 0 ? text.slice(0, headRemaining) : "";
    head += headPart;
    const remainder = text.slice(headPart.length);
    if (remainder && tailLimit > 0)
      tail = `${tail}${remainder}`.slice(-tailLimit);
    truncated = observedChars > maxBytes;
    if (!options.onLine)
      return;
    lineBuffer += text;
    const lines = lineBuffer.split(`
`);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines)
      emitLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (lineBuffer.length > MAX_STREAMING_LINE_CHARS) {
      emitLine(`${lineBuffer.slice(0, MAX_STREAMING_LINE_CHARS)}
[pushpals: streaming line truncated]`);
      lineBuffer = "";
    }
  };
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          break;
        retainAndEmit(decoder.decode(chunk.value, { stream: true }));
      }
      retainAndEmit(decoder.decode());
      if (options.onLine && lineBuffer.length > 0) {
        emitLine(lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer);
        lineBuffer = "";
      }
    } catch {} finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    if (!truncated)
      return head + tail;
    const marker = `
[pushpals: process output truncated]`;
    return options.retainTail ? `${head}${marker}
${tail}` : `${head}${marker}`;
  })();
  return {
    done,
    cancel: () => {
      if (cancelled)
        return;
      cancelled = true;
      try {
        reader.cancel().catch(() => {
          return;
        });
      } catch {}
    }
  };
}
async function terminateProcessTree(proc, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn ?? defaultSpawner;
  const terminationTimeoutMs = Math.max(1, options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS);
  const exitGraceMs = Math.max(1, options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
  const gracefulSignalAlreadySent = options.gracefulSignalAlreadySent === true;
  const pid = Number(proc.pid);
  if (platform === "win32" && Number.isFinite(pid) && pid > 0) {
    try {
      const killer = spawn(buildWindowsProcessTreeTerminationArgv(pid), {
        stdout: "ignore",
        stderr: "ignore"
      });
      const taskkillExit = await settleWithin(killer.exited, terminationTimeoutMs);
      if (!taskkillExit.settled) {
        try {
          killer.kill("SIGKILL");
        } catch {}
      }
      if (!taskkillExit.settled || taskkillExit.value !== 0) {
        try {
          const sweeper = spawn(buildWindowsDescendantSweepArgv(pid), {
            stdout: "ignore",
            stderr: "ignore"
          });
          if (!(await settleWithin(sweeper.exited, terminationTimeoutMs)).settled) {
            try {
              sweeper.kill("SIGKILL");
            } catch {}
          }
        } catch {}
      }
      if ((await settleWithin(proc.exited, exitGraceMs)).settled)
        return;
    } catch {}
  }
  if (platform !== "win32" && Number.isFinite(pid) && pid > 0) {
    if (gracefulSignalAlreadySent) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          return;
        }
      }
      await settleWithin(proc.exited, exitGraceMs);
      return;
    }
    let signalledProcessGroup = false;
    try {
      process.kill(-pid, "SIGTERM");
      signalledProcessGroup = true;
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        return;
      }
    }
    if (!signalledProcessGroup) {
      if ((await settleWithin(proc.exited, exitGraceMs)).settled)
        return;
    } else {
      const groupDeadline = Date.now() + exitGraceMs;
      while (Date.now() < groupDeadline) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH")
            return;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, groupDeadline - Date.now()))));
      }
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    await settleWithin(proc.exited, exitGraceMs);
    return;
  }
  if (!gracefulSignalAlreadySent) {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    if ((await settleWithin(proc.exited, exitGraceMs)).settled)
      return;
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
  await settleWithin(proc.exited, exitGraceMs);
}
async function runBoundedProcess(argv, options) {
  const spawn = options.spawn ?? defaultSpawner;
  const platform = options.platform ?? process.platform;
  const proc = spawn(argv, {
    ...options.cwd ? { cwd: options.cwd } : {},
    ...options.env ? { env: options.env } : {},
    ...options.stdin ? { stdin: options.stdin } : {},
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    detached: platform !== "win32"
  });
  const maxBytes = Math.max(1, options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES);
  const stdoutCapture = captureBoundedStream(proc.stdout, maxBytes, {
    retainTail: options.retainOutputTail,
    onLine: options.onStdoutLine
  });
  const stderrCapture = captureBoundedStream(proc.stderr, maxBytes, {
    retainTail: options.retainOutputTail,
    onLine: options.onStderrLine
  });
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const maxTotalTimeoutMs = Math.max(timeoutMs, Math.floor(options.maxTotalTimeoutMs ?? timeoutMs));
  const startedAtMs = Date.now();
  let effectiveTimeoutMs = timeoutMs;
  let deadlineAtMs = startedAtMs + timeoutMs;
  let timer = null;
  const outcome = await Promise.race([
    proc.exited.then((exitCode) => ({ timedOut: false, exitCode })),
    new Promise((resolve) => {
      const scheduleDeadline = () => {
        timer = setTimeout(() => {
          const nowMs = Date.now();
          let requestedExtensionValue = 0;
          try {
            requestedExtensionValue = options.extendTimeoutMs?.({
              startedAtMs,
              deadlineAtMs,
              elapsedMs: Math.max(0, nowMs - startedAtMs)
            }) ?? 0;
          } catch {
            requestedExtensionValue = 0;
          }
          const extensionMs = Math.min(Math.max(0, Math.floor(requestedExtensionValue)), Math.max(0, maxTotalTimeoutMs - effectiveTimeoutMs));
          if (extensionMs > 0) {
            effectiveTimeoutMs += extensionMs;
            deadlineAtMs = nowMs + extensionMs;
            try {
              options.onTimeoutExtended?.(extensionMs, deadlineAtMs);
            } catch {}
            scheduleDeadline();
            return;
          }
          try {
            options.onTimeout?.(Math.max(1, nowMs - startedAtMs));
          } catch {}
          resolve({ timedOut: true, exitCode: 124 });
        }, Math.max(1, deadlineAtMs - Date.now()));
      };
      scheduleDeadline();
    })
  ]);
  if (timer)
    clearTimeout(timer);
  const terminate = options.terminate ?? ((target) => terminateProcessTree(target, { platform, spawn }));
  if (outcome.timedOut)
    await terminate(proc);
  const drainTimeoutMs = Math.max(1, options.streamDrainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  let streams = await settleWithin(Promise.all([stdoutCapture.done, stderrCapture.done]), drainTimeoutMs);
  const drainTimedOut = !streams.settled;
  if (!streams.settled) {
    if (!outcome.timedOut) {
      if (options.terminate) {
        await options.terminate(proc);
      } else {
        await terminateProcessTree(proc, {
          platform,
          spawn,
          exitGraceMs: Math.min(250, Math.max(25, drainTimeoutMs))
        });
      }
    }
    stdoutCapture.cancel();
    stderrCapture.cancel();
    streams = await settleWithin(Promise.all([stdoutCapture.done, stderrCapture.done]), 250);
  }
  const [stdout, rawStderr] = streams.settled ? streams.value : ["", ""];
  const timeoutDetail = outcome.timedOut ? `Command timed out after ${effectiveTimeoutMs}ms; terminated process tree.` : "";
  const drainDetail = drainTimedOut ? `Process streams did not close after ${drainTimeoutMs}ms; terminated process tree and stopped draining.` : "";
  const trimOutput = (text) => options.preserveOutputWhitespace ? text : text.trim();
  return {
    stdout: trimOutput(stdout),
    stderr: [trimOutput(rawStderr), timeoutDetail, drainDetail].filter(Boolean).join(`
`),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    drainTimedOut
  };
}

// packages/shared/src/repo.ts
function resolveDotGitEntry(repoRoot) {
  return resolve(repoRoot, ".git");
}
function findGitRepoRoot(startDir) {
  const override = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? "").trim();
  if (override) {
    const resolvedOverride = resolve(override);
    if (resolveGitMetadataDir(resolvedOverride)) {
      return resolvedOverride;
    }
    console.warn(`[repo] PUSHPALS_REPO_ROOT_OVERRIDE does not point to a git repository: ${resolvedOverride}`);
  }
  let current = resolve(startDir);
  const root = resolve(current, "/");
  while (current !== root) {
    if (resolveGitMetadataDir(current)) {
      return current;
    }
    current = resolve(current, "..");
  }
  return resolveGitMetadataDir(root) ? root : null;
}
function resolveGitMetadataDir(repoRoot) {
  const dotGitPath = resolveDotGitEntry(repoRoot);
  if (!existsSync(dotGitPath))
    return null;
  try {
    const stat = statSync(dotGitPath);
    if (stat.isDirectory()) {
      return dotGitPath;
    }
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const firstLine = readFileSync(dotGitPath, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const match = firstLine.match(/^gitdir:\s*(.+)\s*$/i);
    if (!match)
      return null;
    const gitDir = resolve(repoRoot, match[1].trim());
    return existsSync(gitDir) ? gitDir : null;
  } catch {
    return null;
  }
}
function detectRepoRoot(startDir) {
  const repoRoot = findGitRepoRoot(startDir);
  if (repoRoot) {
    return repoRoot;
  }
  console.warn(`[repo] No .git directory found, using: ${startDir}`);
  return startDir;
}
// packages/shared/src/bounded_fetch.ts
var DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 32 * 1024 * 1024;
async function fetchWithHardDeadline(options) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.max(1, Math.floor(options.timeoutMs)) : 1;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController;
  const upstreamSignal = options.init?.signal;
  let rejectUpstreamAbort = null;
  const upstreamAbort = new Promise((_resolve, reject) => {
    rejectUpstreamAbort = reject;
  });
  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
    rejectUpstreamAbort?.(upstreamSignal?.reason instanceof Error ? upstreamSignal.reason : new DOMException("The HTTP request was aborted", "AbortError"));
  };
  if (upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  let timer = null;
  const operation = Promise.resolve().then(async () => {
    const response = await fetchImpl(options.input, {
      ...options.init,
      signal: controller.signal
    });
    return await options.consume(response, controller.signal);
  });
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(options.timeoutMessage ?? `HTTP request timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race(upstreamSignal ? [operation, deadline, upstreamAbort] : [operation, deadline]);
  } finally {
    if (timer)
      clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
async function fetchBufferedWithHardDeadline(options) {
  const { maxResponseBytes: configuredMaxResponseBytes, ...requestOptions } = options;
  const maxResponseBytes = typeof configuredMaxResponseBytes === "number" && Number.isFinite(configuredMaxResponseBytes) && configuredMaxResponseBytes >= 0 ? Math.floor(configuredMaxResponseBytes) : DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  return fetchWithHardDeadline({
    ...requestOptions,
    consume: async (response, signal) => {
      const responseInit = {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      };
      if (!response.body)
        return new Response(null, responseInit);
      const reader = response.body.getReader();
      const sizeError = () => new Error(`HTTP response exceeded ${maxResponseBytes} byte buffer limit`);
      const cancelReader = () => {
        try {
          reader.cancel(signal.reason).catch(() => {
            return;
          });
        } catch {}
      };
      signal.addEventListener("abort", cancelReader, { once: true });
      if (signal.aborted)
        cancelReader();
      try {
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength = contentLengthHeader == null ? null : Number(contentLengthHeader);
        if (contentLength != null && Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          const error = sizeError();
          await reader.cancel(error).catch(() => {
            return;
          });
          throw error;
        }
        const chunks = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          totalBytes += value.byteLength;
          if (totalBytes > maxResponseBytes) {
            const error = sizeError();
            await reader.cancel(error).catch(() => {
              return;
            });
            throw error;
          }
          chunks.push(value);
        }
        if (totalBytes === 0)
          return new Response(null, responseInit);
        const body = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new Response(body, responseInit);
      } finally {
        signal.removeEventListener("abort", cancelReader);
        try {
          reader.releaseLock();
        } catch {}
      }
    }
  });
}

// packages/shared/src/communication.ts
function stripPresenceSourcePrefix(value) {
  return value.replace(/^(agent|client)(?:[\s:./_-]+)+/i, "");
}
function normalizePresenceClientId(value) {
  const raw = stripPresenceSourcePrefix(String(value ?? "").trim());
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").trim();
}
function normalizePresenceClientLabel(value) {
  return stripPresenceSourcePrefix(String(value ?? "")).replace(/\s+/g, " ").trim();
}
class CommunicationManager {
  serverUrl;
  sessionId;
  from;
  authToken;
  fetchImpl;
  requestTimeoutMs;
  constructor(opts) {
    this.serverUrl = opts.serverUrl;
    this.sessionId = opts.sessionId;
    this.from = opts.from;
    this.authToken = opts.authToken ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = Math.max(1, Math.min(120000, Math.floor(opts.requestTimeoutMs ?? 1e4)));
  }
  headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    return headers;
  }
  commandUrl(sessionId) {
    return `${this.serverUrl}/sessions/${encodeURIComponent(sessionId)}/command`;
  }
  buildSessionTransportPresence(sessionId) {
    const normalizedFrom = normalizePresenceClientId(this.from);
    const labelFrom = normalizePresenceClientLabel(this.from);
    const normalizedSessionId = normalizePresenceClientId(sessionId);
    const isDefaultSession = sessionId === this.sessionId;
    const repoRoot = String(process.env.PUSHPALS_REPO_ROOT_OVERRIDE ?? process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE ?? process.cwd()).trim();
    return {
      clientId: isDefaultSession ? normalizedFrom || "agent" : `${normalizedFrom || "agent"}__${normalizedSessionId || "session"}`,
      kind: "agent",
      label: labelFrom || normalizedFrom || "Agent",
      version: String(process.env.PUSHPALS_RUNTIME_TAG ?? process.env.npm_package_version ?? "").trim(),
      platform: `${process.platform}/${process.arch}`,
      repoRoot
    };
  }
  async emitToSession(sessionId, type, payload, meta = {}) {
    try {
      const body = {
        type,
        payload,
        from: meta.from ?? this.from
      };
      if (meta.to)
        body.to = meta.to;
      if (meta.correlationId)
        body.correlationId = meta.correlationId;
      if (meta.turnId)
        body.turnId = meta.turnId;
      if (meta.parentId)
        body.parentId = meta.parentId;
      const response = await fetchBufferedWithHardDeadline({
        input: this.commandUrl(sessionId),
        init: {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body)
        },
        timeoutMs: this.requestTimeoutMs,
        fetchImpl: this.fetchImpl,
        timeoutMessage: `session command timed out after ${this.requestTimeoutMs}ms`
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async emit(type, payload, meta = {}) {
    return this.emitToSession(this.sessionId, type, payload, meta);
  }
  async assistantMessageToSession(sessionId, text, meta = {}) {
    return this.emitToSession(sessionId, "assistant_message", { text }, meta);
  }
  async assistantMessage(text, meta = {}) {
    return this.assistantMessageToSession(this.sessionId, text, meta);
  }
  async userMessageToSession(sessionId, text, meta = {}) {
    return this.emitToSession(sessionId, "message", { text }, {
      ...meta,
      from: meta.from ?? "client"
    });
  }
  async userMessage(text, meta = {}) {
    return this.userMessageToSession(this.sessionId, text, meta);
  }
  async taskProgressToSession(sessionId, taskId, message, percent, meta = {}) {
    const payload = percent == null ? { taskId, message } : { taskId, message, percent };
    return this.emitToSession(sessionId, "task_progress", payload, meta);
  }
  async taskProgress(taskId, message, percent, meta = {}) {
    return this.taskProgressToSession(this.sessionId, taskId, message, percent, meta);
  }
  async statusToSession(sessionId, agentId, state, detail, meta = {}) {
    const payload = detail == null ? { agentId, state } : { agentId, state, detail };
    return this.emitToSession(sessionId, "status", payload, meta);
  }
  async status(agentId, state, detail, meta = {}) {
    return this.statusToSession(this.sessionId, agentId, state, detail, meta);
  }
  subscribeSessionEventsForSession(sessionId, onEvent, options = {}) {
    let disposed = false;
    let ws = null;
    let reconnectTimer = null;
    let latestCursor = Math.max(0, options.afterCursor ?? 0);
    const reconnectMs = Math.max(500, options.reconnectMs ?? 3000);
    const onError = options.onError ?? (() => {});
    const onOpen = options.onOpen ?? (() => {});
    const connect = () => {
      if (disposed)
        return;
      try {
        const url = new URL(this.serverUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = `/sessions/${encodeURIComponent(sessionId)}/ws`;
        const presence = this.buildSessionTransportPresence(sessionId);
        if (latestCursor > 0) {
          url.searchParams.set("after", String(latestCursor));
        }
        url.searchParams.set("clientId", presence.clientId);
        url.searchParams.set("clientKind", presence.kind);
        url.searchParams.set("clientLabel", presence.label);
        if (presence.version) {
          url.searchParams.set("clientVersion", presence.version);
        }
        if (presence.platform) {
          url.searchParams.set("clientPlatform", presence.platform);
        }
        if (presence.repoRoot) {
          url.searchParams.set("clientRepoRoot", presence.repoRoot);
        }
        ws = new WebSocket(url.toString());
      } catch (err) {
        onError(`[SessionEvents] Failed to connect: ${String(err)}`);
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
        return;
      }
      ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === "string" ? JSON.parse(event.data) : null;
          if (!raw)
            return;
          const envelope = raw.envelope ?? raw;
          const cursor = typeof raw.cursor === "number" ? raw.cursor : 0;
          if (cursor > latestCursor)
            latestCursor = cursor;
          onEvent(envelope, cursor);
        } catch (err) {
          onError(`[SessionEvents] Parse error: ${String(err)}`);
        }
      };
      ws.onopen = () => {
        onOpen();
      };
      ws.onerror = () => {
        onError("[SessionEvents] WebSocket error");
      };
      ws.onclose = () => {
        ws = null;
        if (!disposed) {
          reconnectTimer = setTimeout(connect, reconnectMs);
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer)
        clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        try {
          ws.close();
        } catch {}
      }
      ws = null;
    };
  }
  subscribeSessionEvents(onEvent, options = {}) {
    return this.subscribeSessionEventsForSession(this.sessionId, onEvent, options);
  }
}
// packages/shared/src/prompts.ts
import { readFileSync as readFileSync2 } from "fs";
import { join, resolve as resolve2 } from "path";
var TEMPLATE_TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
var promptTemplateCache = new Map;
var repoDocCache = new Map;
function resolvePromptPath(relativePath) {
  const promptRootOverride = String(process.env.PUSHPALS_PROMPTS_ROOT_OVERRIDE ?? "").trim();
  const repoRoot = promptRootOverride ? resolve2(promptRootOverride) : detectRepoRoot(process.cwd());
  return join(repoRoot, "prompts", relativePath);
}
function loadPromptTemplate(relativePath, replacements) {
  const promptPath = resolvePromptPath(relativePath);
  let template = promptTemplateCache.get(promptPath);
  if (template === undefined) {
    template = readFileSync2(promptPath, "utf8");
    promptTemplateCache.set(promptPath, template);
  }
  if (!replacements || Object.keys(replacements).length === 0) {
    return template;
  }
  return template.replace(TEMPLATE_TOKEN, (_match, token) => {
    const value = replacements[token];
    if (value === undefined) {
      throw new Error(`[prompts] Missing replacement for "{{${token}}}" in ${promptPath}`);
    }
    return value;
  });
}
// packages/shared/src/config.ts
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "fs";
import { join as join2, resolve as resolve3, isAbsolute } from "path";

// packages/shared/src/autonomy_policy.ts
var DRIVE_RE = /^[A-Za-z]:\//;
var SLASH_RE = /\/+/g;
function normalizeAutonomyComponentArea(value) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized)
    return null;
  return normalized;
}
function normalizeRepoRelativePath(value) {
  if (typeof value !== "string")
    return null;
  let path = value.trim();
  if (!path)
    return null;
  path = path.normalize("NFC").replace(/\\/g, "/");
  if (path.startsWith("/"))
    return null;
  if (DRIVE_RE.test(path))
    return null;
  path = path.replace(SLASH_RE, "/");
  const out = [];
  for (const rawSegment of path.split("/")) {
    const segment = rawSegment.trim();
    if (!segment || segment === ".")
      continue;
    if (segment === "..")
      return null;
    out.push(segment);
  }
  if (out.length === 0)
    return null;
  return out.join("/");
}

// packages/shared/src/local_network.ts
var DEFAULT_LOCAL_LOOPBACK_HOST = "127.0.0.1";
function isLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}
function normalizeLoopbackHost(hostname) {
  const normalized = String(hostname ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(normalized))
    return DEFAULT_LOCAL_LOOPBACK_HOST;
  return DEFAULT_LOCAL_LOOPBACK_HOST;
}
function isLoopbackOrigin(origin) {
  const text = String(origin ?? "").trim();
  if (!text)
    return false;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
function buildLocalCorsHeaders(options) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": options.allowAuthorizationHeader ? "content-type, authorization" : "content-type"
  };
  const origin = String(options.origin ?? "").trim();
  if (isLoopbackOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}
function normalizeLoopbackHttpUrl(value, fallbackPort) {
  const fallback = `http://${DEFAULT_LOCAL_LOOPBACK_HOST}:${Math.max(1, fallbackPort)}`;
  const text = String(value ?? "").trim();
  if (!text)
    return fallback;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }
    parsed.protocol = "http:";
    parsed.username = "";
    parsed.password = "";
    parsed.hostname = normalizeLoopbackHost(parsed.hostname);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.port) {
      parsed.port = String(Math.max(1, fallbackPort));
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}
function resolveLocalServerConnection(options) {
  const rawServer = String(options.serverUrl ?? "").trim().replace(/\/+$/, "");
  const normalizedServer = normalizeLoopbackHttpUrl(rawServer, options.fallbackPort);
  const authToken = String(options.authToken ?? "").trim();
  return {
    serverUrl: normalizedServer,
    authToken: null,
    serverWasNormalized: !!rawServer && normalizedServer !== rawServer,
    authTokenWasIgnored: authToken.length > 0
  };
}

// packages/shared/src/config.ts
var PROJECT_ROOT = resolve3(import.meta.dir, "..", "..", "..");
var DEFAULT_CONFIG_DIR = "configs";
var TRUTHY = new Set(["1", "true", "yes", "on"]);
var FALSY = new Set(["0", "false", "no", "off"]);
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE = 8;
var DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS = 3;
var DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS = ["task.execute"];
var DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS = 192 * 1024;
var DEFAULT_WORKERPALS_OUTPUT_MAX_LINES = 600;
var DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES = 120;
var DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS = 180000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS = 90000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR = "retry_once";
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS = 16000;
var DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS = 8000;
var DEFAULT_WORKERPALS_EXECUTOR = "openai_codex";
var DEFAULT_WORKERPALS_EXECUTION_PLATFORM = "auto";
var DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX = "__PUSHPALS_OH_RESULT__ ";
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS = 12;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS = 2400;
var DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS = 420;
var DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS = 30;
var DEFAULT_OPENAI_CODEX_MODEL = "gpt-5.6-sol";
var DEFAULT_OPENAI_CODEX_REASONING_EFFORT = "xhigh";
var cachedConfig = null;
var cachedConfigKey = "";
function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed)
      return trimmed;
  }
  return "";
}
function parseBoolEnv(name) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw)
    return null;
  if (TRUTHY.has(raw))
    return true;
  if (FALSY.has(raw))
    return false;
  return null;
}
function parseIntEnv(name) {
  const raw = (process.env[name] ?? "").trim();
  if (!raw)
    return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseTomlFile(path) {
  if (!existsSync2(path))
    return {};
  const raw = readFileSync3(path, "utf-8").replace(/^\uFEFF/, "");
  const parsed = Bun.TOML.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return {};
  return parsed;
}
function parseRequiredTomlFile(path) {
  if (!existsSync2(path)) {
    throw new Error(`Missing required runtime config file: ${path}`);
  }
  return parseTomlFile(path);
}
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function mergeDeep(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isObject(existing) && isObject(value)) {
      out[key] = mergeDeep(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function getObject(parent, key) {
  const value = parent[key];
  if (isObject(value))
    return value;
  return {};
}
function asString(value, fallback) {
  if (typeof value === "string" && value.trim())
    return value.trim();
  return fallback;
}
function asQualityCriticTimeoutBehavior(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "skip" || normalized === "retry_once" || normalized === "block") {
    return normalized;
  }
  return DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR;
}
function normalizeWorkerPalsExecutionPlatform(value, fallback = DEFAULT_WORKERPALS_EXECUTION_PLATFORM) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "auto" || normalized === "windows" || normalized === "linux_docker") {
    return normalized;
  }
  return fallback;
}
function asBoolean(value, fallback) {
  if (typeof value === "boolean")
    return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (TRUTHY.has(lowered))
      return true;
    if (FALSY.has(lowered))
      return false;
  }
  return fallback;
}
function asInt(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return fallback;
}
function asIntOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed))
      return parsed;
  }
  return null;
}
function asStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function asCheckArray(value) {
  if (!Array.isArray(value))
    return [];
  const checks = [];
  for (const entry of value) {
    if (!isObject(entry))
      continue;
    const name = asString(entry.name, "").trim();
    const command = asString(entry.command, "").trim();
    if (!name || !command)
      continue;
    const timeoutMs = Math.max(1000, asInt(entry.timeout_ms ?? entry.timeoutMs, 300000));
    checks.push({ name, command, timeoutMs });
  }
  return checks;
}
function asStringNumberRecord(value) {
  if (!isObject(value))
    return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    if (!name)
      continue;
    const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number.NaN;
    if (!Number.isFinite(num))
      continue;
    out[name] = Math.max(0, Math.floor(num));
  }
  return out;
}
function resolvePathFromRoot(projectRoot, value) {
  if (!value)
    return projectRoot;
  if (isAbsolute(value))
    return resolve3(value);
  return resolve3(projectRoot, value);
}
function resolveRuntimeConfigDir(projectRoot, configuredDir) {
  if (configuredDir && configuredDir.trim()) {
    return resolvePathFromRoot(projectRoot, configuredDir);
  }
  return resolvePathFromRoot(projectRoot, DEFAULT_CONFIG_DIR);
}
function normalizeBackend(value) {
  const text = value.trim().toLowerCase();
  if (!text)
    return "lmstudio";
  if (text === "openai_compatible")
    return "lmstudio";
  if (text === "ollama_chat")
    return "ollama";
  return text;
}
function normalizeWorkerImageRebuildMode(value) {
  const text = value.trim().toLowerCase();
  if (text === "always" || text === "1" || text === "true" || text === "yes" || text === "on") {
    return "always";
  }
  if (text === "never" || text === "0" || text === "false" || text === "no" || text === "off") {
    return "never";
  }
  return "auto";
}
function normalizeStartupPortConflictPolicy(value) {
  const text = value.trim().toLowerCase().replace(/-/g, "_");
  if (text === "terminate_pushpals" || text === "kill_pushpals" || text === "auto_kill_pushpals") {
    return "terminate_pushpals";
  }
  return "fail";
}
function defaultApiKeyForBackend(backend, endpoint) {
  const normalizedBackend = backend.trim().toLowerCase();
  const normalizedEndpoint = endpoint.trim().toLowerCase();
  const openAiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (normalizedBackend === "openai") {
    return openAiKey;
  }
  if (normalizedBackend === "lmstudio") {
    return "lmstudio";
  }
  if (normalizedEndpoint.includes("api.openai.com")) {
    return openAiKey;
  }
  return "";
}
function resolveLlmConfig(serviceNode, envPrefix, defaults, globalSessionId) {
  const llmNode = getObject(serviceNode, "llm");
  const backend = normalizeBackend(firstNonEmpty(process.env[`${envPrefix}_LLM_BACKEND`], asString(llmNode.backend, defaults.backend), defaults.backend));
  const endpoint = firstNonEmpty(process.env[`${envPrefix}_LLM_ENDPOINT`], asString(llmNode.endpoint, defaults.endpoint), defaults.endpoint);
  const envModel = firstNonEmpty(process.env[`${envPrefix}_LLM_MODEL`]);
  const configuredFileModel = firstNonEmpty(asString(llmNode.model, ""));
  const configuredModel = firstNonEmpty(envModel, configuredFileModel);
  const modelFallback = backend === "openai_codex" ? DEFAULT_OPENAI_CODEX_MODEL : defaults.model;
  const model = backend === "openai_codex" && !envModel && (!configuredFileModel || configuredFileModel === defaults.model) ? DEFAULT_OPENAI_CODEX_MODEL : firstNonEmpty(configuredModel, modelFallback) ?? modelFallback;
  const sessionId = firstNonEmpty(process.env[`${envPrefix}_LLM_SESSION_ID`], asString(llmNode.session_id, defaults.sessionId), process.env.PUSHPALS_LLM_SESSION_ID, globalSessionId);
  const apiKey = firstNonEmpty(process.env[`${envPrefix}_LLM_API_KEY`], defaultApiKeyForBackend(backend, endpoint));
  const reasoningEffort = firstNonEmpty(process.env[`${envPrefix}_LLM_REASONING_EFFORT`], asString(llmNode.reasoning_effort, ""), backend === "openai_codex" ? DEFAULT_OPENAI_CODEX_REASONING_EFFORT : "");
  const codexAuthMode = firstNonEmpty(process.env[`${envPrefix}_LLM_CODEX_AUTH_MODE`], asString(llmNode.codex_auth_mode, ""));
  const codexBin = firstNonEmpty(process.env[`${envPrefix}_LLM_CODEX_BIN`], asString(llmNode.codex_bin, ""));
  const codexTimeoutMs = Math.max(1e4, asInt(parseIntEnv(`${envPrefix}_LLM_CODEX_TIMEOUT_MS`) ?? llmNode.codex_timeout_ms, 120000));
  return {
    backend,
    endpoint,
    model,
    sessionId,
    apiKey,
    reasoningEffort,
    codexAuthMode,
    codexBin,
    codexTimeoutMs
  };
}
function loadPushPalsConfig(options = {}) {
  const projectRootOverride = firstNonEmpty(options.projectRoot, process.env.PUSHPALS_PROJECT_ROOT_OVERRIDE, PROJECT_ROOT);
  const projectRoot = resolve3(projectRootOverride);
  const configDirOverride = firstNonEmpty(options.configDir, process.env.PUSHPALS_CONFIG_DIR_OVERRIDE, "");
  const configDir = resolveRuntimeConfigDir(projectRoot, configDirOverride);
  const cacheKey = `${projectRoot}::${configDir}::${process.env.PUSHPALS_PROFILE ?? ""}`;
  if (!options.reload && cachedConfig && cachedConfigKey === cacheKey) {
    return cachedConfig;
  }
  const defaultToml = parseRequiredTomlFile(join2(configDir, "default.toml"));
  const preferredProfile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(defaultToml.profile, "dev"), "dev");
  const profileToml = parseTomlFile(join2(configDir, `${preferredProfile}.toml`));
  const localExampleToml = parseTomlFile(join2(configDir, "local.example.toml"));
  const localToml = parseTomlFile(join2(configDir, "local.toml"));
  const merged = mergeDeep(mergeDeep(mergeDeep(defaultToml, profileToml), localExampleToml), localToml);
  const profile = firstNonEmpty(process.env.PUSHPALS_PROFILE, asString(merged.profile, preferredProfile), preferredProfile);
  const sessionId = firstNonEmpty(process.env.PUSHPALS_SESSION_ID, asString(merged.session_id, "dev"), "dev");
  const llmNode = getObject(merged, "llm");
  const lmStudioNode = getObject(llmNode, "lmstudio");
  const lmStudioContextWindow = Math.max(512, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_CONTEXT_WINDOW") ?? lmStudioNode.context_window, 4096));
  const lmStudioMinOutputTokens = Math.max(64, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_MIN_OUTPUT_TOKENS") ?? lmStudioNode.min_output_tokens, 256));
  const lmStudioTokenSafetyMargin = Math.max(16, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_TOKEN_SAFETY_MARGIN") ?? lmStudioNode.token_safety_margin, 64));
  const lmStudioBatchTailMessages = Math.max(1, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_TAIL_MESSAGES") ?? lmStudioNode.batch_tail_messages, 3));
  const lmStudioBatchChunkTokens = Math.max(0, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_CHUNK_TOKENS") ?? lmStudioNode.batch_chunk_tokens, 0));
  const lmStudioBatchMemoryChars = Math.max(0, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_BATCH_MEMORY_CHARS") ?? lmStudioNode.batch_memory_chars, 0));
  const pathsNode = getObject(merged, "paths");
  const dataDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DATA_DIR, asString(pathsNode.data_dir, "outputs/data")));
  const sharedDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.PUSHPALS_DB_PATH, asString(pathsNode.shared_db_path, join2(dataDir, "pushpals.db"))));
  const remotebuddyDbPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.REMOTEBUDDY_DB_PATH, asString(pathsNode.remotebuddy_db_path, join2(dataDir, "remotebuddy-state.db"))));
  const serverNode = getObject(merged, "server");
  const serverPort = Math.max(1, asInt(parseIntEnv("PUSHPALS_PORT") ?? serverNode.port, 3001));
  const serverUrl = normalizeLoopbackHttpUrl(firstNonEmpty(process.env.PUSHPALS_SERVER_URL, asString(serverNode.url, `http://127.0.0.1:${serverPort}`), `http://127.0.0.1:${serverPort}`), serverPort);
  const serverHost = normalizeLoopbackHost(firstNonEmpty(process.env.PUSHPALS_HOST, asString(serverNode.host, "127.0.0.1")));
  const debugHttp = parseBoolEnv("PUSHPALS_DEBUG_HTTP") ?? asBoolean(serverNode.debug_http, false);
  const staleClaimTtlMs = Math.max(5000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_TTL_MS") ?? serverNode.stale_claim_ttl_ms, 120000));
  const staleClaimSweepIntervalMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_STALE_CLAIM_SWEEP_INTERVAL_MS") ?? serverNode.stale_claim_sweep_interval_ms, 5000));
  const sessionTokenBudget = Math.max(0, asInt(parseIntEnv("PUSHPALS_SESSION_TOKEN_BUDGET") ?? serverNode.session_token_budget, 0));
  const sessionTokenBudgetAction = "pause";
  const globalStatusHeartbeatMs = parseIntEnv("PUSHPALS_STATUS_HEARTBEAT_MS");
  const localNode = getObject(merged, "localbuddy");
  const localEnabled = parseBoolEnv("LOCALBUDDY_ENABLED") ?? asBoolean(localNode.enabled, false);
  const localPort = Math.max(1, asInt(parseIntEnv("LOCAL_AGENT_PORT") ?? localNode.port, 3003));
  const localStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("LOCALBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? localNode.status_heartbeat_ms, 120000));
  const localLlm = resolveLlmConfig(localNode, "LOCALBUDDY", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "localbuddy-dev"
  }, sessionId);
  const remoteNode = getObject(merged, "remotebuddy");
  const remoteStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? remoteNode.status_heartbeat_ms, 120000));
  const remotePollMs = Math.max(200, asInt(parseIntEnv("REMOTEBUDDY_POLL_MS") ?? remoteNode.poll_ms, 2000));
  const remoteMaxWorkerpals = Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_MAX_WORKERPALS") ?? remoteNode.max_workerpals, 20));
  const remoteMinWorkerpals = Math.max(1, Math.min(remoteMaxWorkerpals, asInt(parseIntEnv("REMOTEBUDDY_MIN_WORKERPALS") ?? remoteNode.min_workerpals, 1)));
  const remoteLlm = resolveLlmConfig(remoteNode, "REMOTEBUDDY", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "remotebuddy-dev"
  }, sessionId);
  const remoteMemoryNode = getObject(remoteNode, "memory");
  const remoteMemoryEnabled = parseBoolEnv("REMOTEBUDDY_MEMORY_ENABLED") ?? asBoolean(remoteMemoryNode.enabled, true);
  const remoteMemoryIncludeCrossSession = parseBoolEnv("REMOTEBUDDY_MEMORY_INCLUDE_CROSS_SESSION") ?? asBoolean(remoteMemoryNode.include_cross_session, true);
  const remoteMemoryMaxRecallItems = Math.max(1, Math.min(128, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS") ?? remoteMemoryNode.max_recall_items, DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_ITEMS)));
  const remoteMemoryMaxRecallChars = Math.max(120, Math.min(64000, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS") ?? remoteMemoryNode.max_recall_chars, DEFAULT_REMOTEBUDDY_MEMORY_MAX_RECALL_CHARS)));
  const remoteMemoryMaxSummaryChars = Math.max(64, Math.min(16000, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS") ?? remoteMemoryNode.max_summary_chars, DEFAULT_REMOTEBUDDY_MEMORY_MAX_SUMMARY_CHARS)));
  const remoteMemoryRetentionDays = Math.max(1, Math.min(3650, asInt(parseIntEnv("REMOTEBUDDY_MEMORY_RETENTION_DAYS") ?? remoteMemoryNode.retention_days, DEFAULT_REMOTEBUDDY_MEMORY_RETENTION_DAYS)));
  const remoteAutonomyNode = getObject(remoteNode, "autonomy");
  const remoteAutonomyReplayNode = getObject(remoteAutonomyNode, "replay");
  const remoteAutonomyDispatchByTypeCfg = {
    flaky_test: 4,
    lint_fix: 3,
    type_fix: 3,
    small_refactor: 2,
    feature_small: 2,
    feature_medium: 1,
    feature_large: 0,
    docs: 1,
    dep_bump: 0
  };
  const remoteAutonomyDispatchByType = {
    ...remoteAutonomyDispatchByTypeCfg,
    ...asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_type)
  };
  const remoteAutonomyDispatchByComponentCfg = {
    "apps/server": 3,
    "apps/remotebuddy": 2,
    "apps/workerpals": 2,
    "apps/client": 2,
    "packages/protocol": 1,
    "packages/shared": 2,
    "tests/integration": 2,
    "tests/unit": 2
  };
  const remoteAutonomyDispatchByComponentRaw = asStringNumberRecord(remoteAutonomyNode.max_dispatch_per_hour_by_component);
  const legacyAutonomyComponentAliasMap = new Map(Object.keys(remoteAutonomyDispatchByComponentCfg).flatMap((key) => {
    const direct = normalizeAutonomyComponentArea(key);
    const legacyUnderscore = normalizeAutonomyComponentArea(key.replace(/\//g, "_"));
    const legacyHyphen = normalizeAutonomyComponentArea(key.replace(/\//g, "-"));
    return [direct, legacyUnderscore, legacyHyphen].filter((value) => Boolean(value)).map((value) => [value, key]);
  }));
  const coerceAutonomyComponentConfigKey = (value) => {
    const direct = normalizeAutonomyComponentArea(value);
    const legacyAliasCandidate = normalizeAutonomyComponentArea(value.trim().toLowerCase().replace(/\\/g, "/").replace(/_+/g, "/").replace(/-+/g, "/").replace(/\/+/g, "/"));
    if (legacyAliasCandidate && legacyAutonomyComponentAliasMap.has(legacyAliasCandidate)) {
      return legacyAutonomyComponentAliasMap.get(legacyAliasCandidate) ?? legacyAliasCandidate;
    }
    return direct;
  };
  const remoteAutonomyDispatchByComponent = Object.fromEntries(Object.entries(remoteAutonomyDispatchByComponentCfg).map(([key, value]) => [
    coerceAutonomyComponentConfigKey(key) ?? key,
    value
  ]));
  for (const [rawKey, rawValue] of Object.entries(remoteAutonomyDispatchByComponentRaw)) {
    const canonical = coerceAutonomyComponentConfigKey(rawKey);
    if (!canonical)
      continue;
    const parsed = rawValue;
    remoteAutonomyDispatchByComponent[canonical] = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  const workerNode = getObject(merged, "workerpals");
  const workerOpenHandsNode = getObject(workerNode, "openhands");
  const workerExecutionPlatform = normalizeWorkerPalsExecutionPlatform(firstNonEmpty(process.env.WORKERPALS_EXECUTION_PLATFORM, process.env.PUSHPALS_WORKERPALS_EXECUTION_PLATFORM, asString(workerNode.execution_platform, DEFAULT_WORKERPALS_EXECUTION_PLATFORM), DEFAULT_WORKERPALS_EXECUTION_PLATFORM));
  const configuredRemoteWorkerpalDocker = parseBoolEnv("REMOTEBUDDY_WORKERPAL_DOCKER") ?? asBoolean(remoteNode.workerpal_docker, true);
  const configuredRemoteWorkerpalRequireDocker = parseBoolEnv("REMOTEBUDDY_WORKERPAL_REQUIRE_DOCKER") ?? asBoolean(remoteNode.workerpal_require_docker, true);
  const configuredWorkerRequireDocker = parseBoolEnv("WORKERPALS_REQUIRE_DOCKER") ?? asBoolean(workerNode.require_docker, false);
  const effectiveRemoteWorkerpalDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredRemoteWorkerpalDocker;
  const effectiveRemoteWorkerpalRequireDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredRemoteWorkerpalRequireDocker;
  const effectiveWorkerRequireDocker = workerExecutionPlatform === "windows" ? false : workerExecutionPlatform === "linux_docker" ? true : configuredWorkerRequireDocker;
  const workerPollMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_POLL_MS") ?? workerNode.poll_ms, 2000));
  const workerHeartbeatMs = Math.max(200, asInt(parseIntEnv("WORKERPALS_HEARTBEAT_MS") ?? workerNode.heartbeat_ms, 5000));
  const workerExecutor = firstNonEmpty(process.env.WORKERPALS_EXECUTOR, asString(workerNode.executor, DEFAULT_WORKERPALS_EXECUTOR), DEFAULT_WORKERPALS_EXECUTOR).toLowerCase();
  const workerOpenHandsPython = firstNonEmpty(process.env.WORKERPALS_OPENHANDS_PYTHON, asString(workerNode.openhands_python, "python"), "python");
  const workerOpenHandsTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_OPENHANDS_TIMEOUT_MS") ?? workerNode.openhands_timeout_ms, 1800000));
  const workerMiniswePython = firstNonEmpty(process.env.WORKERPALS_MINISWE_PYTHON, asString(workerNode.miniswe_python, "python"), "python");
  const workerMinisweTimeoutMs = Math.max(1e4, asInt(parseIntEnv("WORKERPALS_MINISWE_TIMEOUT_MS") ?? workerNode.miniswe_timeout_ms, 1800000));
  const workerOpenAICodexPython = firstNonEmpty(process.env.PUSHPALS_OPENAI_CODEX_PYTHON, asString(workerNode.openai_codex_python, "python"), "python");
  const workerOpenAICodexTimeoutMs = Math.max(1e4, asInt(workerNode.openai_codex_timeout_ms, 7200000));
  const workerQualityMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_MAX_AUTO_REVISIONS") ?? workerNode.quality_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
  const workerQualityValidationMaxAutoRevisions = Math.max(0, Math.min(10, asInt(parseIntEnv("WORKERPALS_QUALITY_VALIDATION_MAX_AUTO_REVISIONS") ?? workerNode.quality_validation_max_auto_revisions, DEFAULT_WORKERPALS_QUALITY_MAX_AUTO_REVISIONS)));
  const workerFileModifyingJobs = (() => {
    const envRaw = firstNonEmpty(process.env.WORKERPALS_FILE_MODIFYING_JOBS);
    const parsed = envRaw ? envRaw.split(",").map((entry) => entry.trim()).filter(Boolean) : asStringArray(workerNode.file_modifying_jobs);
    const out = parsed.length > 0 ? parsed : DEFAULT_WORKERPALS_FILE_MODIFYING_JOBS;
    return [...new Set(out)];
  })();
  const workerOutputMaxChars = Math.max(8192, Math.min(4194304, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_CHARS") ?? workerNode.output_max_chars, DEFAULT_WORKERPALS_OUTPUT_MAX_CHARS)));
  const workerOutputMaxLines = Math.max(50, Math.min(20000, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_LINES") ?? workerNode.output_max_lines, DEFAULT_WORKERPALS_OUTPUT_MAX_LINES)));
  const workerOutputMaxHeadLines = Math.max(1, Math.min(workerOutputMaxLines, asInt(parseIntEnv("WORKERPALS_OUTPUT_MAX_HEAD_LINES") ?? workerNode.output_max_head_lines, DEFAULT_WORKERPALS_OUTPUT_MAX_HEAD_LINES)));
  const workerQualityValidationStepTimeoutMs = Math.max(1000, asInt(parseIntEnv("WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS") ?? workerNode.quality_validation_step_timeout_ms, DEFAULT_WORKERPALS_QUALITY_VALIDATION_STEP_TIMEOUT_MS));
  const workerQualityCriticTimeoutMs = Math.max(1000, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS") ?? workerNode.quality_critic_timeout_ms, DEFAULT_WORKERPALS_QUALITY_CRITIC_TIMEOUT_MS));
  const workerQualityCriticTimeoutBehavior = asQualityCriticTimeoutBehavior(process.env.WORKERPALS_QUALITY_CRITIC_TIMEOUT_BEHAVIOR ?? workerNode.quality_critic_timeout_behavior);
  const workerQualitySoftPassOnExhausted = parseBoolEnv("WORKERPALS_QUALITY_SOFT_PASS_ON_EXHAUSTED") ?? asBoolean(workerNode.quality_soft_pass_on_exhausted, true);
  const workerQualityScopeGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_SCOPE_GATE_ENABLED") ?? asBoolean(workerNode.quality_scope_gate_enabled, true);
  const workerQualityValidationGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_VALIDATION_GATE_ENABLED") ?? asBoolean(workerNode.quality_validation_gate_enabled, true);
  const workerQualityCriticGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_CRITIC_GATE_ENABLED") ?? asBoolean(workerNode.quality_critic_gate_enabled, true);
  const workerQualityPublishGateEnabled = parseBoolEnv("WORKERPALS_QUALITY_PUBLISH_GATE_ENABLED") ?? asBoolean(workerNode.quality_publish_gate_enabled, true);
  const workerQualityCriticMinScore = (() => {
    const configThresholdRaw = workerNode.quality_critic_min_score == null ? "" : String(workerNode.quality_critic_min_score);
    const raw = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MIN_SCORE, configThresholdRaw, String(DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE));
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed))
      return DEFAULT_WORKERPALS_QUALITY_CRITIC_MIN_SCORE;
    return Math.max(0, Math.min(10, parsed));
  })();
  const workerQualityCriticModel = firstNonEmpty(process.env.WORKERPALS_QUALITY_CRITIC_MODEL, asString(workerNode.quality_critic_model, ""), "");
  const workerQualityCriticMaxDiffChars = Math.max(256, Math.min(524288, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS") ?? workerNode.quality_critic_max_diff_chars, DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_DIFF_CHARS)));
  const workerQualityCriticMaxValidationOutputChars = Math.max(256, Math.min(524288, asInt(parseIntEnv("WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS") ?? workerNode.quality_critic_max_validation_output_chars, DEFAULT_WORKERPALS_QUALITY_CRITIC_MAX_VALIDATION_OUTPUT_CHARS)));
  const workerExecutorResultPrefix = (() => {
    if (process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX !== undefined) {
      const raw = process.env.WORKERPALS_EXECUTOR_RESULT_PREFIX;
      if (typeof raw === "string" && raw.length > 0)
        return raw;
    }
    if (Object.prototype.hasOwnProperty.call(workerNode, "executor_result_prefix") && typeof workerNode.executor_result_prefix === "string" && workerNode.executor_result_prefix.length > 0) {
      return workerNode.executor_result_prefix;
    }
    return DEFAULT_WORKERPALS_EXECUTOR_RESULT_PREFIX;
  })();
  const workerOpenHandsStuckGuardEnabled = parseBoolEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_ENABLED") ?? asBoolean(workerNode.openhands_stuck_guard_enabled, true);
  const workerOpenHandsStuckGuardExploreLimit = Math.max(6, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_EXPLORE_LIMIT") ?? workerNode.openhands_stuck_guard_explore_limit, 18));
  const workerOpenHandsStuckGuardMinElapsedMs = Math.max(60000, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_MIN_ELAPSED_MS") ?? workerNode.openhands_stuck_guard_min_elapsed_ms, 180000));
  const workerOpenHandsStuckGuardBroadScanLimit = Math.max(1, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_BROAD_SCAN_LIMIT") ?? workerNode.openhands_stuck_guard_broad_scan_limit, 2));
  const workerOpenHandsStuckGuardNoProgressMaxMs = Math.max(60000, asInt(parseIntEnv("WORKERPALS_OPENHANDS_STUCK_GUARD_NO_PROGRESS_MAX_MS") ?? workerNode.openhands_stuck_guard_no_progress_max_ms, 300000));
  const workerOpenHandsAutoSteerEnabled = parseBoolEnv("WORKERPALS_OPENHANDS_AUTO_STEER_ENABLED") ?? asBoolean(workerOpenHandsNode.auto_steer_enabled, true);
  const workerOpenHandsAutoSteerInitialDelaySec = Math.max(0, Math.min(600, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INITIAL_DELAY_SEC") ?? workerOpenHandsNode.auto_steer_initial_delay_sec, 90)));
  const workerOpenHandsAutoSteerIntervalSec = Math.max(15, Math.min(600, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_INTERVAL_SEC") ?? workerOpenHandsNode.auto_steer_interval_sec, 60)));
  const workerOpenHandsAutoSteerMaxNudges = Math.max(0, Math.min(120, asInt(parseIntEnv("WORKERPALS_OPENHANDS_AUTO_STEER_MAX_NUDGES") ?? workerOpenHandsNode.auto_steer_max_nudges, 30)));
  const workerRequirePush = parseBoolEnv("WORKERPALS_REQUIRE_PUSH") ?? asBoolean(workerNode.require_push, false);
  const workerPushAgentBranchEnv = parseBoolEnv("WORKERPALS_PUSH_AGENT_BRANCH");
  const workerPushAgentBranch = workerRequirePush || (workerPushAgentBranchEnv ?? asBoolean(workerNode.push_agent_branch, false));
  const workerSkipDockerSelfCheck = parseBoolEnv("WORKERPALS_SKIP_DOCKER_SELF_CHECK") ?? asBoolean(workerNode.skip_docker_self_check, false);
  const workerDockerAgentStartupTimeoutMs = Math.max(1e4, Math.min(180000, asInt(parseIntEnv("WORKERPALS_DOCKER_AGENT_STARTUP_TIMEOUT_MS") ?? workerNode.docker_agent_startup_timeout_ms, 45000)));
  const workerDockerWarmMaxAttempts = Math.max(1, Math.min(5, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_MAX_ATTEMPTS") ?? workerNode.docker_warm_max_attempts, 3)));
  const workerDockerWarmRetryBackoffMs = Math.max(250, Math.min(60000, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_RETRY_BACKOFF_MS") ?? workerNode.docker_warm_retry_backoff_ms, 2000)));
  const workerDockerJobMaxAttempts = Math.max(1, Math.min(3, asInt(parseIntEnv("WORKERPALS_DOCKER_JOB_MAX_ATTEMPTS") ?? workerNode.docker_job_max_attempts, 2)));
  const workerDockerJobRetryBackoffMs = Math.max(250, Math.min(60000, asInt(parseIntEnv("WORKERPALS_DOCKER_JOB_RETRY_BACKOFF_MS") ?? workerNode.docker_job_retry_backoff_ms, 3000)));
  const workerDockerWarmMemoryMb = Math.max(512, Math.min(32768, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_MEMORY_MB") ?? workerNode.docker_warm_memory_mb, 2048)));
  const workerDockerWarmCpus = Math.max(1, Math.min(16, asInt(parseIntEnv("WORKERPALS_DOCKER_WARM_CPUS") ?? workerNode.docker_warm_cpus, 2)));
  const workerDependencyPreparationTimeoutMs = Math.max(30000, Math.min(20 * 60000, asInt(parseIntEnv("WORKERPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS") ?? parseIntEnv("PUSHPALS_DEPENDENCY_PREPARATION_TIMEOUT_MS") ?? workerNode.dependency_preparation_timeout_ms, 5 * 60000)));
  const workerLlm = resolveLlmConfig(workerNode, "WORKERPALS", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "local-model",
    sessionId: "workerpals-dev"
  }, sessionId);
  const scmNode = getObject(merged, "source_control_manager");
  const scmRepoPath = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REPO_PATH, asString(scmNode.repo_path, ".worktrees/source_control_manager"), ".worktrees/source_control_manager"));
  const scmRemote = asString(process.env.SOURCE_CONTROL_MANAGER_REMOTE ?? scmNode.remote, "origin");
  const scmMainBranch = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_MAIN_BRANCH, process.env.PUSHPALS_INTEGRATION_BRANCH, asString(scmNode.pushpals_branch, "main_agents"), "main_agents");
  const scmBaseBranch = firstNonEmpty(process.env.PUSHPALS_INTEGRATION_BASE_BRANCH, asString(scmNode.base_branch, "main"), "main");
  const scmBranchPrefix = asString(process.env.SOURCE_CONTROL_MANAGER_BRANCH_PREFIX ?? scmNode.branch_prefix, "agent/");
  const scmPollIntervalSeconds = Math.max(1, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_POLL_INTERVAL_SECONDS") ?? scmNode.poll_interval_seconds, 10));
  const scmChecks = asCheckArray(scmNode.checks);
  const scmStateDir = resolvePathFromRoot(projectRoot, firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_STATE_DIR, asString(scmNode.state_dir, join2(dataDir, "source_control_manager")), join2(dataDir, "source_control_manager")));
  const scmPort = Math.max(1, Math.min(65535, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_PORT") ?? scmNode.port, 3002)));
  const scmDeleteAfterMerge = parseBoolEnv("SOURCE_CONTROL_MANAGER_DELETE_AFTER_MERGE") ?? asBoolean(scmNode.delete_after_merge, false);
  const scmMaxAttempts = Math.max(1, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_MAX_ATTEMPTS") ?? scmNode.max_attempts, 3));
  const scmMergeStrategyRaw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_MERGE_STRATEGY, asString(scmNode.merge_strategy, "cherry-pick"), "cherry-pick");
  const scmMergeStrategy = scmMergeStrategyRaw === "no-ff" || scmMergeStrategyRaw === "ff-only" ? scmMergeStrategyRaw : "cherry-pick";
  let scmPushMainAfterMerge = asBoolean(scmNode.push_main_after_merge, true);
  const scmPushMainAfterMergeEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_PUSH_MAIN_AFTER_MERGE");
  if (scmPushMainAfterMergeEnv != null)
    scmPushMainAfterMerge = scmPushMainAfterMergeEnv;
  const scmNoPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_NO_PUSH");
  if (scmNoPushEnv != null)
    scmPushMainAfterMerge = !scmNoPushEnv;
  let scmOpenPrAfterPush = asBoolean(scmNode.open_pr_after_push, true);
  const scmOpenPrAfterPushEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_OPEN_PR_AFTER_PUSH");
  if (scmOpenPrAfterPushEnv != null)
    scmOpenPrAfterPush = scmOpenPrAfterPushEnv;
  const scmDisableAutoPrEnv = parseBoolEnv("SOURCE_CONTROL_MANAGER_DISABLE_AUTO_PR");
  if (scmDisableAutoPrEnv != null)
    scmOpenPrAfterPush = !scmDisableAutoPrEnv;
  const scmPrBaseBranch = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_BASE_BRANCH, asString(scmNode.pr_base_branch, scmBaseBranch), scmBaseBranch);
  const scmPrTitle = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_TITLE, asString(scmNode.pr_title, ""));
  const scmPrBody = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_PR_BODY, asString(scmNode.pr_body, ""));
  const scmPrDraft = parseBoolEnv("SOURCE_CONTROL_MANAGER_PR_DRAFT") ?? asBoolean(scmNode.pr_draft, false);
  const scmStatusHeartbeatMs = Math.max(0, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_STATUS_HEARTBEAT_MS") ?? globalStatusHeartbeatMs ?? scmNode.status_heartbeat_ms, 120000));
  const scmSkipCleanCheck = parseBoolEnv("SOURCE_CONTROL_MANAGER_SKIP_CLEAN_CHECK") ?? asBoolean(scmNode.skip_clean_check, false);
  const scmAutoCreateMainBranch = parseBoolEnv("SOURCE_CONTROL_MANAGER_AUTO_CREATE_MAIN_BRANCH") ?? asBoolean(scmNode.auto_create_main_branch, false);
  const scmReviewAgentNode = getObject(scmNode, "review_agent");
  const scmReviewAgentEnabled = parseBoolEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_ENABLED") ?? asBoolean(scmReviewAgentNode.enabled, false);
  const scmReviewAgentPollIntervalMs = Math.max(5000, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_POLL_INTERVAL_MS") ?? scmReviewAgentNode.poll_interval_ms, 60000));
  const scmReviewAgentReviewerMdPath = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_REVIEWER_MD_PATH, asString(scmReviewAgentNode.reviewer_md_path, "prompts/review_agent/reviewer.md"), "prompts/review_agent/reviewer.md");
  const scmReviewAgentPassThreshold = (() => {
    const configThresholdRaw = scmReviewAgentNode.pass_threshold == null ? "" : String(scmReviewAgentNode.pass_threshold);
    const raw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_PASS_THRESHOLD, configThresholdRaw, "9.5");
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(10, parsed)) : 9.5;
  })();
  const scmReviewAgentMaxPrCommentsBeforeGiveUp = Math.max(1, Math.min(100, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MAX_PR_COMMENTS_BEFORE_GIVE_UP") ?? scmReviewAgentNode.max_pr_comments_before_give_up, 10)));
  const scmReviewAgentMergeMethodRaw = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_MERGE_METHOD, asString(scmReviewAgentNode.merge_method, "squash"), "squash").toLowerCase();
  const scmReviewAgentMergeMethod = scmReviewAgentMergeMethodRaw === "merge" || scmReviewAgentMergeMethodRaw === "rebase" ? scmReviewAgentMergeMethodRaw : "squash";
  const scmReviewAgentCodexBin = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_BIN, asString(scmReviewAgentNode.codex_bin, "bun x --yes @openai/codex"), "bun x --yes @openai/codex");
  const scmReviewAgentCodexAuthMode = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_AUTH_MODE, asString(scmReviewAgentNode.codex_auth_mode, "chatgpt"), "chatgpt");
  const scmReviewAgentCodexHomeDir = firstNonEmpty(process.env.SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_HOME_DIR, asString(scmReviewAgentNode.codex_home_dir, ""));
  const scmReviewAgentCodexTimeoutMs = Math.max(30000, asInt(parseIntEnv("SOURCE_CONTROL_MANAGER_REVIEW_AGENT_CODEX_TIMEOUT_MS") ?? scmReviewAgentNode.codex_timeout_ms, 300000));
  const startupNode = getObject(merged, "startup");
  const startupWorkerImageRebuild = normalizeWorkerImageRebuildMode(firstNonEmpty(process.env.PUSHPALS_WORKER_IMAGE_REBUILD, asString(startupNode.worker_image_rebuild, "auto"), "auto"));
  const startupLogConfigOnStart = parseBoolEnv("PUSHPALS_LOG_CONFIG_ON_START") ?? asBoolean(startupNode.log_config_on_start, true);
  const startupSyncIntegrationWithMain = parseBoolEnv("PUSHPALS_SYNC_INTEGRATION_WITH_MAIN") ?? asBoolean(startupNode.sync_integration_with_main, true);
  const startupSkipLlmPreflight = parseBoolEnv("PUSHPALS_SKIP_LLM_PREFLIGHT") ?? asBoolean(startupNode.skip_llm_preflight, false);
  const startupAutoStartLmStudio = parseBoolEnv("PUSHPALS_AUTO_START_LMSTUDIO") ?? asBoolean(startupNode.auto_start_lmstudio, true);
  const startupLmStudioReadyTimeoutMs = Math.max(1000, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_READY_TIMEOUT_MS") ?? startupNode.lmstudio_ready_timeout_ms, 120000));
  const startupLmStudioCli = firstNonEmpty(process.env.PUSHPALS_LMSTUDIO_CLI, asString(startupNode.lmstudio_cli, "lms"), "lms");
  const startupLmStudioPort = Math.max(1, Math.min(65535, asInt(parseIntEnv("PUSHPALS_LMSTUDIO_PORT") ?? startupNode.lmstudio_port, 1234)));
  const startupLmStudioStartArgs = firstNonEmpty(process.env.PUSHPALS_LMSTUDIO_START_ARGS, asString(startupNode.lmstudio_start_args, ""));
  const startupWarmup = parseBoolEnv("PUSHPALS_STARTUP_WARMUP") ?? asBoolean(startupNode.startup_warmup, true);
  const startupWarmupTimeoutMs = Math.max(15000, asInt(parseIntEnv("PUSHPALS_STARTUP_WARMUP_TIMEOUT_MS") ?? startupNode.startup_warmup_timeout_ms, 120000));
  const startupWarmupPollMs = Math.max(250, Math.min(5000, asInt(parseIntEnv("PUSHPALS_STARTUP_WARMUP_POLL_MS") ?? startupNode.startup_warmup_poll_ms, 1000)));
  const startupAllowExternalClean = parseBoolEnv("PUSHPALS_ALLOW_EXTERNAL_CLEAN") ?? asBoolean(startupNode.allow_external_clean, false);
  const startupPortPreflight = parseBoolEnv("PUSHPALS_STARTUP_PORT_PREFLIGHT") ?? asBoolean(startupNode.port_preflight, true);
  const startupPortConflictPolicy = normalizeStartupPortConflictPolicy(firstNonEmpty(process.env.PUSHPALS_STARTUP_PORT_CONFLICT_POLICY, asString(startupNode.port_conflict_policy, "terminate_pushpals"), "terminate_pushpals"));
  const clientNode = getObject(merged, "client");
  const authToken = firstNonEmpty(process.env.PUSHPALS_AUTH_TOKEN) || null;
  const gitToken = firstNonEmpty(process.env.PUSHPALS_GIT_TOKEN, process.env.GITHUB_TOKEN, process.env.GH_TOKEN) || null;
  const config = {
    projectRoot,
    configDir,
    profile,
    sessionId,
    authToken,
    gitToken,
    llm: {
      lmstudio: {
        contextWindow: lmStudioContextWindow,
        minOutputTokens: lmStudioMinOutputTokens,
        tokenSafetyMargin: lmStudioTokenSafetyMargin,
        batchTailMessages: lmStudioBatchTailMessages,
        batchChunkTokens: lmStudioBatchChunkTokens,
        batchMemoryChars: lmStudioBatchMemoryChars
      }
    },
    paths: {
      dataDir,
      sharedDbPath,
      remotebuddyDbPath
    },
    server: {
      url: serverUrl,
      host: serverHost,
      port: serverPort,
      debugHttp,
      staleClaimTtlMs,
      staleClaimSweepIntervalMs,
      sessionTokenBudget,
      sessionTokenBudgetAction
    },
    localbuddy: {
      enabled: localEnabled,
      port: localPort,
      statusHeartbeatMs: localStatusHeartbeatMs,
      llm: localLlm
    },
    remotebuddy: {
      pollMs: remotePollMs,
      statusHeartbeatMs: remoteStatusHeartbeatMs,
      workerpalOnlineTtlMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_ONLINE_TTL_MS") ?? remoteNode.workerpal_online_ttl_ms, 15000)),
      waitForWorkerpalMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_WAIT_FOR_WORKERPAL_MS") ?? remoteNode.wait_for_workerpal_ms, 15000)),
      autoSpawnWorkerpals: parseBoolEnv("REMOTEBUDDY_AUTO_SPAWN_WORKERPALS") ?? asBoolean(remoteNode.auto_spawn_workerpals, true),
      minWorkerpals: remoteMinWorkerpals,
      maxWorkerpals: remoteMaxWorkerpals,
      workerpalStartupTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_WORKERPAL_STARTUP_TIMEOUT_MS") ?? remoteNode.workerpal_startup_timeout_ms, 1e4)),
      workerpalDocker: effectiveRemoteWorkerpalDocker,
      workerpalRequireDocker: effectiveRemoteWorkerpalRequireDocker,
      workerpalImage: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_IMAGE, asString(remoteNode.workerpal_image, "")) || null,
      workerpalPollMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_POLL_MS")) ?? asIntOrNull(remoteNode.workerpal_poll_ms),
      workerpalHeartbeatMs: asIntOrNull(parseIntEnv("REMOTEBUDDY_WORKERPAL_HEARTBEAT_MS")) ?? asIntOrNull(remoteNode.workerpal_heartbeat_ms),
      workerpalLabels: firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS) ? firstNonEmpty(process.env.REMOTEBUDDY_WORKERPAL_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(remoteNode.workerpal_labels),
      executionBudgetInteractiveMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_INTERACTIVE_MS") ?? remoteNode.execution_budget_interactive_ms, 300000)),
      executionBudgetNormalMs: Math.max(120000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_NORMAL_MS") ?? remoteNode.execution_budget_normal_ms, 900000)),
      executionBudgetBackgroundMs: Math.max(180000, asInt(parseIntEnv("REMOTEBUDDY_EXECUTION_BUDGET_BACKGROUND_MS") ?? remoteNode.execution_budget_background_ms, 1200000)),
      finalizationBudgetMs: Math.max(30000, asInt(parseIntEnv("REMOTEBUDDY_FINALIZATION_BUDGET_MS") ?? remoteNode.finalization_budget_ms, 120000)),
      crashRestartEnabled: parseBoolEnv("REMOTEBUDDY_CRASH_RESTART_ENABLED") ?? asBoolean(remoteNode.crash_restart_enabled, true),
      crashRestartMaxRestarts: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_CRASH_RESTART_MAX_RESTARTS") ?? remoteNode.crash_restart_max_restarts, 3)),
      crashRestartBackoffMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_CRASH_RESTART_BACKOFF_MS") ?? remoteNode.crash_restart_backoff_ms, 3000)),
      memory: {
        enabled: remoteMemoryEnabled,
        includeCrossSession: remoteMemoryIncludeCrossSession,
        maxRecallItems: remoteMemoryMaxRecallItems,
        maxRecallChars: remoteMemoryMaxRecallChars,
        maxSummaryChars: remoteMemoryMaxSummaryChars,
        retentionDays: remoteMemoryRetentionDays
      },
      autonomy: {
        enabled: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ENABLED") ?? asBoolean(remoteAutonomyNode.enabled, true),
        killSwitchEnabled: parseBoolEnv("REMOTEBUDDY_AUTONOMY_KILL_SWITCH_ENABLED") ?? asBoolean(remoteAutonomyNode.kill_switch_enabled, false),
        tickIntervalMs: Math.max(5000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TICK_INTERVAL_MS") ?? remoteAutonomyNode.tick_interval_ms, 120000)),
        startupGraceMs: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STARTUP_GRACE_MS") ?? remoteAutonomyNode.startup_grace_ms, 120000)),
        heartbeatLogMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_HEARTBEAT_LOG_MS") ?? remoteAutonomyNode.heartbeat_log_ms, 30000)),
        visionContextMaxChars: Math.max(1000, Math.min(1e6, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_VISION_CONTEXT_MAX_CHARS") ?? remoteAutonomyNode.vision_context_max_chars, 65536))),
        ideationBudgetMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_BUDGET_MS") ?? remoteAutonomyNode.ideation_budget_ms, 20000)),
        llmTimeoutMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_LLM_TIMEOUT_MS") ?? remoteAutonomyNode.llm_timeout_ms, 12000)),
        allowDirtyWorktree: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_DIRTY_WORKTREE") ?? asBoolean(remoteAutonomyNode.allow_dirty_worktree, false),
        ideationMaxCandidates: Math.max(1, Math.min(100, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_IDEATION_MAX_CANDIDATES") ?? remoteAutonomyNode.ideation_max_candidates, 20))),
        topK: Math.max(1, Math.min(20, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_TOP_K") ?? remoteAutonomyNode.top_k, 3))),
        exploreRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EXPLORE_RATE, asString(remoteAutonomyNode.explore_rate, "0.3"), "0.3")));
          return Number.isFinite(parsed) ? parsed : 0.3;
        })())),
        minConfidence: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_MIN_CONFIDENCE, asString(remoteAutonomyNode.min_confidence, "0.65"), "0.65")));
          return Number.isFinite(parsed) ? parsed : 0.65;
        })())),
        maxConcurrentObjectives: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_CONCURRENT_OBJECTIVES") ?? remoteAutonomyNode.max_concurrent_objectives, 2)),
        maxDispatchPerHour: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_DISPATCH_PER_HOUR") ?? remoteAutonomyNode.max_dispatch_per_hour, 6)),
        maxDispatchPerHourByType: remoteAutonomyDispatchByType,
        maxDispatchPerHourByComponent: remoteAutonomyDispatchByComponent,
        maxTokenUsagePerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_TOKEN_USAGE_PER_HOUR") ?? remoteAutonomyNode.max_token_usage_per_hour, 0)),
        maxRuntimeMsPerHour: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_MAX_RUNTIME_MS_PER_HOUR") ?? remoteAutonomyNode.max_runtime_ms_per_hour, 0)),
        cooldownFailStreakThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_FAIL_STREAK_THRESHOLD") ?? remoteAutonomyNode.cooldown_fail_streak_threshold, 2)),
        cooldownMs: Math.max(1000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_COOLDOWN_MS") ?? remoteAutonomyNode.cooldown_ms, 1800000)),
        staleObjectiveTtlMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_TTL_MS") ?? remoteAutonomyNode.stale_objective_ttl_ms, 2700000)),
        staleObjectiveSweepIntervalMs: Math.max(5000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_STALE_OBJECTIVE_SWEEP_INTERVAL_MS") ?? remoteAutonomyNode.stale_objective_sweep_interval_ms, 60000)),
        autoFreezeFailStreakThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_FAIL_STREAK_THRESHOLD") ?? remoteAutonomyNode.auto_freeze_fail_streak_threshold, 3)),
        autoFreezeDurationMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_AUTO_FREEZE_DURATION_MS") ?? remoteAutonomyNode.auto_freeze_duration_ms, 1800000)),
        evaluatorWindowHours: Math.max(1, Math.min(168, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_WINDOW_HOURS") ?? remoteAutonomyNode.evaluator_window_hours, 24))),
        evaluatorMinSamples: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SAMPLES") ?? remoteAutonomyNode.evaluator_min_samples, 6)),
        evaluatorMinSuccessRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MIN_SUCCESS_RATE, asString(remoteAutonomyNode.evaluator_min_success_rate, "0.45"), "0.45")));
          return Number.isFinite(parsed) ? parsed : 0.45;
        })())),
        evaluatorMaxRegretRate: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_EVALUATOR_MAX_REGRET_RATE, asString(remoteAutonomyNode.evaluator_max_regret_rate, "0.35"), "0.35")));
          return Number.isFinite(parsed) ? parsed : 0.35;
        })())),
        evaluatorRunIntervalMs: Math.max(1e4, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_EVALUATOR_RUN_INTERVAL_MS") ?? remoteAutonomyNode.evaluator_run_interval_ms, 120000)),
        alertQueuePendingThreshold: Math.max(1, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_ALERT_QUEUE_PENDING_THRESHOLD") ?? remoteAutonomyNode.alert_queue_pending_threshold, 20)),
        alertJobFailureRateThreshold: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_ALERT_JOB_FAILURE_RATE_THRESHOLD, asString(remoteAutonomyNode.alert_job_failure_rate_threshold, "0.3"), "0.3")));
          return Number.isFinite(parsed) ? parsed : 0.3;
        })())),
        alertAutonomyFailureRateThreshold: Math.max(0, Math.min(1, (() => {
          const parsed = Number.parseFloat(String(firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_ALERT_AUTONOMY_FAILURE_RATE_THRESHOLD, asString(remoteAutonomyNode.alert_autonomy_failure_rate_threshold, "0.45"), "0.45")));
          return Number.isFinite(parsed) ? parsed : 0.45;
        })())),
        allowReadAnywhere: parseBoolEnv("REMOTEBUDDY_AUTONOMY_ALLOW_READ_ANYWHERE") ?? asBoolean(remoteAutonomyNode.allow_read_anywhere, true),
        prFeedbackCommentRows: Math.max(1, Math.min(200, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_ROWS") ?? remoteAutonomyNode.pr_feedback_comment_rows, 16))),
        prFeedbackCommentChars: Math.max(32, Math.min(20000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_COMMENT_CHARS") ?? remoteAutonomyNode.pr_feedback_comment_chars, 600))),
        prFeedbackSummaryChars: Math.max(32, Math.min(20000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_PR_FEEDBACK_SUMMARY_CHARS") ?? remoteAutonomyNode.pr_feedback_summary_chars, 600))),
        questionTtlMs: Math.max(60000, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_QUESTION_TTL_MS") ?? remoteAutonomyNode.question_ttl_ms, 259200000)),
        policyVersion: firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_POLICY_VERSION, asString(remoteAutonomyNode.policy_version, "policy-v3.3"), "policy-v3.3"),
        impactModelVersion: firstNonEmpty(process.env.REMOTEBUDDY_AUTONOMY_IMPACT_MODEL_VERSION, asString(remoteAutonomyNode.impact_model_version, "impact-v1"), "impact-v1"),
        replay: {
          storePromptPayloads: parseBoolEnv("REMOTEBUDDY_AUTONOMY_REPLAY_STORE_PROMPT_PAYLOADS") ?? asBoolean(remoteAutonomyReplayNode.store_prompt_payloads, false),
          maxRunsWithPayloads: Math.max(0, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_RUNS_WITH_PAYLOADS") ?? remoteAutonomyReplayNode.max_runs_with_payloads, 50)),
          maxPayloadBytes: Math.max(1024, asInt(parseIntEnv("REMOTEBUDDY_AUTONOMY_REPLAY_MAX_PAYLOAD_BYTES") ?? remoteAutonomyReplayNode.max_payload_bytes, 262144))
        }
      },
      llm: remoteLlm
    },
    workerpals: {
      pollMs: workerPollMs,
      heartbeatMs: workerHeartbeatMs,
      executionPlatform: workerExecutionPlatform,
      executor: workerExecutor,
      openhandsPython: workerOpenHandsPython,
      openhandsTimeoutMs: workerOpenHandsTimeoutMs,
      miniswePython: workerMiniswePython,
      minisweTimeoutMs: workerMinisweTimeoutMs,
      openaiCodexPython: workerOpenAICodexPython,
      openaiCodexTimeoutMs: workerOpenAICodexTimeoutMs,
      openhandsStuckGuardEnabled: workerOpenHandsStuckGuardEnabled,
      openhandsStuckGuardExploreLimit: workerOpenHandsStuckGuardExploreLimit,
      openhandsStuckGuardMinElapsedMs: workerOpenHandsStuckGuardMinElapsedMs,
      openhandsStuckGuardBroadScanLimit: workerOpenHandsStuckGuardBroadScanLimit,
      openhandsStuckGuardNoProgressMaxMs: workerOpenHandsStuckGuardNoProgressMaxMs,
      openhandsAutoSteerEnabled: workerOpenHandsAutoSteerEnabled,
      openhandsAutoSteerInitialDelaySec: workerOpenHandsAutoSteerInitialDelaySec,
      openhandsAutoSteerIntervalSec: workerOpenHandsAutoSteerIntervalSec,
      openhandsAutoSteerMaxNudges: workerOpenHandsAutoSteerMaxNudges,
      requirePush: workerRequirePush,
      pushAgentBranch: workerPushAgentBranch,
      requireDocker: effectiveWorkerRequireDocker,
      skipDockerSelfCheck: workerSkipDockerSelfCheck,
      dockerImage: firstNonEmpty(process.env.WORKERPALS_DOCKER_IMAGE, asString(workerNode.docker_image, "pushpals-worker-sandbox:latest"), "pushpals-worker-sandbox:latest"),
      dockerTimeoutMs: Math.max(1e4, asInt(parseIntEnv("WORKERPALS_DOCKER_TIMEOUT_MS") ?? workerNode.docker_timeout_ms, 7260000)),
      dockerIdleTimeoutMs: Math.max(0, asInt(parseIntEnv("WORKERPALS_DOCKER_IDLE_TIMEOUT_MS") ?? workerNode.docker_idle_timeout_ms, 600000)),
      dockerAgentStartupTimeoutMs: workerDockerAgentStartupTimeoutMs,
      dockerWarmMaxAttempts: workerDockerWarmMaxAttempts,
      dockerWarmRetryBackoffMs: workerDockerWarmRetryBackoffMs,
      dockerJobMaxAttempts: workerDockerJobMaxAttempts,
      dockerJobRetryBackoffMs: workerDockerJobRetryBackoffMs,
      dockerWarmMemoryMb: workerDockerWarmMemoryMb,
      dockerWarmCpus: workerDockerWarmCpus,
      dependencyPreparationTimeoutMs: workerDependencyPreparationTimeoutMs,
      fileModifyingJobs: workerFileModifyingJobs,
      outputMaxChars: workerOutputMaxChars,
      outputMaxLines: workerOutputMaxLines,
      outputMaxHeadLines: workerOutputMaxHeadLines,
      qualityMaxAutoRevisions: workerQualityMaxAutoRevisions,
      qualityValidationMaxAutoRevisions: workerQualityValidationMaxAutoRevisions,
      qualityScopeGateEnabled: workerQualityScopeGateEnabled,
      qualityValidationGateEnabled: workerQualityValidationGateEnabled,
      qualityCriticGateEnabled: workerQualityCriticGateEnabled,
      qualityPublishGateEnabled: workerQualityPublishGateEnabled,
      qualityValidationStepTimeoutMs: workerQualityValidationStepTimeoutMs,
      qualityCriticTimeoutMs: workerQualityCriticTimeoutMs,
      qualityCriticTimeoutBehavior: workerQualityCriticTimeoutBehavior,
      qualitySoftPassOnExhausted: workerQualitySoftPassOnExhausted,
      qualityCriticMinScore: workerQualityCriticMinScore,
      qualityCriticModel: workerQualityCriticModel,
      qualityCriticMaxDiffChars: workerQualityCriticMaxDiffChars,
      qualityCriticMaxValidationOutputChars: workerQualityCriticMaxValidationOutputChars,
      executorResultPrefix: workerExecutorResultPrefix,
      dockerNetworkMode: asString(process.env.WORKERPALS_DOCKER_NETWORK_MODE ?? workerNode.docker_network_mode, "bridge"),
      baseRef: firstNonEmpty(process.env.WORKERPALS_BASE_REF, asString(workerNode.base_ref, "origin/main_agents"), "origin/main_agents"),
      labels: firstNonEmpty(process.env.WORKERPALS_LABELS) ? firstNonEmpty(process.env.WORKERPALS_LABELS).split(",").map((value) => value.trim()).filter(Boolean) : asStringArray(workerNode.labels),
      failureCooldownMs: Math.max(0, asInt(parseIntEnv("WORKERPALS_FAILURE_COOLDOWN_MS") ?? parseIntEnv("WORKERPALS_DOCKER_FAILURE_COOLDOWN_MS") ?? workerNode.failure_cooldown_ms, 20000)),
      llm: workerLlm
    },
    sourceControlManager: {
      repoPath: scmRepoPath,
      remote: scmRemote,
      mainBranch: scmMainBranch,
      baseBranch: scmBaseBranch,
      branchPrefix: scmBranchPrefix,
      pollIntervalSeconds: scmPollIntervalSeconds,
      checks: scmChecks,
      stateDir: scmStateDir,
      port: scmPort,
      deleteAfterMerge: scmDeleteAfterMerge,
      maxAttempts: scmMaxAttempts,
      mergeStrategy: scmMergeStrategy,
      pushMainAfterMerge: scmPushMainAfterMerge,
      openPrAfterPush: scmOpenPrAfterPush,
      prBaseBranch: scmPrBaseBranch,
      prTitle: scmPrTitle || null,
      prBody: scmPrBody || null,
      prDraft: scmPrDraft,
      statusHeartbeatMs: scmStatusHeartbeatMs,
      skipCleanCheck: scmSkipCleanCheck,
      autoCreateMainBranch: scmAutoCreateMainBranch,
      reviewAgent: {
        enabled: scmReviewAgentEnabled,
        pollIntervalMs: scmReviewAgentPollIntervalMs,
        reviewerMdPath: scmReviewAgentReviewerMdPath,
        passThreshold: scmReviewAgentPassThreshold,
        maxPrCommentsBeforeGiveUp: scmReviewAgentMaxPrCommentsBeforeGiveUp,
        mergeMethod: scmReviewAgentMergeMethod,
        codexBin: scmReviewAgentCodexBin,
        codexAuthMode: scmReviewAgentCodexAuthMode,
        codexHomeDir: scmReviewAgentCodexHomeDir,
        codexTimeoutMs: scmReviewAgentCodexTimeoutMs
      }
    },
    startup: {
      workerImageRebuild: startupWorkerImageRebuild,
      logConfigOnStart: startupLogConfigOnStart,
      syncIntegrationWithMain: startupSyncIntegrationWithMain,
      skipLlmPreflight: startupSkipLlmPreflight,
      autoStartLmStudio: startupAutoStartLmStudio,
      lmStudioReadyTimeoutMs: startupLmStudioReadyTimeoutMs,
      lmStudioCli: startupLmStudioCli,
      lmStudioPort: startupLmStudioPort,
      lmStudioStartArgs: startupLmStudioStartArgs,
      startupWarmup,
      startupWarmupTimeoutMs,
      startupWarmupPollMs,
      allowExternalClean: startupAllowExternalClean,
      portPreflight: startupPortPreflight,
      portConflictPolicy: startupPortConflictPolicy
    },
    client: {
      localAgentUrl: normalizeLoopbackHttpUrl(firstNonEmpty(process.env.EXPO_PUBLIC_LOCAL_AGENT_URL, asString(clientNode.local_agent_url, `http://127.0.0.1:${localPort}`), `http://127.0.0.1:${localPort}`), localPort),
      traceTailLines: Math.max(10, asInt(parseIntEnv("EXPO_PUBLIC_PUSHPALS_TRACE_TAIL_LINES") ?? clientNode.trace_tail_lines, 100))
    }
  };
  cachedConfig = config;
  cachedConfigKey = cacheKey;
  return config;
}
// packages/shared/src/tooling.ts
var KNOWN_TOOL_NAMES = new Set([
  "bun",
  "codex",
  "docker",
  "gh",
  "git",
  "node",
  "npm",
  "python",
  "shell"
]);
// packages/shared/src/toolchain.ts
var SHELL_CONTROL_TOKENS = new Set(["|", "||", "&", "&&", ";", ">", ">>", "<", "<<"]);
var NODE_BACKED_CLI_NAMES = new Set([
  "astro",
  "babel",
  "cypress",
  "eslint",
  "expo",
  "jest",
  "metro",
  "next",
  "nuxt",
  "playwright",
  "react-native",
  "rollup",
  "tsc",
  "tsx",
  "vite",
  "vitest",
  "webpack"
]);
var BUN_OPTIONS_WITH_VALUE = new Set(["--cwd", "-C"]);
var PACKAGE_MANAGER_OPTIONS_WITH_VALUE = new Set([
  "--cwd",
  "--dir",
  "--filter",
  "--prefix",
  "--workspace",
  "-C",
  "-F"
]);
// packages/shared/src/trusted_validation.ts
var TRUSTED_VALIDATION_EXECUTABLES = new Set([
  "bun",
  "bunx",
  "cargo",
  "coverage",
  "deno",
  "docker",
  "docker-compose",
  "eslint",
  "go",
  "jest",
  "make",
  "mypy",
  "node",
  "npm",
  "npx",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "ruff",
  "tsc",
  "uv",
  "vitest",
  "yarn"
]);
// packages/shared/src/session_event_visibility.ts
var ALWAYS_VISIBLE_EVENT_TYPES = new Set(["question_asked"]);
// packages/shared/src/localbuddy_runtime.ts
var TRUTHY2 = new Set(["1", "true", "yes", "on"]);
var FALSY2 = new Set(["0", "false", "no", "off"]);
// apps/remotebuddy/src/llm.ts
import { spawn } from "child_process";
import { existsSync as existsSync3, mkdtempSync, readFileSync as readFileSync4, rmSync } from "fs";
import { tmpdir } from "os";
import { join as join3 } from "path";
var DEFAULT_LMSTUDIO_ENDPOINT = "http://127.0.0.1:1234";
var DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/chat";
var DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
var DEFAULT_MODEL = "local-model";
var DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
var LEGACY_CODEX_MODEL_FALLBACK = "gpt-5.5";
var DEFAULT_CODEX_REASONING_EFFORT = "xhigh";
var DEFAULT_CODEX_TIMEOUT_MS = 120000;
var DEFAULT_LLM_HTTP_TIMEOUT_MS = 120000;
var DEFAULT_LLM_MODEL_PROBE_TIMEOUT_MS = 1e4;
var DEFAULT_LLM_TELEMETRY_TIMEOUT_MS = 5000;
var DEFAULT_LMSTUDIO_CONTEXT_WINDOW = 4096;
var DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS = 256;
var DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN = 64;
var DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES = 3;
function resolveLlmHttpTimeoutMs(explicit, fallback) {
  const environmentValue = Number(process.env.PUSHPALS_LLM_HTTP_TIMEOUT_MS);
  const configured = typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0 ? explicit : Number.isFinite(environmentValue) && environmentValue > 0 ? environmentValue : fallback;
  return Math.max(1, Math.floor(configured));
}
function fetchLlmHttpResponse(input, init, timeoutMs, operation) {
  return fetchBufferedWithHardDeadline({
    input,
    init,
    timeoutMs,
    timeoutMessage: `${operation} timed out after ${timeoutMs}ms`
  });
}
var CONTEXT_PACKER_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/context_packer_system_prompt.md").trim();
var CONTEXT_PACKER_CONDENSED_HISTORY_SYSTEM_PROMPT = loadPromptTemplate("remotebuddy/context_packer_condensed_history_system_prompt.md").trim();
var KNOWN_PROVIDER_PREFIXES = new Set([
  "openai",
  "azure",
  "ollama",
  "openrouter",
  "anthropic",
  "google",
  "gemini",
  "vertex_ai",
  "bedrock",
  "cohere",
  "groq",
  "mistral",
  "huggingface",
  "replicate",
  "deepseek",
  "xai",
  "together_ai",
  "fireworks_ai"
]);
function splitArgs(raw) {
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const ch of raw.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped)
    current += "\\";
  if (current.length > 0)
    out.push(current);
  return out;
}
function normalizeCodexAuthMode(value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "auto")
    return "auto";
  if (normalized === "api_key" || normalized === "api-key" || normalized === "api") {
    return "api_key";
  }
  if (normalized === "chatgpt" || normalized === "chatgpt_login" || normalized === "chatgpt-pro" || normalized === "subscription") {
    return "chatgpt";
  }
  return "auto";
}
function codexConfiguredAuthMode(configuredValue) {
  return normalizeCodexAuthMode(firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_AUTH_MODE, configuredValue, "auto"));
}
function codexCommandOverrideParts(configuredValue) {
  const jsonOverride = firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_BIN_JSON);
  if (jsonOverride) {
    try {
      const parsed = JSON.parse(jsonOverride);
      if (Array.isArray(parsed)) {
        const args = parsed.map((item) => typeof item === "string" ? item.trim() : "").filter((item) => item.length > 0);
        if (args.length > 0)
          return args;
      }
    } catch {}
  }
  const stringOverride = firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_BIN, configuredValue, "") ?? "";
  if (!stringOverride)
    return [];
  return splitArgs(stringOverride);
}
function codexBaseUrlOverride() {
  return firstNonEmpty2(process.env.PUSHPALS_OPENAI_CODEX_BASE_URL, "") ?? "";
}
function codexTimeoutMs(configuredTimeoutMs) {
  const raw = typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? String(Math.floor(configuredTimeoutMs)) : "";
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0)
    return parsed;
  return DEFAULT_CODEX_TIMEOUT_MS;
}
function codexReasoningEffort(configured, model) {
  const raw = (configured ?? "").trim().toLowerCase();
  const supportsExtraHigh = !/^(gpt-5\.4(?:$|-)|codex-1p(?:$|-))/i.test(model.trim());
  const defaultEffort = supportsExtraHigh ? DEFAULT_CODEX_REASONING_EFFORT : "high";
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
    return raw === "xhigh" && !supportsExtraHigh ? "high" : raw;
  }
  if (raw === "extra high" || raw === "extra-high" || raw === "extrahigh" || raw === "x-high") {
    return supportsExtraHigh ? "xhigh" : "high";
  }
  return defaultEffort;
}
function isDefaultCodexLauncher(command) {
  const normalized = command.map((part) => part.trim().toLowerCase()).filter(Boolean);
  return normalized.length === 0 || normalized.join("\x00") === ["bun", "x", "--yes", "@openai/codex"].join("\x00") || normalized.join("\x00") === ["bunx", "--yes", "@openai/codex"].join("\x00");
}
function parseCodexCliVersion(text) {
  const match = text.match(/(?:codex(?:-cli)?|openai\s+codex)?\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?/i);
  if (!match)
    return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? ""
  };
}
function compareCodexVersions(a, b) {
  if (a && !b)
    return 1;
  if (!a && b)
    return -1;
  if (!a || !b)
    return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key])
      return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease)
    return 0;
  if (!a.prerelease)
    return 1;
  if (!b.prerelease)
    return -1;
  return a.prerelease.localeCompare(b.prerelease);
}
function chooseCodexCommandProbe(probes, opts) {
  if (probes.length === 0)
    return null;
  if (!opts.preferNewestCompatible)
    return probes[0];
  return probes.reduce((best, probe) => compareCodexVersions(probe.version, best.version) > 0 ? probe : best);
}
function requiresNewerCodexForModel(stdout, stderr) {
  const combined = `${stdout}
${stderr}`.toLowerCase();
  return combined.includes("requires a newer version of codex") || combined.includes("requires newer") && combined.includes("codex");
}
function isDefaultCodexModel(model) {
  return model.trim().toLowerCase() === DEFAULT_CODEX_MODEL.toLowerCase();
}
function normalizeCodexModel(rawModel) {
  const model = rawModel.trim();
  if (!model)
    return DEFAULT_CODEX_MODEL;
  if (!model.includes("/"))
    return model;
  const [provider, bare] = model.split("/", 2);
  if (provider.trim().toLowerCase() === "openai" && bare.trim()) {
    return bare.trim();
  }
  return model;
}
function normalizeOpenAiBaseFromEndpoint(rawEndpoint) {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  if (!trimmed)
    return "";
  if (trimmed.endsWith("/v1/chat/completions")) {
    return trimmed.slice(0, -"/chat/completions".length);
  }
  if (trimmed.endsWith("/chat/completions")) {
    const base = trimmed.slice(0, -"/chat/completions".length);
    if (!base)
      return "";
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
  return trimmed;
}
async function runProcess(command, opts) {
  const bunRuntime = globalThis.Bun;
  if (typeof bunRuntime?.spawn === "function") {
    return runProcessWithBun(command, opts);
  }
  return runProcessWithNode(command, opts);
}
async function runProcessWithBun(command, opts) {
  const timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : DEFAULT_CODEX_TIMEOUT_MS;
  const result = await runBoundedProcess(command, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: typeof opts.stdin === "string" ? new Blob([opts.stdin]) : "ignore",
    timeoutMs,
    outputLimitBytes: 4 * 1024 * 1024,
    streamDrainTimeoutMs: 2000
  });
  return {
    code: result.exitCode,
    signal: result.timedOut ? "SIGKILL" : null,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  };
}
async function runProcessWithNode(command, opts) {
  const timeoutMs = opts.timeoutMs ?? 0;
  return new Promise((resolve4, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "pipe"
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timeout = null;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (err) => {
      if (finished)
        return;
      finished = true;
      cleanup();
      reject(err);
    });
    child.once("close", (code, signal) => {
      if (finished)
        return;
      finished = true;
      cleanup();
      resolve4({ code, signal, stdout, stderr, timedOut });
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1000).unref();
      }, timeoutMs);
    }
    if (typeof opts.stdin === "string") {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}
var cachedCodexCommandPrefix = new Map;
function bunCodexCommandFromEnv(env) {
  const bunBin = (env.PUSHPALS_BUN_BIN ?? "").trim();
  return bunBin ? [bunBin, "x", "--yes", "@openai/codex"] : [];
}
async function resolveCodexCommandPrefix(configuredCommand) {
  const override = codexCommandOverrideParts(configuredCommand);
  const cacheKey = override.join("\x00");
  const cached = cachedCodexCommandPrefix.get(cacheKey);
  if (cached)
    return cached;
  const preferred = override.length > 0 ? override : ["bun", "x", "--yes", "@openai/codex"];
  const preferNewestCompatible = isDefaultCodexLauncher(preferred);
  const candidates = [];
  const pushCandidate = (cmd) => {
    if (cmd.length === 0)
      return;
    const key = cmd.join("\x00");
    if (candidates.some((existing) => existing.join("\x00") === key))
      return;
    candidates.push(cmd);
  };
  pushCandidate(preferred);
  pushCandidate(bunCodexCommandFromEnv(process.env));
  const execPath = (process.execPath ?? "").trim();
  if (execPath) {
    const lower = execPath.toLowerCase();
    if (lower.endsWith("bun") || lower.endsWith("bun.exe")) {
      pushCandidate([execPath, "x", "--yes", "@openai/codex"]);
    }
  }
  pushCandidate(["bun", "x", "--yes", "@openai/codex"]);
  pushCandidate(["bunx", "--yes", "@openai/codex"]);
  pushCandidate(["codex"]);
  const cwd = process.cwd();
  const env = process.env;
  const attemptErrors = [];
  const successfulProbes = [];
  for (const candidate of candidates) {
    if (candidate.length === 0)
      continue;
    const rendered = `${candidate.join(" ")} --version`;
    try {
      const probe = await runProcess([...candidate, "--version"], {
        cwd,
        env,
        timeoutMs: 15000
      });
      if (probe.code === 0) {
        const versionText = (probe.stdout || probe.stderr || "").trim().split(/\r?\n/, 1)[0] ?? "";
        successfulProbes.push({
          command: candidate,
          version: parseCodexCliVersion(versionText),
          versionText
        });
        if (!preferNewestCompatible)
          break;
        continue;
      }
      const detail = (probe.stderr || probe.stdout || "").trim();
      attemptErrors.push(`${rendered} -> exit ${probe.code ?? "unknown"}${detail ? ` (${detail.split(/\r?\n/, 1)[0]})` : ""}`);
    } catch (err) {
      attemptErrors.push(`${rendered} -> ${String(err)}`);
    }
  }
  const selected = chooseCodexCommandProbe(successfulProbes, { preferNewestCompatible });
  if (selected) {
    cachedCodexCommandPrefix.set(cacheKey, selected.command);
    console.log(`[LLM] Resolved Codex CLI command: ${selected.command.join(" ")}${selected.versionText ? ` (${selected.versionText})` : ""}.`);
    return selected.command;
  }
  const details = attemptErrors.length > 0 ? ` Tried: ${attemptErrors.join("; ")}` : "";
  throw new Error("OpenAI Codex CLI is unavailable. Install/use Codex CLI (`bun x --yes @openai/codex` or `codex`) and retry." + details);
}
function normalizeBackend2(value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "lmstudio")
    return "lmstudio";
  if (normalized === "ollama")
    return "ollama";
  if (normalized === "openai" || normalized === "openai_compatible")
    return "openai";
  if (normalized === "openai_codex" || normalized === "codex" || normalized === "codex_cli") {
    return "openai_codex";
  }
  return null;
}
function endpointHost(endpoint) {
  const trimmed = endpoint.trim();
  if (!trimmed)
    return "";
  try {
    return new URL(trimmed).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}
function isOpenAIEndpoint(endpoint) {
  const host = endpointHost(endpoint);
  if (!host)
    return false;
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}
function configuredBackend(endpoint, explicitBackend) {
  const explicit = normalizeBackend2(explicitBackend);
  if (explicit === "openai_codex")
    return explicit;
  if (explicit === "ollama")
    return explicit;
  if (isOpenAIEndpoint(endpoint))
    return "openai";
  if (explicit)
    return explicit;
  return endpoint.includes("/api/chat") ? "ollama" : "lmstudio";
}
function firstNonEmpty2(...values) {
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed)
      return trimmed;
  }
  return null;
}
function resolveServiceLlmConfig(opts = {}) {
  const service = opts.service ?? "remotebuddy";
  const config = loadPushPalsConfig();
  const serviceLlmConfig = service === "localbuddy" ? config.localbuddy.llm : service === "workerpals" ? config.workerpals.llm : config.remotebuddy.llm;
  const explicitBackend = normalizeBackend2(firstNonEmpty2(opts.backend, serviceLlmConfig.backend));
  const fallbackEndpoint = explicitBackend === "ollama" ? DEFAULT_OLLAMA_ENDPOINT : explicitBackend === "openai" || explicitBackend === "openai_codex" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
  const endpoint = firstNonEmpty2(opts.endpoint, serviceLlmConfig.endpoint, fallbackEndpoint);
  let backend = configuredBackend(endpoint ?? "", explicitBackend);
  const configuredModel = firstNonEmpty2(opts.model, serviceLlmConfig.model, "");
  let model = firstNonEmpty2(configuredModel, backend === "openai_codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL) ?? DEFAULT_MODEL;
  if (backend === "openai_codex" && model === DEFAULT_MODEL) {
    model = DEFAULT_CODEX_MODEL;
  }
  const requestedCodexAuthMode = firstNonEmpty2(opts.codexAuthMode, serviceLlmConfig.codexAuthMode, "") ?? "";
  const openAiApiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  const apiKey = firstNonEmpty2(opts.apiKey, serviceLlmConfig.apiKey, backend === "lmstudio" ? "lmstudio" : backend === "openai" || backend === "openai_codex" ? openAiApiKey : "") ?? "";
  if (service !== "workerpals" && shouldUseCodexCliFallback(backend, model, apiKey, requestedCodexAuthMode)) {
    backend = "openai_codex";
  }
  const normalizedEndpoint = backend === "ollama" ? normalizeOllamaEndpoint(endpoint ?? DEFAULT_OLLAMA_ENDPOINT) : normalizeLmStudioEndpoint(endpoint ?? (backend === "openai" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT));
  const sessionId = firstNonEmpty2(opts.sessionId, serviceLlmConfig.sessionId, config.sessionId, "default") ?? "default";
  return {
    backend,
    endpoint: normalizedEndpoint,
    model,
    apiKey,
    sessionId,
    reasoningEffort: firstNonEmpty2(opts.reasoningEffort, serviceLlmConfig.reasoningEffort, backend === "openai_codex" ? DEFAULT_CODEX_REASONING_EFFORT : "") ?? "",
    codexAuthMode: requestedCodexAuthMode,
    codexBin: firstNonEmpty2(opts.codexBin, serviceLlmConfig.codexBin, "") ?? "",
    codexTimeoutMs: opts.codexTimeoutMs ?? serviceLlmConfig.codexTimeoutMs,
    lmStudio: opts.lmStudio ?? config.llm.lmstudio
  };
}
function normalizeLmStudioEndpoint(endpoint) {
  const source = (endpoint.trim() || DEFAULT_LMSTUDIO_ENDPOINT).replace(/\/+$/, "");
  if (source.includes("/chat/completions"))
    return source;
  if (source.endsWith("/v1"))
    return `${source}/chat/completions`;
  return `${source}/v1/chat/completions`;
}
function normalizeOllamaEndpoint(endpoint) {
  const source = (endpoint.trim() || DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, "");
  if (source.endsWith("/api/chat"))
    return source;
  return `${source}/api/chat`;
}
function lmStudioHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}
function estimateTokensFromText(text) {
  return Math.ceil(text.length / 3);
}
function truncateKeepingStart(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  if (maxChars <= 12)
    return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 12)}
...[truncated]`;
}
function truncateKeepingEnd(text, maxChars) {
  if (text.length <= maxChars)
    return text;
  if (maxChars <= 12)
    return text.slice(text.length - maxChars);
  return `...[truncated]
${text.slice(text.length - (maxChars - 12))}`;
}
function sumEstimatedTokens(messages) {
  return messages.reduce((acc, msg) => acc + estimateTokensFromText(msg.content), 0);
}
function tokenUsageFromEstimate(messages, responseText) {
  return {
    promptTokens: Math.max(0, sumEstimatedTokens(messages)),
    completionTokens: Math.max(0, estimateTokensFromText(responseText))
  };
}
function normalizeTokenUsage(usage, fallback) {
  if (usage && Number.isFinite(usage.promptTokens) && usage.promptTokens >= 0 && Number.isFinite(usage.completionTokens) && usage.completionTokens >= 0) {
    return {
      promptTokens: Math.round(usage.promptTokens),
      completionTokens: Math.round(usage.completionTokens),
      estimated: false
    };
  }
  return {
    promptTokens: Math.round(fallback.promptTokens),
    completionTokens: Math.round(fallback.completionTokens),
    estimated: true
  };
}
function createHttpUsageReporter(opts) {
  const serverUrl = (opts.serverUrl ?? "").trim().replace(/\/+$/, "");
  if (!serverUrl)
    return null;
  const timeoutMs = Math.min(resolveLlmHttpTimeoutMs(opts.httpTimeoutMs, DEFAULT_LLM_HTTP_TIMEOUT_MS), DEFAULT_LLM_TELEMETRY_TIMEOUT_MS);
  return {
    async reportUsage(event) {
      const headers = { "Content-Type": "application/json" };
      const authToken = (opts.authToken ?? "").trim();
      if (authToken)
        headers.Authorization = `Bearer ${authToken}`;
      const response = await fetchLlmHttpResponse(`${serverUrl}/telemetry/llm-usage`, {
        method: "POST",
        headers,
        body: JSON.stringify(event)
      }, timeoutMs, "LLM usage telemetry request");
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`usage telemetry rejected (${response.status})${detail ? `: ${detail.trim()}` : ""}`);
      }
    }
  };
}
function providerlessModelName(raw) {
  const normalized = raw.trim();
  if (!normalized.includes("/"))
    return normalized;
  const [provider, rest] = normalized.split("/", 2);
  if (KNOWN_PROVIDER_PREFIXES.has(provider.trim().toLowerCase())) {
    return (rest ?? "").trim();
  }
  return normalized;
}
function isLikelyCodexModel(raw) {
  const normalized = providerlessModelName(raw).trim().toLowerCase();
  if (!normalized)
    return false;
  return normalized.includes("codex");
}
function shouldUseCodexCliFallback(backend, model, apiKey, configuredAuthMode) {
  if (backend !== "openai")
    return false;
  if (!isLikelyCodexModel(model))
    return false;
  const mode = codexConfiguredAuthMode(configuredAuthMode);
  if (mode === "api_key")
    return false;
  if (mode === "chatgpt")
    return true;
  return !apiKey.trim();
}
function uniqueNonEmptyStrings(values) {
  const out = [];
  const seen = new Set;
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed)
      continue;
    if (seen.has(trimmed))
      continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
function normalizeSessionTag(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
  const collapsed = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!collapsed)
    return "default";
  return collapsed.length <= 96 ? collapsed : collapsed.slice(0, 96);
}
function stableConversationTag(service, sessionId) {
  const source = firstNonEmpty2(sessionId, "default") ?? "default";
  return `pushpals-${service}-${normalizeSessionTag(source)}`;
}
function pickConfiguredOrAvailableModel(configuredModel, availableModels) {
  const configured = configuredModel.trim();
  if (availableModels.length > 0) {
    if (configured) {
      const configuredLower = configured.toLowerCase();
      const configuredBare = providerlessModelName(configured).toLowerCase();
      const matched = availableModels.find((candidate) => {
        const lower = candidate.toLowerCase();
        return lower === configuredLower || providerlessModelName(candidate).toLowerCase() === configuredBare;
      });
      if (matched)
        return { model: matched, source: "configured" };
      return { model: availableModels[0], source: "available_fallback" };
    }
    return { model: availableModels[0], source: "available_default" };
  }
  if (configured)
    return { model: configured, source: "configured_unverified" };
  return { model: DEFAULT_MODEL, source: "default_local_model" };
}
function chunkByCharBudget(text, charBudget) {
  if (!text)
    return [];
  const safeBudget = Math.max(256, charBudget);
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + safeBudget);
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}
function serializeMessagesForBatch(messages) {
  return messages.map((message, index) => `[#${index + 1}] role=${message.role}
<<<BEGIN_CONTENT>>>
${message.content}
<<<END_CONTENT>>>`).join(`

====

`);
}
function trimLmStudioMessagesToBudget(system, inputMessages, promptTokenBudget, systemTokenBudget) {
  let trimmed = false;
  let latestUserOverflow = false;
  let remainingPromptTokens = promptTokenBudget;
  let systemContent = system;
  if (estimateTokensFromText(systemContent) > systemTokenBudget) {
    systemContent = truncateKeepingStart(systemContent, systemTokenBudget * 3);
    trimmed = true;
  }
  remainingPromptTokens = Math.max(64, promptTokenBudget - estimateTokensFromText(systemContent));
  const selectedMessages = [];
  const lastUserIndex = (() => {
    for (let i = inputMessages.length - 1;i >= 0; i--) {
      if (inputMessages[i]?.role === "user")
        return i;
    }
    return -1;
  })();
  for (let i = inputMessages.length - 1;i >= 0; i--) {
    const source = inputMessages[i];
    let content = source.content ?? "";
    const estimated = estimateTokensFromText(content);
    if (estimated <= remainingPromptTokens) {
      selectedMessages.push({ role: source.role, content });
      remainingPromptTokens -= estimated;
      continue;
    }
    if (i === lastUserIndex) {
      selectedMessages.push({ role: source.role, content });
      latestUserOverflow = true;
      break;
    }
    const charBudget = Math.max(192, remainingPromptTokens * 3);
    content = truncateKeepingEnd(content, charBudget);
    selectedMessages.push({ role: source.role, content });
    trimmed = true;
    break;
  }
  const messages = [
    { role: "system", content: systemContent },
    ...selectedMessages.reverse()
  ];
  const promptTokensEstimate = sumEstimatedTokens(messages);
  return { messages, promptTokensEstimate, trimmed, latestUserOverflow };
}

class LmStudioClient {
  endpoint;
  apiKey;
  model;
  service;
  sessionTag;
  providerKind;
  providerLabel;
  usageReporter;
  contextWindow;
  minOutputTokens;
  tokenSafetyMargin;
  batchTailMessages;
  batchChunkTokens;
  batchMemoryChars;
  httpTimeoutMs;
  resolvedModel = null;
  resolveModelPromise = null;
  lmStudioSupportsExtendedSessionFields = null;
  lmStudioSupportsResponseFormat = null;
  constructor(opts) {
    this.providerKind = opts?.backend ?? "lmstudio";
    this.providerLabel = this.providerKind === "openai" ? "OpenAI" : "LM Studio";
    const defaultEndpoint = this.providerKind === "openai" ? DEFAULT_OPENAI_ENDPOINT : DEFAULT_LMSTUDIO_ENDPOINT;
    const rawEndpoint = opts?.endpoint ?? defaultEndpoint;
    this.endpoint = normalizeLmStudioEndpoint(rawEndpoint);
    this.apiKey = opts?.apiKey ?? (this.providerKind === "lmstudio" ? "lmstudio" : "");
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.usageReporter = opts?.usageReporter ?? null;
    const lmStudio = opts?.lmStudio;
    this.contextWindow = Math.max(512, lmStudio?.contextWindow ?? DEFAULT_LMSTUDIO_CONTEXT_WINDOW);
    this.minOutputTokens = Math.max(64, lmStudio?.minOutputTokens ?? DEFAULT_LMSTUDIO_MIN_OUTPUT_TOKENS);
    this.tokenSafetyMargin = Math.max(16, lmStudio?.tokenSafetyMargin ?? DEFAULT_LMSTUDIO_TOKEN_SAFETY_MARGIN);
    this.batchTailMessages = Math.max(1, lmStudio?.batchTailMessages ?? DEFAULT_LMSTUDIO_BATCH_TAIL_MESSAGES);
    this.batchChunkTokens = Math.max(0, lmStudio?.batchChunkTokens ?? 0);
    this.batchMemoryChars = Math.max(0, lmStudio?.batchMemoryChars ?? 0);
    this.httpTimeoutMs = resolveLlmHttpTimeoutMs(opts?.httpTimeoutMs, DEFAULT_LLM_HTTP_TIMEOUT_MS);
  }
  async maybeReportUsage(modelId, usage) {
    if (!this.usageReporter)
      return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: this.providerKind,
        modelId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }
  modelProbeUrls() {
    const trimmed = this.endpoint.replace(/\/+$/, "");
    if (this.providerKind === "openai") {
      if (trimmed.endsWith("/v1/chat/completions")) {
        const root = trimmed.slice(0, -"/v1/chat/completions".length);
        return uniqueNonEmptyStrings([`${root}/v1/models`]);
      }
      if (trimmed.endsWith("/chat/completions")) {
        const root = trimmed.slice(0, -"/chat/completions".length);
        if (root.endsWith("/v1")) {
          return uniqueNonEmptyStrings([`${root}/models`]);
        }
        return uniqueNonEmptyStrings([`${root}/v1/models`]);
      }
      return uniqueNonEmptyStrings([`${trimmed}/v1/models`]);
    }
    if (trimmed.endsWith("/v1/chat/completions")) {
      const root = trimmed.slice(0, -"/v1/chat/completions".length);
      return uniqueNonEmptyStrings([`${root}/v1/models`, `${root}/models`]);
    }
    if (trimmed.endsWith("/chat/completions")) {
      const root = trimmed.slice(0, -"/chat/completions".length);
      if (root.endsWith("/v1")) {
        const parent = root.slice(0, -"/v1".length).replace(/\/+$/, "");
        return uniqueNonEmptyStrings([`${root}/models`, `${parent}/models`]);
      }
      return uniqueNonEmptyStrings([`${root}/v1/models`, `${root}/models`]);
    }
    if (trimmed.endsWith("/v1")) {
      const parent = trimmed.slice(0, -"/v1".length).replace(/\/+$/, "");
      return uniqueNonEmptyStrings([`${trimmed}/models`, `${parent}/models`]);
    }
    return uniqueNonEmptyStrings([`${trimmed}/v1/models`, `${trimmed}/models`]);
  }
  async discoverAvailableModels() {
    const probes = this.modelProbeUrls();
    const headers = { Accept: "application/json" };
    if (this.apiKey.trim()) {
      headers.Authorization = `Bearer ${this.apiKey.trim()}`;
    }
    let lastDetail = "model-list probe failed";
    const timeoutMs = Math.min(this.httpTimeoutMs, DEFAULT_LLM_MODEL_PROBE_TIMEOUT_MS);
    for (const url of probes) {
      try {
        const res = await fetchLlmHttpResponse(url, { method: "GET", headers }, timeoutMs, `${this.providerLabel} model-list probe`);
        if (!res.ok) {
          const body = await res.text();
          const hint = body.trim().slice(0, 120);
          lastDetail = `${url} -> HTTP ${res.status}${hint ? ` (${hint})` : ""}`;
          continue;
        }
        const payload = await res.json();
        const models = Array.isArray(payload?.data) ? payload.data.map((item) => typeof item?.id === "string" ? item.id.trim() : "").filter((id) => id.length > 0) : [];
        if (models.length > 0) {
          return { models: uniqueNonEmptyStrings(models), detail: `${url} -> ${res.status}` };
        }
        lastDetail = `${url} -> no models in payload`;
      } catch (err) {
        lastDetail = `${url}: ${String(err)}`;
      }
    }
    return { models: [], detail: lastDetail };
  }
  async resolveModelForRequest() {
    if (this.resolvedModel)
      return this.resolvedModel;
    if (this.resolveModelPromise)
      return this.resolveModelPromise;
    this.resolveModelPromise = (async () => {
      const configuredModel = this.model.trim();
      const discovered = await this.discoverAvailableModels();
      const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
      if (selected.source === "available_fallback") {
        console.warn(`[LLM] Configured model "${configuredModel || "(empty)"}" not present in ${this.providerLabel} model list; using discovered fallback "${selected.model}".`);
      } else if (selected.source === "available_default") {
        console.warn(`[LLM] No model configured; using discovered ${this.providerLabel} model "${selected.model}".`);
      } else if (selected.source === "default_local_model") {
        console.warn(`[LLM] No configured/discovered ${this.providerLabel} model available; falling back to default "${DEFAULT_MODEL}".`);
      } else if (selected.source === "configured_unverified") {
        console.warn(`[LLM] Could not verify configured model "${configuredModel}" via model list (${discovered.detail}); continuing with configured model.`);
      }
      console.log(`[LLM] ${this.providerLabel} resolved model "${selected.model}" (${selected.source}).`);
      return selected.model;
    })();
    try {
      this.resolvedModel = await this.resolveModelPromise;
      return this.resolvedModel;
    } finally {
      this.resolveModelPromise = null;
    }
  }
  async preflightConfiguredModel() {
    const discovered = await this.discoverAvailableModels();
    if (discovered.models.length === 0) {
      throw new Error(`${this.providerLabel} model preflight failed for ${this.endpoint}: ${discovered.detail}`);
    }
    const configuredModel = this.model.trim();
    if (!configuredModel)
      return;
    const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
    if (selected.source !== "configured") {
      const sample = discovered.models.slice(0, 12).join(", ");
      throw new Error(`Configured ${this.providerLabel} model "${configuredModel}" is unavailable at ${this.endpoint}. Available models: ${sample || "(none)"}`);
    }
  }
  async runLmStudioCompletion(messages, opts) {
    const model = await this.resolveModelForRequest();
    const coreBody = {
      model,
      messages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature
    };
    const sessionAwareBodyBases = this.sessionTag ? [
      ...this.lmStudioSupportsExtendedSessionFields !== false ? [
        {
          ...coreBody,
          user: this.sessionTag,
          session_id: this.sessionTag,
          conversation_id: this.sessionTag
        }
      ] : [],
      {
        ...coreBody,
        user: this.sessionTag
      },
      {
        ...coreBody
      }
    ] : [coreBody];
    const bodyVariants = [];
    for (const baseBody of sessionAwareBodyBases) {
      if (!opts.json) {
        bodyVariants.push(baseBody);
        continue;
      }
      if (this.lmStudioSupportsResponseFormat === false) {
        bodyVariants.push(baseBody);
        continue;
      }
      if (opts.jsonSchema) {
        bodyVariants.push({
          ...baseBody,
          response_format: {
            type: "json_schema",
            json_schema: opts.jsonSchema
          }
        });
      } else {
        bodyVariants.push({
          ...baseBody,
          response_format: { type: "json_object" }
        });
      }
      bodyVariants.push({
        ...baseBody,
        response_format: { type: "text" }
      });
    }
    let lastStatus = 0;
    let lastError = "unknown error";
    let loggedSessionFallback = false;
    let loggedResponseFormatFallback = false;
    for (let i = 0;i < bodyVariants.length; i++) {
      const body = bodyVariants[i];
      const headers = {
        ...lmStudioHeaders(this.apiKey)
      };
      if (this.sessionTag) {
        headers["X-PushPals-Session-Id"] = this.sessionTag;
        headers["X-Session-Id"] = this.sessionTag;
        headers["X-Conversation-Id"] = this.sessionTag;
      }
      const res = await fetchLlmHttpResponse(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }, this.httpTimeoutMs, `${this.providerLabel} completion request`);
      if (!res.ok) {
        lastStatus = res.status;
        lastError = await res.text();
        const hasFallback = i < bodyVariants.length - 1;
        if (hasFallback && res.status === 400) {
          const lowered = lastError.toLowerCase();
          const sessionFieldRejected = lowered.includes("session_id") || lowered.includes("conversation_id") || lowered.includes("unknown field") || lowered.includes("unknown property") || lowered.includes("additional properties");
          const responseFormatRejected = lowered.includes("response_format");
          if (sessionFieldRejected && !loggedSessionFallback) {
            this.lmStudioSupportsExtendedSessionFields = false;
            loggedSessionFallback = true;
            console.warn(`[LLM] ${this.providerLabel} rejected session hint fields, retrying compatibility payload (${lastStatus}).`);
          } else if (responseFormatRejected && !loggedResponseFormatFallback) {
            this.lmStudioSupportsResponseFormat = false;
            loggedResponseFormatFallback = true;
            console.warn(`[LLM] ${this.providerLabel} rejected response_format payload, retrying with fallback (${lastStatus}).`);
          }
          continue;
        }
        throw new Error(`${this.providerLabel} API error ${res.status}: ${lastError}`);
      }
      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? "";
      if ("session_id" in body || "conversation_id" in body) {
        this.lmStudioSupportsExtendedSessionFields = true;
      }
      if ("response_format" in body) {
        this.lmStudioSupportsResponseFormat = true;
      }
      const usage = normalizeTokenUsage(data.usage ? {
        promptTokens: Number(data.usage.prompt_tokens ?? 0),
        completionTokens: Number(data.usage.completion_tokens ?? 0)
      } : undefined, tokenUsageFromEstimate(messages, text));
      await this.maybeReportUsage(model, usage);
      return {
        text,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens
        }
      };
    }
    throw new Error(`${this.providerLabel} API error ${lastStatus}: ${lastError}`);
  }
  async packContextInBatches(fullMessages, promptTokenBudget) {
    const tailCount = this.batchTailMessages;
    const tailMessages = fullMessages.slice(-tailCount);
    const reservedTailTokens = sumEstimatedTokens(tailMessages) + 220;
    const adaptiveMemoryTokenBudget = Math.max(256, Math.min(Math.floor(promptTokenBudget * 0.6), promptTokenBudget - reservedTailTokens));
    const chunkTokenBudget = this.batchChunkTokens > 0 ? this.batchChunkTokens : Math.max(256, Math.floor(promptTokenBudget * 0.55));
    const chunkCharBudget = chunkTokenBudget * 3;
    const memoryCharBudget = this.batchMemoryChars > 0 ? this.batchMemoryChars : Math.max(900, adaptiveMemoryTokenBudget * 3);
    const packMaxTokens = Math.max(128, Math.min(1024, Math.floor(this.contextWindow * 0.25)));
    const serialized = serializeMessagesForBatch(fullMessages);
    const chunks = chunkByCharBudget(serialized, chunkCharBudget);
    if (chunks.length <= 1) {
      return { messages: fullMessages, chunkCount: chunks.length };
    }
    let memory = "";
    for (let i = 0;i < chunks.length; i++) {
      const chunk = chunks[i];
      const packPrompt = loadPromptTemplate("remotebuddy/context_packer_user_prompt.md", {
        batch_index: String(i + 1),
        batch_count: String(chunks.length),
        batch_chunk: chunk,
        current_memory: memory || "(empty)",
        memory_char_budget: String(memoryCharBudget)
      });
      const packed = await this.runLmStudioCompletion([
        {
          role: "system",
          content: CONTEXT_PACKER_SYSTEM_PROMPT
        },
        { role: "user", content: packPrompt }
      ], { json: false, maxTokens: packMaxTokens, temperature: 0 });
      memory = packed.text.trim() || memory;
    }
    const packedMessages = [
      {
        role: "system",
        content: CONTEXT_PACKER_CONDENSED_HISTORY_SYSTEM_PROMPT
      },
      {
        role: "system",
        content: `PACKED_CONTEXT
${memory}`
      },
      ...tailMessages
    ];
    return { messages: packedMessages, chunkCount: chunks.length };
  }
  async generate(input) {
    const contextWindow = this.contextWindow;
    const minOutputTokens = this.minOutputTokens;
    const desiredMaxTokens = input.maxTokens ?? 2048;
    const clampedMinOutput = Math.max(64, Math.min(minOutputTokens, Math.floor(contextWindow / 2)));
    const promptTokenBudget = Math.max(384, contextWindow - clampedMinOutput - this.tokenSafetyMargin);
    const systemTokenBudget = Math.max(128, Math.min(Math.floor(promptTokenBudget * 0.45), promptTokenBudget - 128));
    const fullMessages = [
      { role: "system", content: input.system },
      ...input.messages.map((message) => ({ role: message.role, content: message.content ?? "" }))
    ];
    let messages = fullMessages;
    let promptTokensEstimate = sumEstimatedTokens(messages);
    let trimmed = false;
    let packedChunkCount = 0;
    let latestUserOverflow = false;
    if (promptTokensEstimate > promptTokenBudget) {
      try {
        const packed = await this.packContextInBatches(fullMessages, promptTokenBudget);
        messages = packed.messages;
        packedChunkCount = packed.chunkCount;
        promptTokensEstimate = sumEstimatedTokens(messages);
        if (promptTokensEstimate > promptTokenBudget && messages.length > 0) {
          const packedSystem = messages[0]?.content ?? "";
          const packedInput = messages.slice(1).map((message) => ({
            role: message.role,
            content: message.content
          }));
          const packedTrimmed = trimLmStudioMessagesToBudget(packedSystem, packedInput, promptTokenBudget, systemTokenBudget);
          messages = packedTrimmed.messages;
          promptTokensEstimate = packedTrimmed.promptTokensEstimate;
          trimmed = trimmed || packedTrimmed.trimmed;
          latestUserOverflow = latestUserOverflow || packedTrimmed.latestUserOverflow;
        }
      } catch (err) {
        throw new Error(`${this.providerLabel} batch context packing failed: ${String(err)}`);
      }
    }
    if (latestUserOverflow) {
      throw new Error(`Latest user request exceeds ${this.providerLabel} context window and cannot be safely truncated. Increase model context window or split the request into smaller messages.`);
    }
    const safeMaxTokens = Math.max(64, Math.min(desiredMaxTokens, contextWindow - promptTokensEstimate - this.tokenSafetyMargin));
    if (packedChunkCount > 1) {
      console.warn(`[LLM] Packed oversized prompt context across ${packedChunkCount} batches (window ~${contextWindow}, est prompt ${promptTokensEstimate}).`);
    } else if (trimmed) {
      console.warn(`[LLM] Trimmed ${this.providerLabel} prompt context to fit window (~${contextWindow} tokens, est prompt ${promptTokensEstimate}).`);
    }
    return this.runLmStudioCompletion(messages, {
      json: input.json,
      jsonSchema: input.jsonSchema,
      maxTokens: safeMaxTokens,
      temperature: input.temperature ?? 0.3
    });
  }
}
function renderCodexPrompt(input) {
  const jsonRequirements = input.json ? loadPromptTemplate("remotebuddy/codex_adapter_json_requirements.md").trim() : "";
  const jsonSchemaBlock = input.jsonSchema ? `${loadPromptTemplate("remotebuddy/codex_adapter_json_schema_intro.md").trim()}
${JSON.stringify(input.jsonSchema, null, 2)}` : "";
  const maxTokensLine = typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? loadPromptTemplate("remotebuddy/codex_adapter_max_tokens_line.md", {
    max_tokens: String(Math.max(64, Math.floor(input.maxTokens)))
  }).trim() : "";
  const conversationTranscript = input.messages.map((message) => `[${message.role}]
${message.content ?? ""}
`).join(`
`);
  return loadPromptTemplate("remotebuddy/codex_adapter_prompt_template.md", {
    json_requirements: jsonRequirements,
    json_schema_block: jsonSchemaBlock,
    max_tokens_line: maxTokensLine,
    system_instruction: input.system,
    conversation_transcript: conversationTranscript
  });
}

class OpenAiCodexCliClient {
  model;
  apiKey;
  endpoint;
  codexAuthMode;
  codexBin;
  codexTimeoutMs;
  service;
  sessionTag;
  reasoningEffort;
  usageReporter;
  constructor(opts) {
    this.model = normalizeCodexModel(opts?.model ?? DEFAULT_CODEX_MODEL);
    this.apiKey = (opts?.apiKey ?? "").trim();
    this.endpoint = normalizeOpenAiBaseFromEndpoint(opts?.endpoint ?? DEFAULT_OPENAI_ENDPOINT);
    this.codexAuthMode = (opts?.codexAuthMode ?? "").trim();
    this.codexBin = (opts?.codexBin ?? "").trim();
    this.codexTimeoutMs = opts?.codexTimeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.reasoningEffort = (opts?.reasoningEffort ?? "").trim();
    this.usageReporter = opts?.usageReporter ?? null;
  }
  async maybeReportUsage(usage) {
    if (!this.usageReporter)
      return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: "openai_codex",
        modelId: usage.modelId ?? this.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }
  effectiveAuthMode() {
    const configured = codexConfiguredAuthMode(this.codexAuthMode);
    if (configured !== "auto")
      return configured;
    const envKey = (process.env.OPENAI_API_KEY ?? "").trim();
    return this.apiKey || envKey ? "api_key" : "chatgpt";
  }
  async ensureChatGptLoginReady(commandPrefix, env) {
    const status = await runProcess([...commandPrefix, "login", "status"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 25000
    });
    if (status.code === 0)
      return;
    const detail = (status.stderr || status.stdout || "").trim();
    throw new Error(`Codex CLI is not logged in for ChatGPT auth mode. Run \`bunx --yes @openai/codex login\` (or \`codex login\`) and retry.${detail ? ` Details: ${detail}` : ""}`);
  }
  async preflight() {
    const authMode = this.effectiveAuthMode();
    if (authMode === "api_key") {
      const finalApiKey = this.apiKey || (process.env.OPENAI_API_KEY ?? "").trim();
      if (!finalApiKey) {
        throw new Error("openai_codex API-key auth requires OPENAI_API_KEY (or service llm.api_key), but none is configured.");
      }
    }
    const commandPrefix = await resolveCodexCommandPrefix(this.codexBin);
    const env = { ...process.env };
    env.PYTHONIOENCODING = "utf-8";
    if (authMode === "chatgpt") {
      delete env.OPENAI_API_KEY;
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_BASE;
      await this.ensureChatGptLoginReady(commandPrefix, env);
    }
  }
  async runCodexExec(prompt) {
    return this.runCodexExecAttempt(prompt, {
      model: this.model,
      modelCompatibilityRecoveryAttempt: 0
    });
  }
  async runCodexExecAttempt(prompt, opts) {
    const model = normalizeCodexModel(opts.model);
    const commandPrefix = await resolveCodexCommandPrefix(this.codexBin);
    const env = { ...process.env };
    env.PYTHONIOENCODING = "utf-8";
    env.PUSHPALS_LLM_SERVICE = this.service;
    env.PUSHPALS_LLM_SESSION_TAG = this.sessionTag;
    const authMode = this.effectiveAuthMode();
    if (authMode === "chatgpt") {
      delete env.OPENAI_API_KEY;
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_BASE;
      await this.ensureChatGptLoginReady(commandPrefix, env);
    } else {
      const finalApiKey = this.apiKey || (process.env.OPENAI_API_KEY ?? "").trim();
      if (!finalApiKey) {
        throw new Error("openai_codex API-key auth requires OPENAI_API_KEY (or service llm.api_key), but none is configured.");
      }
      env.OPENAI_API_KEY = finalApiKey;
      const baseOverride = codexBaseUrlOverride();
      const baseUrl = baseOverride || this.endpoint;
      if (baseUrl) {
        env.OPENAI_BASE_URL = baseUrl;
        env.OPENAI_API_BASE = baseUrl;
      } else {
        delete env.OPENAI_BASE_URL;
        delete env.OPENAI_API_BASE;
      }
    }
    const tmp = mkdtempSync(join3(tmpdir(), "pushpals-codex-"));
    const lastMessagePath = join3(tmp, "codex-last-message.txt");
    try {
      const command = [
        ...commandPrefix,
        "-c",
        `model_reasoning_effort="${codexReasoningEffort(this.reasoningEffort, model)}"`,
        "-a",
        "never",
        "-s",
        "read-only",
        "exec",
        "--color",
        "never",
        "--output-last-message",
        lastMessagePath
      ];
      if (model) {
        command.push("-m", model);
      }
      command.push("-");
      const result = await runProcess(command, {
        cwd: process.cwd(),
        env,
        stdin: prompt,
        timeoutMs: codexTimeoutMs(this.codexTimeoutMs)
      });
      if (result.timedOut) {
        throw new Error(`Codex CLI request timed out after ${codexTimeoutMs(this.codexTimeoutMs)}ms.`);
      }
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      const lastMessage = existsSync3(lastMessagePath) ? readFileSync4(lastMessagePath, "utf8").trim() : "";
      if (result.code !== 0) {
        const detail = stderr || stdout || "codex exec exited with non-zero status";
        if (opts.modelCompatibilityRecoveryAttempt < 1 && isDefaultCodexModel(model) && LEGACY_CODEX_MODEL_FALLBACK.trim().toLowerCase() !== DEFAULT_CODEX_MODEL.toLowerCase() && requiresNewerCodexForModel(stdout, stderr)) {
          console.warn(`[LLM] Codex CLI rejected default model ${DEFAULT_CODEX_MODEL}; retrying once with ${LEGACY_CODEX_MODEL_FALLBACK}. Upgrade Codex CLI to use ${DEFAULT_CODEX_MODEL}.`);
          return this.runCodexExecAttempt(prompt, {
            model: LEGACY_CODEX_MODEL_FALLBACK,
            modelCompatibilityRecoveryAttempt: opts.modelCompatibilityRecoveryAttempt + 1
          });
        }
        throw new Error(`Codex CLI request failed (exit ${result.code ?? "unknown"}): ${detail}`);
      }
      const text = lastMessage || stdout;
      if (!text) {
        throw new Error("Codex CLI completed without producing a response.");
      }
      return { text, stderr, model };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  async generate(input) {
    const prompt = renderCodexPrompt(input);
    const result = await this.runCodexExec(prompt);
    if (result.stderr) {
      const firstLine = result.stderr.split(/\r?\n/).find((line) => line.trim().length > 0);
      if (firstLine) {
        console.warn(`[LLM] Codex CLI stderr (${this.service}): ${firstLine.trim()}`);
      }
    }
    const usage = normalizeTokenUsage(undefined, {
      promptTokens: estimateTokensFromText(prompt),
      completionTokens: estimateTokensFromText(result.text)
    });
    await this.maybeReportUsage({ ...usage, modelId: result.model });
    return {
      text: result.text,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens
      }
    };
  }
}

class OllamaClient {
  endpoint;
  model;
  service;
  sessionTag;
  usageReporter;
  httpTimeoutMs;
  constructor(opts) {
    const rawEndpoint = opts?.endpoint ?? DEFAULT_OLLAMA_ENDPOINT;
    this.endpoint = normalizeOllamaEndpoint(rawEndpoint);
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.service = opts?.service ?? "remotebuddy";
    this.sessionTag = stableConversationTag(this.service, opts?.sessionId);
    this.usageReporter = opts?.usageReporter ?? null;
    this.httpTimeoutMs = resolveLlmHttpTimeoutMs(opts?.httpTimeoutMs, DEFAULT_LLM_HTTP_TIMEOUT_MS);
  }
  async maybeReportUsage(usage) {
    if (!this.usageReporter)
      return;
    try {
      await this.usageReporter.reportUsage({
        service: this.service,
        sessionId: this.sessionTag || undefined,
        backend: "ollama",
        modelId: this.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
        estimated: usage.estimated
      });
    } catch (err) {
      console.warn(`[LLM] Usage telemetry failed (${this.service}): ${String(err)}`);
    }
  }
  async discoverAvailableModels() {
    const base = this.endpoint.replace(/\/api\/chat$/, "");
    const probes = uniqueNonEmptyStrings([`${base}/api/tags`, this.endpoint]);
    let lastDetail = "model-list probe failed";
    const timeoutMs = Math.min(this.httpTimeoutMs, DEFAULT_LLM_MODEL_PROBE_TIMEOUT_MS);
    for (const url of probes) {
      try {
        const res = await fetchLlmHttpResponse(url, { method: "GET", headers: { Accept: "application/json" } }, timeoutMs, "Ollama model-list probe");
        if (!res.ok) {
          const body = await res.text();
          const hint = body.trim().slice(0, 120);
          lastDetail = `${url} -> HTTP ${res.status}${hint ? ` (${hint})` : ""}`;
          continue;
        }
        const payload = await res.json();
        const models = Array.isArray(payload.models) ? payload.models.map((item) => typeof item?.name === "string" ? item.name.trim() : "").filter((name) => name.length > 0) : [];
        if (models.length > 0) {
          return { models: uniqueNonEmptyStrings(models), detail: `${url} -> ${res.status}` };
        }
        lastDetail = `${url} -> no models in payload`;
      } catch (err) {
        lastDetail = `${url}: ${String(err)}`;
      }
    }
    return { models: [], detail: lastDetail };
  }
  async preflightConfiguredModel() {
    const discovered = await this.discoverAvailableModels();
    if (discovered.models.length === 0) {
      throw new Error(`Ollama model preflight failed for ${this.endpoint}: ${discovered.detail}`);
    }
    const configuredModel = this.model.trim();
    if (!configuredModel)
      return;
    const selected = pickConfiguredOrAvailableModel(configuredModel, discovered.models);
    if (selected.source !== "configured") {
      const sample = discovered.models.slice(0, 12).join(", ");
      throw new Error(`Configured Ollama model "${configuredModel}" is unavailable at ${this.endpoint}. Available models: ${sample || "(none)"}`);
    }
  }
  async generate(input) {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        ...input.messages.map((m) => ({ role: m.role, content: m.content }))
      ],
      stream: false,
      options: {
        temperature: input.temperature ?? 0.3
      }
    };
    if (typeof input.maxTokens === "number") {
      body.options.num_predict = input.maxTokens;
    }
    if (input.json) {
      body.format = "json";
    }
    const res = await fetchLlmHttpResponse(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, this.httpTimeoutMs, "Ollama completion request");
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${err}`);
    }
    const data = await res.json();
    const text = data.message?.content ?? "";
    const usage = normalizeTokenUsage(undefined, tokenUsageFromEstimate(body.messages, text));
    await this.maybeReportUsage(usage);
    return {
      text,
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens
      }
    };
  }
}
function createLLMClient(opts = {}) {
  const resolved = resolveServiceLlmConfig(opts);
  const service = opts.service ?? "remotebuddy";
  const usageReporter = opts.usageReporter ?? createHttpUsageReporter(opts);
  if (resolved.backend === "openai_codex") {
    console.log(`[LLM] Using OpenAI Codex CLI backend (model: ${resolved.model}, auth_mode: ${codexConfiguredAuthMode(resolved.codexAuthMode)}).`);
    return new OpenAiCodexCliClient({
      model: resolved.model,
      apiKey: resolved.apiKey,
      endpoint: resolved.endpoint,
      codexAuthMode: resolved.codexAuthMode,
      codexBin: resolved.codexBin,
      codexTimeoutMs: resolved.codexTimeoutMs,
      reasoningEffort: resolved.reasoningEffort,
      service,
      sessionId: resolved.sessionId,
      usageReporter
    });
  }
  if (resolved.backend === "ollama") {
    console.log(`[LLM] Using Ollama backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`);
    return new OllamaClient({
      endpoint: resolved.endpoint,
      model: resolved.model,
      service,
      sessionId: resolved.sessionId,
      usageReporter,
      httpTimeoutMs: opts.httpTimeoutMs
    });
  }
  if (resolved.backend === "openai") {
    console.log(`[LLM] Using OpenAI backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`);
    return new LmStudioClient({
      endpoint: resolved.endpoint,
      apiKey: resolved.apiKey,
      model: resolved.model,
      backend: "openai",
      service,
      sessionId: resolved.sessionId,
      lmStudio: resolved.lmStudio,
      usageReporter,
      httpTimeoutMs: opts.httpTimeoutMs
    });
  }
  console.log(`[LLM] Using LM Studio backend (model: ${resolved.model}, endpoint: ${resolved.endpoint})`);
  return new LmStudioClient({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    model: resolved.model,
    backend: "lmstudio",
    service,
    sessionId: resolved.sessionId,
    lmStudio: resolved.lmStudio,
    usageReporter,
    httpTimeoutMs: opts.httpTimeoutMs
  });
}
async function preflightServiceLlm(opts = {}) {
  const resolved = resolveServiceLlmConfig(opts);
  const service = opts.service ?? "remotebuddy";
  if (resolved.backend === "openai_codex") {
    const client2 = new OpenAiCodexCliClient({
      model: resolved.model,
      apiKey: resolved.apiKey,
      endpoint: resolved.endpoint,
      codexAuthMode: resolved.codexAuthMode,
      codexBin: resolved.codexBin,
      codexTimeoutMs: resolved.codexTimeoutMs,
      reasoningEffort: resolved.reasoningEffort,
      service,
      sessionId: resolved.sessionId,
      usageReporter: null
    });
    await client2.preflight();
    return;
  }
  if (resolved.backend === "ollama") {
    const client2 = new OllamaClient({
      endpoint: resolved.endpoint,
      model: resolved.model,
      service,
      sessionId: resolved.sessionId,
      usageReporter: null,
      httpTimeoutMs: opts.httpTimeoutMs
    });
    await client2.preflightConfiguredModel();
    return;
  }
  const client = new LmStudioClient({
    endpoint: resolved.endpoint,
    apiKey: resolved.apiKey,
    model: resolved.model,
    backend: resolved.backend === "openai" ? "openai" : "lmstudio",
    service,
    sessionId: resolved.sessionId,
    lmStudio: resolved.lmStudio,
    usageReporter: null,
    httpTimeoutMs: opts.httpTimeoutMs
  });
  await client.preflightConfiguredModel();
}

// apps/localbuddy/src/request_status.ts
function tryParseJsonObject(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed)
    return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return null;
}
function extractReferencedRequestToken(input) {
  const text = String(input ?? "").trim();
  if (!text)
    return null;
  const fullId = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (fullId)
    return fullId[0].toLowerCase();
  const contextualShort = text.match(/\b(?:request|req|job)(?:\s+id)?\s*(?:is|=|:)?\s*([0-9a-f]{8})\b/i);
  if (contextualShort)
    return contextualShort[1].toLowerCase();
  const bareShort = text.match(/\b[0-9a-f]{8}\b/i);
  if (bareShort && /\b(request|req|job|status|progress|update|check|doing|queue|queued)\b/i.test(text)) {
    return bareShort[0].toLowerCase();
  }
  return null;
}
function extractReferencedJobToken(input) {
  const text = String(input ?? "").trim();
  if (!text)
    return null;
  const contextualFull = text.match(/\b(?:job|workerpal\s+job|task)(?:\s+id)?\s*(?:is|=|:)?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (contextualFull)
    return contextualFull[1].toLowerCase();
  const contextualShort = text.match(/\b(?:job|workerpal\s+job|task)(?:\s+id)?\s*(?:is|=|:)?\s*([0-9a-f]{8})\b/i);
  if (contextualShort)
    return contextualShort[1].toLowerCase();
  return null;
}
function isJobStatusPrompt(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text)
    return false;
  if (extractReferencedJobToken(text))
    return true;
  const hasEntity = /\b(job|workerpal|task)\b/.test(text);
  const hasStatusCue = /\b(status|progress|update|check|checking|doing|where|queued|claimed|running|in progress|complete|completed|failed|stuck)\b/.test(text);
  return hasEntity && hasStatusCue;
}
function isStatusLookupPrompt(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text)
    return false;
  if (extractReferencedRequestToken(text))
    return true;
  const hasEntity = /\b(request|job|workerpal|task)\b/.test(text);
  const hasStatusCue = /\b(status|progress|update|check|checking|doing|where|queue|queued|claimed|running|complete|completed|failed|stuck|happened|happen|why|terminated|termination|killed|outcome|result)\b/.test(text);
  if (hasEntity && hasStatusCue)
    return true;
  return /\b(how(?:'s| is)?\s+my\s+status|what(?:'s| is)\s+my\s+status)\b/.test(text);
}
function formatClockTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms))
    return "unknown";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0)
    return "";
  const ms = Math.floor(durationMs);
  if (ms < 1000)
    return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0)
    return `${totalSeconds}s`;
  return `${minutes}m ${seconds}s`;
}
function parseExecutionBudgetMs(job) {
  if (Number.isFinite(job.executionBudgetMs) && job.executionBudgetMs > 0) {
    return Number(job.executionBudgetMs);
  }
  const parsed = tryParseJsonObject(job.params);
  const planning = parsed?.planning;
  if (!planning || typeof planning !== "object" || Array.isArray(planning))
    return null;
  const value = planning.executionBudgetMs;
  if (!Number.isFinite(value) || value <= 0)
    return null;
  return Number(value);
}
function startedIsoForJob(job) {
  return job.startedAt ?? job.claimedAt ?? job.enqueuedAt ?? job.createdAt ?? null;
}
function parseStructuredError(raw, summarizeFailure) {
  if (!raw)
    return "";
  const parsed = tryParseJsonObject(raw);
  if (parsed) {
    const message = typeof parsed.message === "string" ? parsed.message : "";
    const detail = typeof parsed.detail === "string" ? parsed.detail : "";
    const combined = [message, detail].filter(Boolean).join(" | ");
    if (combined)
      return summarizeFailure(combined);
  }
  return summarizeFailure(raw);
}
function extractJobRequestId(job) {
  const parsed = tryParseJsonObject(job.params);
  if (!parsed)
    return null;
  const requestId = parsed.requestId;
  if (typeof requestId !== "string")
    return null;
  const normalized = requestId.trim();
  return normalized || null;
}
function selectRelevantJobForPrompt(args) {
  const requestedToken = extractReferencedJobToken(args.userPrompt);
  const isJobQuery = isJobStatusPrompt(args.userPrompt);
  const jobs = (args.jobs ?? []).filter((row) => row.sessionId === args.sessionId);
  if (!isJobQuery) {
    return { isJobQuery: false, requestedToken, selectedJob: null };
  }
  if (jobs.length === 0) {
    return { isJobQuery: true, requestedToken, selectedJob: null };
  }
  if (requestedToken) {
    const token = requestedToken.toLowerCase();
    const exact = jobs.find((row) => row.id.toLowerCase() === token);
    if (exact)
      return { isJobQuery: true, requestedToken, selectedJob: exact };
    const prefix = jobs.find((row) => row.id.toLowerCase().startsWith(token));
    if (prefix)
      return { isJobQuery: true, requestedToken, selectedJob: prefix };
    return { isJobQuery: true, requestedToken, selectedJob: null };
  }
  const prioritized = jobs.find((row) => row.status === "claimed") ?? jobs.find((row) => row.status === "pending") ?? jobs[0] ?? null;
  return { isJobQuery: true, requestedToken, selectedJob: prioritized };
}
function buildJobLogTail(logs, maxLines = 8) {
  if (!logs.length)
    return "";
  const lines = logs.map((row) => String(row.message ?? "").trim()).filter(Boolean).slice(-Math.max(1, Math.min(10, maxLines)));
  if (!lines.length)
    return "";
  return lines.join(`
`);
}
function extractThinkingHint(logs) {
  for (let i = logs.length - 1;i >= 0; i -= 1) {
    const line = String(logs[i]?.message ?? "").trim();
    if (!line)
      continue;
    if (/\b(thinking|thought|analyze|analysis)\b[:\s-]/i.test(line)) {
      return line.length > 180 ? `${line.slice(0, 177)}...` : line;
    }
  }
  return "";
}
function buildJobStatusReply(args) {
  const { userPrompt, sessionId, summarizeFailure } = args;
  const formatTime = args.formatTime ?? formatClockTime;
  const selection = selectRelevantJobForPrompt({
    userPrompt,
    sessionId,
    jobs: args.jobs
  });
  if (!selection.isJobQuery)
    return null;
  const jobs = (args.jobs ?? []).filter((row) => row.sessionId === sessionId);
  if (jobs.length === 0) {
    return "I don't see any jobs in this session yet.";
  }
  if (!selection.selectedJob) {
    if (selection.requestedToken) {
      const latest = jobs.slice(0, 3).map((row) => row.id.slice(0, 8)).join(", ");
      return latest ? `I couldn't find job ${selection.requestedToken}. Recent job IDs: ${latest}.` : `I couldn't find job ${selection.requestedToken}.`;
    }
    return "I couldn't resolve which job to check.";
  }
  const job = selection.selectedJob;
  const shortId = job.id.slice(0, 8);
  const updated = formatTime(job.updatedAt);
  let summary = `Job ${shortId} is ${job.status} (updated ${updated})`;
  if (job.workerId)
    summary += ` on ${job.workerId}`;
  summary += ".";
  if (job.status === "claimed") {
    summary += " It is currently in progress.";
    const startedIso = startedIsoForJob(job);
    const startedMs = startedIso ? Date.parse(startedIso) : NaN;
    if (Number.isFinite(startedMs)) {
      const elapsedMs = Math.max(0, Date.now() - startedMs);
      const elapsedText = formatDuration(elapsedMs);
      if (elapsedText)
        summary += ` Elapsed: ${elapsedText}.`;
      const budgetMs = parseExecutionBudgetMs(job);
      if (budgetMs && budgetMs > 0) {
        const timeoutAt = new Date(startedMs + budgetMs).toISOString();
        summary += ` Timeout target: ${formatTime(timeoutAt)}.`;
      }
    }
  } else if (job.status === "pending") {
    summary += " It is queued and waiting for a WorkerPal.";
    const enqueuedMs = Date.parse(job.enqueuedAt ?? job.createdAt);
    if (Number.isFinite(enqueuedMs)) {
      const queueElapsedText = formatDuration(Date.now() - enqueuedMs);
      if (queueElapsedText)
        summary += ` Queue wait so far: ${queueElapsedText}.`;
    }
  }
  if (job.status === "completed" || job.status === "failed") {
    const durationText = formatDuration(job.durationMs);
    if (durationText) {
      summary += ` Runtime: ${durationText}.`;
    }
  }
  if (job.status === "failed") {
    const jobError = parseStructuredError(job.error, summarizeFailure);
    if (jobError)
      summary += ` Failure: ${jobError}`;
  }
  const logs = (args.logs ?? []).filter((row) => row.jobId === job.id);
  if (logs.length > 0) {
    const tail = buildJobLogTail(logs, 8);
    if (tail) {
      summary += `
Latest logs:
\`\`\`
${tail}
\`\`\``;
    }
    const hint = extractThinkingHint(logs);
    if (hint) {
      summary += `
Model hint: ${hint}`;
    }
  }
  return summary;
}
function buildRequestStatusReply(args) {
  const { userPrompt, sessionId, summarizeFailure } = args;
  if (!isStatusLookupPrompt(userPrompt))
    return null;
  const formatTime = args.formatTime ?? formatClockTime;
  const requestedToken = extractReferencedRequestToken(userPrompt);
  const requests = (args.requests ?? []).filter((row) => row.sessionId === sessionId);
  const jobs = (args.jobs ?? []).filter((row) => row.sessionId === sessionId);
  if (requests.length === 0) {
    return "I don't see any requests in this session yet.";
  }
  let request;
  if (requestedToken) {
    const token = requestedToken.toLowerCase();
    request = requests.find((row) => row.id.toLowerCase() === token);
    if (!request) {
      request = requests.find((row) => row.id.toLowerCase().startsWith(token));
    }
    if (!request) {
      const latest = requests.slice(0, 3).map((row) => row.id.slice(0, 8)).join(", ");
      return latest ? `I couldn't find request ${requestedToken}. Recent request IDs: ${latest}.` : `I couldn't find request ${requestedToken}.`;
    }
  } else {
    request = requests.find((row) => row.status === "pending" || row.status === "claimed") ?? requests[0];
  }
  if (!request) {
    return "I couldn't resolve which request to check.";
  }
  const requestId = request.id;
  const relatedJobs = jobs.filter((job) => extractJobRequestId(job) === requestId);
  relatedJobs.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const requestShort = requestId.slice(0, 8);
  const requestTime = formatTime(request.updatedAt);
  let summary = `Request ${requestShort} is ${request.status} (updated ${requestTime}).`;
  if (request.priority) {
    summary = `${summary} Priority: ${request.priority}.`;
  }
  if (request.status === "claimed" && request.agentId) {
    summary = `Request ${requestShort} is claimed by ${request.agentId} (updated ${requestTime}).`;
    if (request.priority) {
      summary += ` Priority: ${request.priority}.`;
    }
  }
  if (request.status === "failed") {
    const requestError = parseStructuredError(request.error, summarizeFailure);
    if (requestError) {
      summary = `${summary} Failure: ${requestError}`;
    }
  }
  if (relatedJobs.length === 0) {
    if (request.status === "pending") {
      return `${summary} It is waiting for RemoteBuddy to claim it.`;
    }
    if (request.status === "claimed") {
      return `${summary} RemoteBuddy is still planning and has not enqueued a WorkerPal job yet.`;
    }
    if (request.status === "completed") {
      return `${summary} RemoteBuddy finished orchestration; no WorkerPal job is linked yet.`;
    }
    return summary;
  }
  const latestJob = relatedJobs[0];
  const latestJobShort = latestJob.id.slice(0, 8);
  const latestJobTime = formatTime(latestJob.updatedAt);
  let jobSummary = `Latest WorkerPal job ${latestJobShort} is ${latestJob.status} (updated ${latestJobTime})`;
  if (latestJob.workerId) {
    jobSummary += ` on ${latestJob.workerId}`;
  }
  jobSummary += ".";
  if (latestJob.status === "failed") {
    const jobError = parseStructuredError(latestJob.error, summarizeFailure);
    if (jobError) {
      jobSummary += ` Failure: ${jobError}`;
    }
  }
  if (relatedJobs.length > 1) {
    const counts = {
      pending: 0,
      claimed: 0,
      completed: 0,
      failed: 0
    };
    for (const row of relatedJobs)
      counts[row.status] += 1;
    const countsText = `Jobs: ${relatedJobs.length} total (${counts.pending} pending, ${counts.claimed} claimed, ${counts.completed} completed, ${counts.failed} failed).`;
    return `${summary} ${jobSummary} ${countsText}`;
  }
  return `${summary} ${jobSummary}`;
}

// apps/localbuddy/src/local_readonly.ts
var READONLY_COMMAND_TIMEOUT_MS = 8000;
var READONLY_HTTP_TIMEOUT_MS = 1e4;
var MAX_STATUS_LINES = 60;
function truncateLines(lines, maxLines) {
  const trimmed = lines.map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const shown = trimmed.slice(0, maxLines);
  const hidden = Math.max(0, trimmed.length - shown.length);
  return {
    text: shown.join(`
`),
    hidden
  };
}
async function runReadOnlyCommand(command, cwd) {
  const result = await runBoundedProcess(command, {
    cwd,
    timeoutMs: READONLY_COMMAND_TIMEOUT_MS,
    outputLimitBytes: 256 * 1024
  });
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
function isGitStatusPrompt(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text)
    return false;
  if (/\bgit\s+status\b/.test(text))
    return true;
  if (/\bstatus\b/.test(text) && /\b(repo|repository)\b/.test(text) && /\bgit\b/.test(text)) {
    return true;
  }
  return false;
}
function isSystemStatusPrompt(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text)
    return false;
  const mentionsSystem = /\b(system|database|db|queue|worker|workers|request|requests|job|jobs|health)\b/.test(text);
  const asksStatus = /\b(status|check|snapshot|overview|how.*doing|doing)\b/.test(text);
  return mentionsSystem && asksStatus;
}
function isLocalReadonlyQueryPrompt(input) {
  return isGitStatusPrompt(input) || isSystemStatusPrompt(input);
}
async function buildGitStatusReply(repoRoot) {
  const result = await runReadOnlyCommand(["git", "status", "--short", "--branch"], repoRoot);
  if (!result.ok) {
    const reason = result.stderr.trim() || "git status failed";
    return `I couldn't run git status locally (${reason}).`;
  }
  const allLines = result.stdout.replace(/\r\n/g, `
`).split(`
`).filter((line) => line.trim().length > 0);
  if (allLines.length === 0) {
    return "Git status is clean.";
  }
  const headerLine = allLines[0].startsWith("## ") ? allLines[0].slice(3).trim() : "unknown branch";
  const changeLines = allLines.length > 1 && allLines[0].startsWith("## ") ? allLines.slice(1) : allLines;
  if (changeLines.length === 0) {
    return `Git status: clean working tree on ${headerLine}.`;
  }
  const compact = truncateLines(changeLines, MAX_STATUS_LINES);
  const overflow = compact.hidden > 0 ? `
... (${compact.hidden} more)` : "";
  return `Git status on ${headerLine}:
\`\`\`
${compact.text}${overflow}
\`\`\``;
}
async function buildSystemStatusReply(ctx) {
  let response;
  try {
    response = await fetchBufferedWithHardDeadline({
      input: `${ctx.serverUrl}/system/status`,
      init: { headers: ctx.authHeaders },
      timeoutMs: Math.max(1, Math.floor(ctx.httpTimeoutMs ?? READONLY_HTTP_TIMEOUT_MS)),
      maxResponseBytes: 2 * 1024 * 1024,
      timeoutMessage: "LocalBuddy system-status request timed out"
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `I couldn't check system/database status right now (${reason}).`;
  }
  if (!response.ok) {
    return `I couldn't check system/database status right now (API ${response.status}).`;
  }
  const payload = await response.json();
  if (!payload.ok || !payload.workers || !payload.queues) {
    return `I couldn't check system/database status right now (${payload.message ?? "invalid response"}).`;
  }
  const workers = payload.workers;
  const requests = payload.queues.requests;
  const jobs = payload.queues.jobs;
  const completions = payload.queues.completions;
  return `System status: workers online ${workers.online}/${workers.total} ` + `(busy ${workers.busy}, idle ${workers.idle}). ` + `Requests p/c/d/f: ${requests.pending}/${requests.claimed}/${requests.completed}/${requests.failed}. ` + `Jobs pending/claimed/finalizing/completed/failed: ${jobs.pending}/${jobs.claimed}/${jobs.finalizing ?? 0}/${jobs.completed}/${jobs.failed}. ` + `Completions p/c/pr/f: ${completions.pending}/${completions.claimed}/${completions.processed}/${completions.failed}.`;
}
async function answerLocalReadonlyQuery(userPrompt, ctx) {
  if (isGitStatusPrompt(userPrompt)) {
    return buildGitStatusReply(ctx.repoRoot);
  }
  if (isSystemStatusPrompt(userPrompt)) {
    return buildSystemStatusReply(ctx);
  }
  return null;
}

// apps/localbuddy/src/localbuddy_main.ts
var CONFIG = loadPushPalsConfig();
var LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS = 1e4;
function parseArgs() {
  const args = process.argv.slice(2);
  let server = CONFIG.server.url;
  let port = CONFIG.localbuddy.port;
  let sessionId = CONFIG.sessionId;
  let authToken = CONFIG.authToken;
  let validateConfig = false;
  for (let i = 0;i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        server = args[++i];
        break;
      case "--port":
        port = parseInt(args[++i], 10);
        break;
      case "--sessionId":
        sessionId = args[++i];
        break;
      case "--token":
        authToken = args[++i];
        break;
      case "--validate-config":
        validateConfig = true;
        break;
    }
  }
  const resolved = resolveLocalServerConnection({
    serverUrl: server,
    authToken,
    fallbackPort: CONFIG.server.port
  });
  if (resolved.serverWasNormalized) {
    console.warn(`[LocalBuddy] Coerced server URL to local-only endpoint: ${resolved.serverUrl}`);
  }
  if (resolved.authTokenWasIgnored) {
    console.warn("[LocalBuddy] Ignoring auth token in local-only mode.");
  }
  return {
    server: resolved.serverUrl,
    port,
    sessionId,
    authToken: resolved.authToken,
    validateConfig
  };
}
function parseStatusHeartbeatMs(fallbackMs) {
  const parsed = Math.floor(fallbackMs);
  if (!Number.isFinite(parsed))
    return 120000;
  if (parsed <= 0)
    return 0;
  return Math.max(30000, parsed);
}
function summarizeFailureForPrompt(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text)
    return "";
  const lowered = text.toLowerCase();
  if (lowered.includes("cannot truncate prompt with n_keep") || lowered.includes("context size has been exceeded") || lowered.includes("prompt exceeded") && lowered.includes("context")) {
    return "Prompt/context exceeded the model window.";
  }
  if (lowered.includes("connection refused") || lowered.includes("connection error") || lowered.includes("econnrefused")) {
    return "LLM endpoint connection error.";
  }
  if (lowered.includes("timed out") || lowered.includes("job timeout")) {
    return "Worker job timed out.";
  }
  if (lowered.includes("response did not contain parseable json")) {
    return "Model returned non-JSON output when structured output was expected.";
  }
  const stackLikeIndex = text.search(/\b(traceback|stack trace| at [A-Za-z0-9_.]+[:(])/i);
  const compact = stackLikeIndex > 0 ? text.slice(0, stackLikeIndex).trim() : text;
  if (compact.length <= 220)
    return compact;
  return `${compact.slice(0, 217)}...`;
}
var ASK_REMOTE_BUDDY_COMMAND = "/ask_remote_buddy";
var LOCAL_QUICK_REPLY_SYSTEM_PROMPT = loadPromptTemplate("localbuddy/local_quick_reply_system_prompt.md").trim();
var LOCAL_QUICK_REPLY_JSON_SYSTEM_SUFFIX = loadPromptTemplate("localbuddy/local_quick_reply_json_system_suffix.md").trim();
function tryParseJsonObject2(raw) {
  const parseAtDepth = (input, depth) => {
    if (depth > 2)
      return null;
    const trimmed2 = input.trim();
    if (!trimmed2)
      return null;
    try {
      const parsed = JSON.parse(trimmed2);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      if (typeof parsed === "string" && parsed.trim()) {
        return parseAtDepth(parsed, depth + 1);
      }
    } catch {}
    return null;
  };
  const trimmed = raw.trim();
  if (!trimmed)
    return null;
  const direct = parseAtDepth(trimmed, 0);
  if (direct)
    return direct;
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    const nested = parseAtDepth(sliced, 0);
    if (nested)
      return nested;
  }
  return null;
}
function extractLocalReplyFromObject(value) {
  if (!value)
    return "";
  const candidates = [
    value.reply,
    value.assistant_message,
    value.message,
    value.text,
    value.content
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}
function extractLocalReplyFromJsonLikeText(value) {
  const keyPattern = "(reply|assistant_message|message|text|content)";
  const directMatch = value.match(new RegExp(`"${keyPattern}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i"));
  if (!directMatch?.[2])
    return "";
  const encoded = directMatch[2];
  try {
    const decoded = JSON.parse(`"${encoded}"`);
    return typeof decoded === "string" ? decoded.trim() : "";
  } catch {
    return encoded.trim();
  }
}
function fallbackLocalReply(userPrompt) {
  const text = userPrompt.trim().toLowerCase();
  if (/^(hi|hello|hey)\b/.test(text)) {
    return "Hello. I can answer lightweight questions directly, or route execution work with /ask_remote_buddy <request>.";
  }
  if (/status|what'?s the status|whats the status/.test(text)) {
    return "I\u2019m online and ready. For full job/repo status, use /ask_remote_buddy <request>.";
  }
  return "I can answer lightweight questions directly. For execution or coding work, use /ask_remote_buddy <request>.";
}
function sanitizeLocalReply(raw, userPrompt) {
  let text = String(raw ?? "").replace(/^```(?:json)?\s*/i, "").replace(/```/g, "").trim();
  if (!text)
    return fallbackLocalReply(userPrompt);
  const parsed = tryParseJsonObject2(text);
  const extracted = extractLocalReplyFromObject(parsed);
  if (extracted) {
    text = extracted;
  } else {
    const extractedFromJsonLike = extractLocalReplyFromJsonLikeText(text);
    if (extractedFromJsonLike) {
      text = extractedFromJsonLike;
    }
  }
  const lowered = text.toLowerCase();
  const reasoningSignals = [
    "analyze the user's request",
    "identify the constraints",
    "self-correction",
    "step-by-step",
    "my reasoning",
    "chain-of-thought"
  ];
  if (reasoningSignals.some((signal) => lowered.includes(signal))) {
    return fallbackLocalReply(userPrompt);
  }
  const firstParagraph = text.split(/\n\s*\n/)[0]?.trim() ?? text;
  text = firstParagraph.length > 320 ? `${firstParagraph.slice(0, 317)}...` : firstParagraph;
  if (/^\d+\.\s+\*\*/.test(text) || /^analysis[:\s]/i.test(text)) {
    return fallbackLocalReply(userPrompt);
  }
  const stillJsonLike = /^\s*\{[\s\S]*\}\s*$/.test(text) && /"(reply|assistant_message|message|text|content)"\s*:/.test(text);
  if (stillJsonLike) {
    return fallbackLocalReply(userPrompt);
  }
  return text || fallbackLocalReply(userPrompt);
}
function classifyRemoteRequestPriority(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text)
    return "normal";
  if (/\b(status|progress|queue|queued|eta|where|hows my job|what'?s my status|check on)\b/.test(text)) {
    return "interactive";
  }
  if (/\b(comprehensive|deep dive|full pass|phase\s+\d|architecture|migration|refactor|rewrite|all components|everything)\b/.test(text) || text.length > 1200) {
    return "background";
  }
  return "normal";
}
function queueWaitBudgetForPriority(priority) {
  switch (priority) {
    case "interactive":
      return 20000;
    case "background":
      return 240000;
    default:
      return 90000;
  }
}
function formatEtaFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0)
    return "now";
  const value = Math.max(0, Math.floor(ms));
  if (value < 1000)
    return `${value}ms`;
  const secs = Math.ceil(value / 1000);
  if (secs < 60)
    return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return remSecs > 0 ? `${minutes}m ${remSecs}s` : `${minutes}m`;
}
function parseRemoteBuddyCommand(input) {
  const trimmed = String(input ?? "").trim();
  const command = ASK_REMOTE_BUDDY_COMMAND.toLowerCase();
  if (!trimmed.toLowerCase().startsWith(command)) {
    return { forceRemote: false, prompt: trimmed };
  }
  const rest = trimmed.slice(command.length).replace(/^[:\-]\s*/, "").trim();
  if (!rest) {
    return {
      forceRemote: true,
      prompt: "",
      usageMessage: "Usage: /ask_remote_buddy <request>. Example: /ask_remote_buddy fix the failing job status in the dashboard."
    };
  }
  return { forceRemote: true, prompt: rest };
}
function isLikelyLocalOnlyPrompt(input) {
  const text = String(input ?? "").trim().toLowerCase();
  if (!text)
    return true;
  if (isLocalReadonlyQueryPrompt(text)) {
    return true;
  }
  if (/^(hi|hello|hey|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|good morning|good afternoon|good evening)[!. ]*$/.test(text)) {
    return true;
  }
  if (/^(how are you|what can you do|who are you|are you there|status\??)\b/.test(text)) {
    return true;
  }
  const executionCue = /\b(fix|implement|write|create|add|remove|delete|rename|refactor|run|test|lint|build|debug|search|find|edit|update|change)\b/.test(text);
  if (executionCue)
    return false;
  if (/^(yes|confirm|confirmed|proceed|go ahead|go|do it|let'?s?(?: do it| go)?|sure|yep|yup|absolutely|approved?)[!. ]*$/.test(text)) {
    return false;
  }
  return text.length <= 120;
}

class LocalBuddyServer {
  agentId = "localbuddy-1";
  server;
  sessionId;
  repo;
  authToken;
  llm;
  recentJobFailures = [];
  seenJobFailureKeys = new Set;
  constructor(opts) {
    this.server = opts.server;
    this.sessionId = opts.sessionId;
    this.authToken = opts.authToken;
    this.repo = detectRepoRoot(process.cwd());
    console.log(`[LocalBuddy] Detected repo root: ${this.repo}`);
    const llmCfg = CONFIG.localbuddy.llm;
    this.llm = createLLMClient({
      service: "localbuddy",
      sessionId: this.sessionId,
      backend: llmCfg.backend,
      endpoint: llmCfg.endpoint,
      model: llmCfg.model,
      apiKey: llmCfg.apiKey,
      serverUrl: this.server,
      authToken: this.authToken
    });
    console.log(`[LocalBuddy] LLM client initialized`);
  }
  async answerLocally(userPrompt) {
    const normalized = String(userPrompt ?? "").trim();
    if (!normalized) {
      return "I didn't receive a request. Try a quick question, or use /ask_remote_buddy <request> to route work to RemoteBuddy.";
    }
    const statusReply = await this.answerRequestStatus(normalized);
    if (statusReply)
      return statusReply;
    const readonlyReply = await answerLocalReadonlyQuery(normalized, {
      repoRoot: this.repo,
      serverUrl: this.server,
      authHeaders: this.authHeaders()
    });
    if (readonlyReply)
      return readonlyReply;
    try {
      const output = await this.llm.generate({
        system: `${LOCAL_QUICK_REPLY_SYSTEM_PROMPT}

${LOCAL_QUICK_REPLY_JSON_SYSTEM_SUFFIX}`,
        messages: [
          {
            role: "user",
            content: loadPromptTemplate("localbuddy/local_quick_reply_user_prompt.md", {
              user_message: normalized
            })
          }
        ],
        json: true,
        maxTokens: 300,
        temperature: 0.2
      });
      const parsed = tryParseJsonObject2(output.text);
      const reply = extractLocalReplyFromObject(parsed) || output.text;
      const text = sanitizeLocalReply(reply, normalized);
      if (text)
        return text;
    } catch (err) {
      console.error("[LocalBuddy] Local reply generation failed:", err);
    }
    return fallbackLocalReply(normalized);
  }
  authHeaders(contentType = false) {
    const headers = {};
    if (contentType)
      headers["Content-Type"] = "application/json";
    if (this.authToken)
      headers["Authorization"] = `Bearer ${this.authToken}`;
    return headers;
  }
  toSingleLine(value, maxChars = 220) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text)
      return "";
    if (text.length <= maxChars)
      return text;
    return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
  }
  async fetchJobLogTail(jobId, limit = 8) {
    try {
      const res = await fetchBufferedWithHardDeadline({
        input: `${this.server}/jobs/${encodeURIComponent(jobId)}/logs?limit=${Math.max(1, Math.min(20, limit))}`,
        init: { headers: this.authHeaders() },
        timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
        maxResponseBytes: 8 * 1024 * 1024,
        timeoutMessage: "LocalBuddy job-log request timed out"
      });
      if (!res.ok)
        return [];
      const payload = await res.json();
      if (!payload.ok || !Array.isArray(payload.logs))
        return [];
      return payload.logs.map((row) => this.toSingleLine(row?.message, 220)).filter(Boolean).slice(-Math.max(1, Math.min(10, limit)));
    } catch {
      return [];
    }
  }
  async emitProactiveFailureUpdate(comm, jobId, message, detail) {
    const shortJob = jobId.slice(0, 8);
    const messageText = this.toSingleLine(message, 220) || "WorkerPal job failed.";
    const detailText = this.toSingleLine(detail, 200);
    const detailSuffix = detailText && detailText !== messageText ? ` (${detailText})` : "";
    const intro = `WorkerPal job ${shortJob} failed: ${messageText}${detailSuffix}. ` + "I got the failure and I'm checking recent logs now.";
    const introOk = await comm.assistantMessage(intro);
    if (!introOk) {
      console.warn(`[LocalBuddy] Failed to emit proactive failure intro for job ${jobId}`);
    }
    const tail = await this.fetchJobLogTail(jobId, 8);
    if (tail.length === 0)
      return;
    const likelyCause = summarizeFailureForPrompt(tail[tail.length - 1] ?? detail ?? message);
    const diagnosis = `Diagnosis for job ${shortJob}: ${likelyCause}
Recent logs:
\`\`\`
${tail.join(`
`)}
\`\`\``;
    const diagnosisOk = await comm.assistantMessage(diagnosis);
    if (!diagnosisOk) {
      console.warn(`[LocalBuddy] Failed to emit proactive failure diagnosis for job ${jobId}`);
    }
  }
  async answerRequestStatus(userPrompt) {
    if (!isStatusLookupPrompt(userPrompt))
      return null;
    try {
      const [requestData, jobData] = await Promise.all([
        fetchBufferedWithHardDeadline({
          input: `${this.server}/requests?status=all&limit=200`,
          init: { headers: this.authHeaders() },
          timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
          maxResponseBytes: 8 * 1024 * 1024,
          timeoutMessage: "LocalBuddy request-status query timed out"
        }),
        fetchBufferedWithHardDeadline({
          input: `${this.server}/jobs?status=all&limit=400`,
          init: { headers: this.authHeaders() },
          timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
          maxResponseBytes: 8 * 1024 * 1024,
          timeoutMessage: "LocalBuddy job-status query timed out"
        })
      ]);
      if (!requestData.ok) {
        return `I couldn't check request status right now (requests API ${requestData.status}).`;
      }
      if (!jobData.ok) {
        return `I couldn't check request status right now (jobs API ${jobData.status}).`;
      }
      const requestsPayload = await requestData.json();
      const jobsPayload = await jobData.json();
      const sessionJobs = (jobsPayload.jobs ?? []).filter((row) => row.sessionId === this.sessionId);
      let logs = [];
      const requestedJobToken = extractReferencedJobToken(userPrompt);
      const mightBeJobQuery = Boolean(requestedJobToken) || /\b(job|workerpal|task)\b/i.test(userPrompt);
      if (mightBeJobQuery && sessionJobs.length > 0) {
        let selectedJob = sessionJobs.find((row) => row.status === "claimed") ?? sessionJobs.find((row) => row.status === "pending") ?? sessionJobs[0];
        if (requestedJobToken) {
          const token = requestedJobToken.toLowerCase();
          const matchedJob = sessionJobs.find((row) => row.id.toLowerCase() === token) ?? sessionJobs.find((row) => row.id.toLowerCase().startsWith(token)) ?? null;
          selectedJob = matchedJob;
        }
        if (selectedJob) {
          const logsRes = await fetchBufferedWithHardDeadline({
            input: `${this.server}/jobs/${selectedJob.id}/logs?limit=10`,
            init: { headers: this.authHeaders() },
            timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
            maxResponseBytes: 8 * 1024 * 1024,
            timeoutMessage: "LocalBuddy selected-job log query timed out"
          });
          if (logsRes.ok) {
            const logsPayload = await logsRes.json();
            logs = logsPayload.logs ?? [];
          }
        }
      }
      const jobReply = buildJobStatusReply({
        userPrompt,
        sessionId: this.sessionId,
        jobs: jobsPayload.jobs ?? [],
        logs,
        summarizeFailure: summarizeFailureForPrompt
      });
      if (jobReply)
        return jobReply;
      return buildRequestStatusReply({
        userPrompt,
        sessionId: this.sessionId,
        requests: requestsPayload.requests ?? [],
        jobs: sessionJobs,
        summarizeFailure: summarizeFailureForPrompt
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return `I couldn't check request status right now (${summarizeFailureForPrompt(reason)}).`;
    }
  }
  async startServer(port) {
    const agentId = this.agentId;
    const repo = this.repo;
    const sessionId = this.sessionId;
    const serverUrl = this.server;
    const authToken = this.authToken;
    const answerLocally = this.answerLocally.bind(this);
    const comm = new CommunicationManager({
      serverUrl,
      sessionId,
      authToken,
      from: `agent:${agentId}`
    });
    let stopping = false;
    let statusSessionReady = false;
    const ensureSessionWithRetry = async (maxRetries = 20, baseDelayMs = 500, maxDelayMs = 5000) => {
      const headers = { "Content-Type": "application/json" };
      if (authToken)
        headers["Authorization"] = `Bearer ${authToken}`;
      for (let attempt = 1;attempt <= maxRetries && !stopping; attempt++) {
        try {
          const res = await fetchBufferedWithHardDeadline({
            input: `${serverUrl}/sessions`,
            init: {
              method: "POST",
              headers,
              body: JSON.stringify({ sessionId })
            },
            timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
            maxResponseBytes: 8 * 1024 * 1024,
            timeoutMessage: "LocalBuddy session registration timed out"
          });
          if (res.ok)
            return true;
        } catch {}
        const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await Bun.sleep(delayMs);
      }
      return false;
    };
    const emitStartupPresence = async () => {
      const ready = await ensureSessionWithRetry();
      if (!ready) {
        console.warn("[LocalBuddy] Could not ensure session for startup presence events");
        return;
      }
      statusSessionReady = true;
      const startupDeadlineMs = Date.now() + 15000;
      while (!stopping) {
        const statusOk = await comm.status(agentId, "idle", "LocalBuddy online and ready");
        if (statusOk)
          return;
        statusSessionReady = false;
        if (Date.now() >= startupDeadlineMs)
          break;
        await Bun.sleep(1000);
        statusSessionReady = await ensureSessionWithRetry(3, 400, 2500);
      }
      console.warn("[LocalBuddy] Failed to emit startup status event");
    };
    emitStartupPresence();
    const statusHeartbeatMs = parseStatusHeartbeatMs(CONFIG.localbuddy.statusHeartbeatMs);
    const statusHeartbeatTimer = statusHeartbeatMs > 0 ? setInterval(() => {
      (async () => {
        if (stopping)
          return;
        if (!statusSessionReady) {
          statusSessionReady = await ensureSessionWithRetry(3, 400, 2500);
        }
        const ok = await comm.status(agentId, "idle", "LocalBuddy heartbeat");
        if (!ok) {
          statusSessionReady = false;
        }
      })();
    }, statusHeartbeatMs) : null;
    const monitorStartedAt = Date.now();
    const stopSessionEvents = comm.subscribeSessionEvents((envelope) => {
      if (envelope.type !== "job_failed")
        return;
      if (stopping)
        return;
      const tsMs = Date.parse(envelope.ts);
      if (Number.isFinite(tsMs) && tsMs + 2000 < monitorStartedAt)
        return;
      const payload = envelope.payload;
      const jobId = String(payload.jobId ?? "").trim();
      const message = summarizeFailureForPrompt(payload.message);
      const detail = summarizeFailureForPrompt(payload.detail);
      if (!jobId || !message)
        return;
      const dedupeKey = `${jobId}:${message}`;
      if (this.seenJobFailureKeys.has(dedupeKey))
        return;
      this.seenJobFailureKeys.add(dedupeKey);
      if (this.seenJobFailureKeys.size > 200) {
        const oldest = this.seenJobFailureKeys.values().next().value;
        if (typeof oldest === "string") {
          this.seenJobFailureKeys.delete(oldest);
        }
      }
      const summary = detail && detail !== message ? `${message} (detail: ${detail.slice(0, 120)})` : message;
      this.recentJobFailures.unshift({ jobId, summary, ts: envelope.ts });
      if (this.recentJobFailures.length > 20) {
        this.recentJobFailures.length = 20;
      }
      console.warn(`[LocalBuddy] Observed WorkerPal job failure ${jobId}: ${summary}`);
      this.emitProactiveFailureUpdate(comm, jobId, message, detail);
    }, {
      onError: (message) => console.warn(`[LocalBuddy] Session monitor: ${message}`)
    });
    const stopMonitor = () => {
      stopping = true;
      comm.status(agentId, "shutting_down", "LocalBuddy shutting down");
      if (statusHeartbeatTimer) {
        clearInterval(statusHeartbeatTimer);
      }
      try {
        stopSessionEvents();
      } catch {}
    };
    process.once("SIGINT", stopMonitor);
    process.once("SIGTERM", stopMonitor);
    if (process.platform === "win32") {
      process.once("SIGBREAK", stopMonitor);
    }
    const maxPortRetries = 8;
    for (let portAttempt = 1;portAttempt <= maxPortRetries; portAttempt++) {
      try {
        Bun.serve({
          port,
          hostname: "127.0.0.1",
          idleTimeout: 120,
          async fetch(req) {
            const url = new URL(req.url);
            const pathname = url.pathname;
            const method = req.method;
            const originHeader = req.headers.get("origin");
            if (originHeader && !isLoopbackOrigin(originHeader)) {
              return new Response(JSON.stringify({ ok: false, message: "Forbidden origin" }), {
                status: 403,
                headers: {
                  "Content-Type": "application/json"
                }
              });
            }
            const corsHeaders = buildLocalCorsHeaders({
              origin: originHeader,
              allowAuthorizationHeader: true
            });
            const jsonHeaders = {
              "Content-Type": "application/json",
              ...corsHeaders
            };
            const makeJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });
            if (method === "OPTIONS") {
              return new Response(null, { status: 204, headers: jsonHeaders });
            }
            if (pathname === "/message" && method === "POST") {
              try {
                const body = await req.json();
                const rawPrompt = String(body.text ?? "");
                const routing = parseRemoteBuddyCommand(rawPrompt);
                const routedPrompt = routing.prompt;
                const forceRemote = routing.forceRemote;
                const statusLookupIntent = isStatusLookupPrompt(routedPrompt);
                const localOnly = !forceRemote && (statusLookupIntent || isLikelyLocalOnlyPrompt(routedPrompt));
                if (!rawPrompt.trim()) {
                  return makeJson({ ok: false, message: "text is required" }, 400);
                }
                console.log(`[LocalBuddy] Received message: ${rawPrompt.substring(0, 80)}${rawPrompt.length > 80 ? "..." : ""}`);
                if (forceRemote) {
                  console.log("[LocalBuddy] Routing mode: forced RemoteBuddy via /ask_remote_buddy");
                } else if (statusLookupIntent) {
                  console.log("[LocalBuddy] Routing mode: local status lookup");
                } else if (localOnly) {
                  console.log("[LocalBuddy] Routing mode: local-only reply");
                } else {
                  console.log("[LocalBuddy] Routing mode: queue for RemoteBuddy");
                }
                const cmdHeaders = { "Content-Type": "application/json" };
                if (authToken)
                  cmdHeaders["Authorization"] = `Bearer ${authToken}`;
                comm.userMessage(rawPrompt).then((ok) => {
                  if (!ok) {
                    console.error(`[LocalBuddy] Failed to emit user message to session`);
                  }
                }).catch((err) => console.error(`[LocalBuddy] Failed to emit user message to session:`, err));
                comm.assistantMessage(forceRemote ? "Received your request. Routing this to RemoteBuddy now." : localOnly ? "Received your request. I can answer this directly as LocalBuddy." : "Received your request. Queueing this to RemoteBuddy now.").then((ok) => {
                  if (!ok) {
                    console.error(`[LocalBuddy] Failed to emit immediate acknowledgement message`);
                  }
                }).catch((err) => console.error(`[LocalBuddy] Failed to emit immediate acknowledgement message:`, err));
                let closed = false;
                const stream = new ReadableStream({
                  async start(controller) {
                    const send = (data) => {
                      if (closed)
                        return;
                      try {
                        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}

`));
                      } catch {
                        closed = true;
                      }
                    };
                    const close = () => {
                      if (closed)
                        return;
                      closed = true;
                      try {
                        controller.close();
                      } catch {}
                    };
                    try {
                      if (routing.usageMessage) {
                        send({ type: "status", message: "Command missing request body." });
                        await comm.assistantMessage(routing.usageMessage);
                        send({
                          type: "complete",
                          message: "Handled locally",
                          data: { mode: "local_usage_hint", sessionId }
                        });
                        close();
                        return;
                      }
                      if (localOnly) {
                        send({ type: "status", message: "Generating LocalBuddy response..." });
                        const localReply = await answerLocally(routedPrompt);
                        await comm.assistantMessage(localReply);
                        send({
                          type: "complete",
                          message: "Responded locally",
                          data: { mode: "local", sessionId }
                        });
                        close();
                        return;
                      }
                      send({ type: "status", message: "Enqueuing to Request Queue..." });
                      const priority = classifyRemoteRequestPriority(routedPrompt);
                      const queueWaitBudgetMs = queueWaitBudgetForPriority(priority);
                      const res = await fetchBufferedWithHardDeadline({
                        input: `${serverUrl}/requests/enqueue`,
                        init: {
                          method: "POST",
                          headers: cmdHeaders,
                          body: JSON.stringify({
                            sessionId,
                            prompt: routedPrompt,
                            priority,
                            queueWaitBudgetMs
                          })
                        },
                        timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
                        maxResponseBytes: 8 * 1024 * 1024,
                        timeoutMessage: "LocalBuddy request enqueue timed out"
                      });
                      if (!res.ok) {
                        const err = await res.text();
                        console.error(`[LocalBuddy] Failed to enqueue request: ${err}`);
                        send({ type: "error", message: `Failed to enqueue: ${err}` });
                        close();
                        return;
                      }
                      const data = await res.json();
                      console.log(`[LocalBuddy] Enqueued request: ${data.requestId}`);
                      const requestSuffix = data.requestId ? ` (${data.requestId.slice(0, 8)})` : "";
                      const queueSuffix = Number.isFinite(data.queuePosition) && data.queuePosition > 0 ? ` Priority ${priority}; queue #${data.queuePosition} (ETA ${formatEtaFromMs(data.etaMs)}).` : ` Priority ${priority}.`;
                      await comm.assistantMessage(`Request queued${requestSuffix}.${queueSuffix} RemoteBuddy is planning and will assign a WorkerPal.`);
                      send({
                        type: "complete",
                        message: "Request enqueued successfully",
                        data: {
                          requestId: data.requestId,
                          sessionId,
                          priority,
                          queuePosition: data.queuePosition,
                          etaMs: data.etaMs
                        }
                      });
                      close();
                    } catch (err) {
                      console.error(`[LocalBuddy] Error processing message:`, err);
                      send({ type: "error", message: String(err) });
                      close();
                    }
                  }
                });
                return new Response(stream, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                    ...corsHeaders
                  }
                });
              } catch (err) {
                console.error(`[LocalBuddy] Error processing message:`, err);
                return makeJson({ ok: false, message: String(err) }, 500);
              }
            }
            if (pathname === "/healthz" && method === "GET") {
              return makeJson({
                ok: true,
                agentId,
                repo,
                sessionId
              });
            }
            if (pathname === "/" && method === "GET") {
              return makeJson({
                name: "PushPals LocalBuddy",
                version: "0.1.0",
                endpoints: {
                  "POST /message": "Send a message to LocalBuddy (use /ask_remote_buddy <request> to force remote routing)",
                  "GET /healthz": "Health check"
                }
              });
            }
            return makeJson({ ok: false, message: "Not found" }, 404);
          }
        });
        break;
      } catch (err) {
        if (err?.code === "EADDRINUSE" && portAttempt < maxPortRetries) {
          console.warn(`[LocalBuddy] Port ${port} in use; retrying in 2000ms (attempt ${portAttempt}/${maxPortRetries})...`);
          await Bun.sleep(2000);
        } else {
          throw err;
        }
      }
    }
    console.log(`[LocalBuddy] HTTP server listening on http://127.0.0.1:${port}`);
    console.log(`[LocalBuddy] Ready to receive messages at POST http://127.0.0.1:${port}/message`);
  }
}
async function connectWithRetry(server, sessionId, maxRetries = 10, baseDelay = 2000, maxDelay = 30000) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetchBufferedWithHardDeadline({
        input: `${server}/sessions`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId })
        },
        timeoutMs: LOCALBUDDY_CONTROL_HTTP_TIMEOUT_MS,
        maxResponseBytes: 8 * 1024 * 1024,
        timeoutMessage: "LocalBuddy startup session connection timed out"
      });
      if (!res.ok)
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      return data.sessionId;
    } catch (err) {
      if (attempt >= maxRetries)
        throw err;
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      console.log(`[LocalBuddy] Server unavailable (${err.message}), retrying in ${(delay / 1000).toFixed(1)}s\u2026 (attempt ${attempt})`);
      await Bun.sleep(delay);
    }
  }
}
async function main() {
  const opts = parseArgs();
  if (opts.validateConfig) {
    await preflightServiceLlm({ service: "localbuddy" });
    console.log("[LocalBuddy] Config preflight passed.");
    return;
  }
  console.log(`[LocalBuddy] PushPals LocalBuddy - HTTP Server`);
  console.log(`[LocalBuddy] Server: ${opts.server}`);
  console.log(`[LocalBuddy] Port: ${opts.port}`);
  console.log(`[LocalBuddy] Ensuring session "${opts.sessionId}" exists on server\u2026`);
  const sessionId = await connectWithRetry(opts.server, opts.sessionId);
  console.log(`[LocalBuddy] Using session: ${sessionId}`);
  const agent = new LocalBuddyServer({
    server: opts.server,
    sessionId,
    authToken: opts.authToken
  });
  await agent.startServer(opts.port);
}
main().catch((err) => {
  console.error("[LocalBuddy] Fatal:", err);
  process.exit(1);
});
