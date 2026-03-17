import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { resolveBrowserClientUrl } from "./browser_client_url";
import { normalizeVscodeServerUrl } from "./local_server_url";
import WebSocket from "ws";
import { reconnectDelayMs } from "./reconnectPolicy";
import { renderClientPanelHtml } from "./clientPanelHtml";
import { StackServiceManager } from "./serviceManager";
import { WORKSPACE_TRUST_ERROR } from "./workspaceTrust";
import { shouldDisplayInteractiveSessionEvent } from "./sessionEventVisibility";

type SessionEvent = {
  id?: string;
  ts?: string;
  type?: string;
  from?: string;
  payload?: Record<string, unknown>;
};

type WebviewInboundMessage =
  | { type: "ready" }
  | { type: "send"; requestId?: string; text?: string }
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
    sessionId: string,
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
      sessionId,
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
    sessionId: string,
  ) {
    this.panel = panel;
    this.context = context;
    this.output = output;
    this.stackManager = stackManager;
    this.resolveWorkspaceRoot = resolveWorkspaceRoot;
    this.sessionId = sessionId;

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
        const requestId = String(message.requestId ?? "").trim();
        const rawText = String(message.text ?? "").trim();
        if (!rawText) return;
        try {
          await this.sendMessage(rawText);
          this.post({ type: "sendResult", requestId, ok: true });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[client] send failed: ${detail}`);
          this.post({ type: "sendResult", requestId, ok: false, message: detail });
          this.post({ type: "error", message: detail });
        }
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
      if (!shouldDisplayInteractiveSessionEvent(parsed)) return;
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

  private post(payload: Record<string, unknown>): void {
    void this.panel.webview.postMessage(payload);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    return renderClientPanelHtml({
      cspSource: webview.cspSource,
      nonce,
    });
  }
}
