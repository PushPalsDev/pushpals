import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { resolveBrowserClientUrl } from "./browser_client_url";
import { normalizeVscodeServerUrl } from "./local_server_url";
import WebSocket from "ws";
import { reconnectDelayMs } from "./reconnectPolicy";
import { createSessionId, sessionStorageKeyForWorkspace } from "./session";
import { StackServiceManager } from "./serviceManager";
import { WORKSPACE_TRUST_ERROR } from "./workspaceTrust";

type SessionEvent = {
  id?: string;
  ts?: string;
  type?: string;
  from?: string;
  payload?: Record<string, unknown>;
};

type WebviewInboundMessage =
  | { type: "ready" }
  | { type: "send"; text?: string; directRemote?: boolean }
  | { type: "startStack" }
  | { type: "stopStack" }
  | { type: "reconnect" }
  | { type: "openBrowserClient" };

export class PushPalsClientPanel implements vscode.Disposable {
  private static current: PushPalsClientPanel | undefined;
  static readonly viewType = "pushpals.client";

  static createOrShow(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    stackManager: StackServiceManager,
    resolveWorkspaceRoot: () => string,
  ): PushPalsClientPanel {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (PushPalsClientPanel.current) {
      PushPalsClientPanel.current.panel.reveal(column);
      return PushPalsClientPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      PushPalsClientPanel.viewType,
      "PushPals Client",
      column ?? vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    PushPalsClientPanel.current = new PushPalsClientPanel(
      panel,
      context,
      output,
      stackManager,
      resolveWorkspaceRoot,
    );
    return PushPalsClientPanel.current;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly output: vscode.OutputChannel;
  private readonly stackManager: StackServiceManager;
  private readonly resolveWorkspaceRoot: () => string;
  private readonly disposables: vscode.Disposable[] = [];

  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionId: string;
  private reconnectEnabled = true;
  private connected = false;
  private reconnectAttempt = 0;

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    stackManager: StackServiceManager,
    resolveWorkspaceRoot: () => string,
  ) {
    this.panel = panel;
    this.context = context;
    this.output = output;
    this.stackManager = stackManager;
    this.resolveWorkspaceRoot = resolveWorkspaceRoot;
    this.sessionId = this.getOrCreateSessionId();

    this.panel.webview.html = this.renderHtml(this.panel.webview);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((raw) => void this.handleMessage(raw)),
      this.panel.onDidDispose(() => this.dispose()),
      this.stackManager.onDidChangeRunning((running) => {
        this.post({ type: "stackState", running });
      }),
    );

    void this.bootstrapConnection().catch((err) => {
      this.handleBootstrapFailure(err, "initial");
    });
  }

  dispose(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // best effort
      }
    }
    this.ws = undefined;
    while (this.disposables.length > 0) {
      const item = this.disposables.pop();
      try {
        item?.dispose();
      } catch {
        // best effort
      }
    }
    if (PushPalsClientPanel.current === this) PushPalsClientPanel.current = undefined;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = (raw ?? {}) as WebviewInboundMessage;
    try {
      if (message.type === "ready") {
        this.post({
          type: "init",
          sessionId: this.sessionId,
          serverUrl: this.serverUrl(),
          stackRunning: this.stackManager.isRunning(),
          connected: this.connected,
        });
        return;
      }
      if (message.type === "startStack") {
        if (!(await this.ensureWorkspaceTrustedForStackOps())) return;
        await this.stackManager.startStack(this.resolveWorkspaceRoot());
        this.post({ type: "stackState", running: this.stackManager.isRunning() });
        return;
      }
      if (message.type === "stopStack") {
        if (!(await this.ensureWorkspaceTrustedForStackOps())) return;
        await this.stackManager.stopStack(this.resolveWorkspaceRoot());
        this.post({ type: "stackState", running: this.stackManager.isRunning() });
        return;
      }
      if (message.type === "send") {
        const rawText = String(message.text ?? "").trim();
        if (!rawText) return;
        const text =
          message.directRemote && !rawText.startsWith("/ask_remote_buddy")
            ? `/ask_remote_buddy ${rawText}`
            : rawText;
        await this.sendMessage(text);
        return;
      }
      if (message.type === "reconnect") {
        await this.reconnectNow();
        return;
      }
      if (message.type === "openBrowserClient") {
        const browserUrl = await resolveBrowserClientUrl(process.env, this.resolveWorkspaceRoot());
        this.output.appendLine(`[client] opening browser client ${browserUrl}`);
        await vscode.env.openExternal(vscode.Uri.parse(browserUrl));
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[client] action failed: ${detail}`);
      this.post({ type: "error", message: detail });
      void vscode.window.showErrorMessage(`PushPals extension: ${detail}`);
    }
  }

  private async bootstrapConnection(): Promise<void> {
    await this.ensureSession();
    await this.connectWebSocket();
  }

  private async reconnectNow(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempt = 0;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch {
        // best effort
      }
      this.ws = undefined;
    }
    this.connected = false;
    this.post({ type: "connection", connected: false, status: "reconnecting" });
    try {
      await this.bootstrapConnection();
    } catch (err) {
      this.handleBootstrapFailure(err, "manual");
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delayMs = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.output.appendLine(`[client] scheduling reconnect in ${delayMs}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.bootstrapConnection().catch((err) => this.handleBootstrapFailure(err, "auto"));
    }, delayMs);
  }

  private handleBootstrapFailure(err: unknown, source: "initial" | "manual" | "auto"): void {
    const detail = err instanceof Error ? err.message : String(err);
    this.connected = false;
    this.post({ type: "connection", connected: false, status: "disconnected" });
    this.output.appendLine(`[client] ${source} bootstrap failed: ${detail}`);
    this.post({ type: "error", message: `Connection failed: ${detail}` });
    this.scheduleReconnect();
  }

  private async ensureSession(): Promise<void> {
    const url = `${this.serverUrl()}/sessions`;
    this.output.appendLine(`[client] ensuring session ${this.sessionId} at ${url}`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.sessionId,
        client: this.clientRegistration(),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to create session: ${response.status} ${body}`);
    }
  }

  private async sendMessage(text: string): Promise<void> {
    const url = `${this.serverUrl()}/sessions/${encodeURIComponent(this.sessionId)}/message`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to send message: ${response.status} ${body}`);
    }
  }

  private async ensureWorkspaceTrustedForStackOps(): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    const choice = await vscode.window.showWarningMessage(
      "PushPals stack orchestration requires a trusted workspace.",
      "Manage Workspace Trust",
    );
    if (choice) {
      await vscode.commands.executeCommand("workbench.trust.manage");
    }
    this.output.appendLine(`[client] ${WORKSPACE_TRUST_ERROR}`);
    this.post({ type: "error", message: WORKSPACE_TRUST_ERROR });
    return false;
  }

  private async connectWebSocket(): Promise<void> {
    const wsUrl = `${this.wsUrlBase()}/sessions/${encodeURIComponent(this.sessionId)}/ws${this.clientTransportQuery()}`;
    this.post({ type: "connection", connected: false, status: "connecting" });
    this.output.appendLine(`[client] connecting websocket ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          try {
            ws.removeAllListeners();
            ws.terminate();
          } catch {
            // best effort
          }
          if (this.ws === ws) this.ws = undefined;
          rejectPromise(err);
          return;
        }
        resolvePromise();
      };

      ws.once("open", () => done());
      ws.once("error", (err) => done(err instanceof Error ? err : new Error(String(err))));
    });

    this.connected = true;
    this.reconnectAttempt = 0;
    this.post({ type: "connection", connected: true, status: "connected" });
    this.output.appendLine("[client] websocket connected");

    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      let parsed: SessionEvent;
      try {
        parsed = JSON.parse(text) as SessionEvent;
      } catch {
        this.post({ type: "event", event: { type: "raw", payload: { message: text } } });
        return;
      }
      this.post({ type: "event", event: parsed });
    });
    ws.on("close", () => {
      this.connected = false;
      this.post({ type: "connection", connected: false, status: "disconnected" });
      this.output.appendLine("[client] websocket disconnected");
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[client] websocket error: ${detail}`);
      this.post({ type: "error", message: `Socket error: ${detail}` });
    });
  }

  private serverUrl(): string {
    const configured =
      vscode.workspace.getConfiguration("pushpals").get<string>("serverUrl") ??
      "http://127.0.0.1:3001";
    return normalizeVscodeServerUrl(configured);
  }

  private wsUrlBase(): string {
    const http = this.serverUrl();
    if (http.startsWith("https://")) return `wss://${http.slice("https://".length)}`;
    if (http.startsWith("http://")) return `ws://${http.slice("http://".length)}`;
    return http;
  }

  private clientRegistration(): {
    clientId: string;
    kind: string;
    label: string;
    version: string;
    platform: string;
    repoRoot: string;
  } {
    const version =
      String((this.context.extension.packageJSON as { version?: string } | undefined)?.version ?? "").trim() ||
      "unknown";
    return {
      clientId: `vscode-${this.sessionId}`,
      kind: "vscode",
      label: "VS Code",
      version,
      platform: `${process.platform}/${process.arch}`,
      repoRoot: this.resolveWorkspaceRoot(),
    };
  }

  private clientTransportQuery(): string {
    const client = this.clientRegistration();
    const params = new URLSearchParams({
      after: "0",
      clientId: client.clientId,
      clientKind: client.kind,
      clientLabel: client.label,
      clientVersion: client.version,
      clientPlatform: client.platform,
      clientRepoRoot: client.repoRoot,
    });
    return `?${params.toString()}`;
  }

  private getOrCreateSessionId(): string {
    const workspaceIdentifier = vscode.workspace.workspaceFolders?.[0]?.uri.toString(true);
    const key = sessionStorageKeyForWorkspace(workspaceIdentifier);
    const existing = this.context.globalState.get<string>(key);
    if (existing && existing.trim()) return existing;

    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
    const next = createSessionId(workspaceName);
    void this.context.globalState.update(key, next);
    return next;
  }

  private post(payload: Record<string, unknown>): void {
    void this.panel.webview.postMessage(payload);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      "img-src https: data:",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>PushPals VS Code Client</title>
    <style>
      :root {
        color-scheme: light dark;
      }
      body {
        margin: 0;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background:
          radial-gradient(circle at 15% 20%, color-mix(in srgb, var(--vscode-button-background) 22%, transparent) 0%, transparent 40%),
          radial-gradient(circle at 85% 80%, color-mix(in srgb, var(--vscode-terminal-ansiGreen) 18%, transparent) 0%, transparent 40%),
          var(--vscode-editor-background);
      }
      .shell {
        display: grid;
        grid-template-rows: auto auto 1fr auto;
        gap: 10px;
        height: 100vh;
        padding: 12px;
        box-sizing: border-box;
      }
      .card {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 12px;
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
      }
      .title {
        margin: 0;
        font-size: 14px;
        letter-spacing: 0.3px;
        text-transform: uppercase;
      }
      .meta {
        margin-top: 4px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
      .controls {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        padding: 0 12px 12px;
      }
      button {
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 8px;
        padding: 6px 10px;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        cursor: pointer;
      }
      button.secondary {
        color: var(--vscode-foreground);
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 80%, transparent);
        border-color: var(--vscode-panel-border);
      }
      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .status-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(120px, 1fr));
        gap: 8px;
        padding: 0 12px 12px;
      }
      .stat {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        padding: 8px;
      }
      .label {
        font-size: 10px;
        letter-spacing: 0.3px;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
      }
      .value {
        margin-top: 4px;
        font-size: 12px;
        font-weight: 700;
      }
      .timeline {
        overflow: auto;
        padding: 10px;
      }
      .event {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 10px;
        padding: 8px;
        margin-bottom: 8px;
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
      }
      .event-head {
        display: flex;
        justify-content: space-between;
        gap: 6px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
      }
      .event-text {
        white-space: pre-wrap;
        line-height: 1.35;
      }
      .composer {
        padding: 10px;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
      }
      textarea {
        min-height: 72px;
        resize: vertical;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 8px;
        padding: 8px;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        font-family: inherit;
      }
      .composer-actions {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="card">
        <div class="header">
          <div>
            <h1 class="title">PushPals VS Code Client</h1>
            <div id="session-meta" class="meta">Session: --</div>
          </div>
        </div>
        <div class="controls">
          <button id="start-stack">Start Stack</button>
          <button id="stop-stack" class="secondary">Stop Stack</button>
          <button id="reconnect" class="secondary">Reconnect</button>
          <button id="open-browser" class="secondary">Open Web Client</button>
        </div>
        <div class="status-row">
          <div class="stat">
            <div class="label">Connection</div>
            <div id="connection-value" class="value">Disconnected</div>
          </div>
          <div class="stat">
            <div class="label">Stack</div>
            <div id="stack-value" class="value">Stopped</div>
          </div>
        </div>
      </section>

      <section id="timeline" class="card timeline"></section>

      <section class="card composer">
        <textarea id="prompt" placeholder="Ask LocalBuddy or route directly to RemoteBuddy..."></textarea>
        <div class="composer-actions">
          <button id="send">Send</button>
          <label class="toggle">
            <input type="checkbox" id="direct-remote" />
            Direct to Remote
          </label>
        </div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const timeline = document.getElementById("timeline");
      const prompt = document.getElementById("prompt");
      const directRemote = document.getElementById("direct-remote");
      const connectionValue = document.getElementById("connection-value");
      const stackValue = document.getElementById("stack-value");
      const sessionMeta = document.getElementById("session-meta");
      const startStack = document.getElementById("start-stack");
      const stopStack = document.getElementById("stop-stack");

      const state = {
        connected: false,
        stackRunning: false,
      };
      const MAX_TIMELINE_EVENTS = 200;

      function updateControls() {
        startStack.disabled = state.stackRunning;
        stopStack.disabled = !state.stackRunning;
        connectionValue.textContent = state.connected ? "Connected" : "Disconnected";
        stackValue.textContent = state.stackRunning ? "Running" : "Stopped";
      }

      function summarizeEvent(event) {
        const payload = event && typeof event === "object" ? event.payload || {} : {};
        const candidates = [
          payload.text,
          payload.message,
          payload.summary,
          payload.detail,
          payload.error,
          payload.status,
        ];
        for (const entry of candidates) {
          if (typeof entry === "string" && entry.trim()) return entry.trim();
        }
        try {
          const packed = JSON.stringify(payload);
          return packed === "{}" ? "Event received" : packed;
        } catch {
          return "Event received";
        }
      }

      function addEvent(event) {
        const row = document.createElement("div");
        row.className = "event";
        const ts = event.ts ? new Date(event.ts).toLocaleTimeString() : "--";
        const from = event.from || "unknown";
        const type = event.type || "event";
        const summary = summarizeEvent(event);

        const head = document.createElement("div");
        head.className = "event-head";
        const fromNode = document.createElement("span");
        fromNode.textContent = ts + " | " + String(from);
        const typeNode = document.createElement("span");
        typeNode.textContent = String(type);
        head.append(fromNode, typeNode);

        const textNode = document.createElement("div");
        textNode.className = "event-text";
        textNode.textContent = summary;

        row.append(head, textNode);
        timeline.prepend(row);
        while (timeline.childElementCount > MAX_TIMELINE_EVENTS && timeline.lastElementChild) {
          timeline.removeChild(timeline.lastElementChild);
        }
      }

      window.addEventListener("message", (evt) => {
        const msg = evt.data || {};
        if (msg.type === "init") {
          state.stackRunning = Boolean(msg.stackRunning);
          state.connected = Boolean(msg.connected);
          sessionMeta.textContent = "Session: " + (msg.sessionId || "--") + " @ " + (msg.serverUrl || "--");
          updateControls();
          return;
        }
        if (msg.type === "stackState") {
          state.stackRunning = Boolean(msg.running);
          updateControls();
          return;
        }
        if (msg.type === "connection") {
          state.connected = Boolean(msg.connected);
          updateControls();
          return;
        }
        if (msg.type === "event") {
          addEvent(msg.event || {});
          return;
        }
        if (msg.type === "error") {
          addEvent({
            ts: new Date().toISOString(),
            from: "extension",
            type: "error",
            payload: { message: String(msg.message || "Unknown error") },
          });
        }
      });

      document.getElementById("send").addEventListener("click", () => {
        const text = String(prompt.value || "").trim();
        if (!text) return;
        vscode.postMessage({
          type: "send",
          text,
          directRemote: Boolean(directRemote.checked),
        });
        prompt.value = "";
      });
      document.getElementById("start-stack").addEventListener("click", () => {
        vscode.postMessage({ type: "startStack" });
      });
      document.getElementById("stop-stack").addEventListener("click", () => {
        vscode.postMessage({ type: "stopStack" });
      });
      document.getElementById("reconnect").addEventListener("click", () => {
        vscode.postMessage({ type: "reconnect" });
      });
      document.getElementById("open-browser").addEventListener("click", () => {
        vscode.postMessage({ type: "openBrowserClient" });
      });
      prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.altKey)) {
          event.preventDefault();
          document.getElementById("send").click();
        }
      });

      updateControls();
      vscode.postMessage({ type: "ready" });
    </script>
  </body>
</html>`;
  }
}
