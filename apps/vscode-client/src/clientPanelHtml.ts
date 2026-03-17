type RenderClientPanelHtmlOptions = {
  cspSource: string;
  nonce: string;
};

export function renderClientPanelHtml(options: RenderClientPanelHtmlOptions): string {
  const { cspSource, nonce } = options;
  const csp = [
    "default-src 'none'",
    "img-src https: data:",
    `style-src ${cspSource} 'unsafe-inline'`,
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
        align-items: center;
      }
      .shortcut {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
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
        <textarea id="prompt" placeholder="Ask PushPals anything..."></textarea>
        <div class="composer-actions">
          <button id="send">Send</button>
          <div class="shortcut">Alt+Enter / Cmd+Enter</div>
        </div>
      </section>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const timeline = document.getElementById("timeline");
      const prompt = document.getElementById("prompt");
      const connectionValue = document.getElementById("connection-value");
      const stackValue = document.getElementById("stack-value");
      const sessionMeta = document.getElementById("session-meta");
      const startStack = document.getElementById("start-stack");
      const stopStack = document.getElementById("stop-stack");
      const pendingSendDrafts = new Map();

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

      function nextRequestId() {
        if (typeof globalThis.crypto?.randomUUID === "function") {
          return globalThis.crypto.randomUUID();
        }
        return "send-" + Date.now() + "-" + Math.random().toString(16).slice(2);
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
        if (msg.type === "sendResult") {
          const requestId = String(msg.requestId || "");
          const attemptedText = pendingSendDrafts.get(requestId) || "";
          pendingSendDrafts.delete(requestId);
          if (!msg.ok && attemptedText && !String(prompt.value || "").trim()) {
            prompt.value = attemptedText;
            prompt.focus();
            if (typeof prompt.setSelectionRange === "function") {
              prompt.setSelectionRange(prompt.value.length, prompt.value.length);
            }
          }
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
        const requestId = nextRequestId();
        pendingSendDrafts.set(requestId, text);
        vscode.postMessage({
          type: "send",
          requestId,
          text,
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
