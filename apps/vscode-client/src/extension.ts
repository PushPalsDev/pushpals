import * as vscode from "vscode";
import { PushPalsClientPanel } from "./clientPanel";
import { findWorkspaceRepoRoot } from "./repo";
import { StackServiceManager } from "./serviceManager";
import { WORKSPACE_TRUST_ERROR } from "./workspaceTrust";

let activeStackManager: StackServiceManager | undefined;

async function ensureWorkspaceTrustedForStackOps(): Promise<void> {
  if (vscode.workspace.isTrusted) return;
  const choice = await vscode.window.showWarningMessage(
    "PushPals stack orchestration requires a trusted workspace.",
    "Manage Workspace Trust",
  );
  if (choice) {
    await vscode.commands.executeCommand("workbench.trust.manage");
  }
  throw new Error(WORKSPACE_TRUST_ERROR);
}

function resolveWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Open a git repository folder in VS Code before using this extension.");
  }
  const repoRoot = findWorkspaceRepoRoot(folder.uri.fsPath);
  if (!repoRoot) {
    throw new Error("Workspace is not inside a git repository.");
  }
  return repoRoot;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("PushPals VS Code Client");
  const stackManager = new StackServiceManager(output);
  activeStackManager = stackManager;
  context.subscriptions.push(output, stackManager);
  if (!vscode.workspace.isTrusted) {
    output.appendLine("[extension] Workspace is untrusted. Start/stop/auto-start operations are blocked.");
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  status.command = "pushpals.openClient";
  const refreshStatus = () => {
    const running = stackManager.isRunning();
    status.text = running ? "$(pulse) PushPals Stack: Running" : "$(play) PushPals Stack: Stopped";
    status.tooltip = running
      ? "PushPals stack is running. Click to open VS Code client."
      : "PushPals stack is stopped. Click to open VS Code client.";
    status.show();
  };
  refreshStatus();
  context.subscriptions.push(
    status,
    stackManager.onDidChangeRunning(() => {
      refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pushpals.openClient", () => {
      PushPalsClientPanel.createOrShow(context, output, stackManager, resolveWorkspaceRoot);
    }),
    vscode.commands.registerCommand("pushpals.showOutput", () => {
      output.show(true);
    }),
    vscode.commands.registerCommand("pushpals.startStack", async () => {
      try {
        await ensureWorkspaceTrustedForStackOps();
        const root = resolveWorkspaceRoot();
        output.appendLine(`[extension] Starting stack in ${root}`);
        await stackManager.startStack(root);
        refreshStatus();
        void vscode.window.showInformationMessage("PushPals stack started.");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        output.appendLine(`[extension] start failed: ${detail}`);
        void vscode.window.showErrorMessage(`PushPals stack failed to start: ${detail}`);
      }
    }),
    vscode.commands.registerCommand("pushpals.stopStack", async () => {
      try {
        await ensureWorkspaceTrustedForStackOps();
        const root = resolveWorkspaceRoot();
        output.appendLine("[extension] Stopping stack");
        await stackManager.stopStack(root);
        refreshStatus();
        void vscode.window.showInformationMessage("PushPals stack stopped.");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        output.appendLine(`[extension] stop failed: ${detail}`);
        void vscode.window.showErrorMessage(`PushPals stack failed to stop: ${detail}`);
      }
    }),
  );

  const autoStart = vscode.workspace
    .getConfiguration("pushpals")
    .get<boolean>("autoStartStackOnActivate", false);
  if (autoStart) {
    try {
      await ensureWorkspaceTrustedForStackOps();
      const root = resolveWorkspaceRoot();
      output.appendLine("[extension] auto-start enabled");
      await stackManager.startStack(root);
      refreshStatus();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      output.appendLine(`[extension] auto-start failed: ${detail}`);
      void vscode.window.showWarningMessage(`PushPals auto-start failed: ${detail}`);
    }
  }
}

export async function deactivate(): Promise<void> {
  if (!activeStackManager?.isRunning()) return;
  try {
    const root = resolveWorkspaceRoot();
    await activeStackManager.stopStack(root, { bypassTrust: true });
  } catch {
    // best effort during extension shutdown
  } finally {
    activeStackManager = undefined;
  }
}
