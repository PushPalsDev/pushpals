export const WORKSPACE_TRUST_ERROR = "Workspace must be trusted to run stack operations.";

export function assertWorkspaceTrusted(isTrusted: boolean): void {
  if (!isTrusted) {
    throw new Error(WORKSPACE_TRUST_ERROR);
  }
}
