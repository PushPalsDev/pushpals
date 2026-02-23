const YARN_NON_SCRIPT_COMMANDS = new Set([
  "add",
  "install",
  "remove",
  "up",
  "upgrade",
  "set",
  "config",
  "cache",
  "dlx",
  "node",
  "workspaces",
  "workspace",
  "npm",
  "init",
  "create",
  "why",
  "info",
  "pack",
  "publish",
  "version",
  "test",
  "run",
  "exec",
]);

export function canonicalizeValidationCommandForBun(command: string): string {
  let value = String(command ?? "").trim();
  if (!value) return "";

  value = value.replace(/^npx\s+/i, "bunx ");
  value = value.replace(/^npm\s+exec\s+/i, "bunx ");
  value = value.replace(/^pnpm\s+(?:dlx|exec)\s+/i, "bunx ");
  value = value.replace(/^yarn\s+dlx\s+/i, "bunx ");

  value = value.replace(/^npm\s+--prefix\s+(\S+)\s+run\s+/i, "bun --cwd $1 run ");
  value = value.replace(/^npm\s+--prefix\s+(\S+)\s+test\b/i, "bun --cwd $1 test");
  value = value.replace(/^npm\s+run\s+/i, "bun run ");
  value = value.replace(/^pnpm\s+run\s+/i, "bun run ");
  value = value.replace(/^yarn\s+run\s+/i, "bun run ");

  value = value.replace(/^npm\s+test\b/i, "bun test");
  value = value.replace(/^pnpm\s+test\b/i, "bun test");
  value = value.replace(/^yarn\s+test\b/i, "bun test");

  const yarnScriptMatch = value.match(/^yarn\s+([A-Za-z0-9:_-]+)(\s+.*)?$/i);
  if (yarnScriptMatch) {
    const subcommand = String(yarnScriptMatch[1] ?? "").toLowerCase();
    if (!YARN_NON_SCRIPT_COMMANDS.has(subcommand)) {
      value = `bun run ${yarnScriptMatch[1]}${yarnScriptMatch[2] ?? ""}`.trim();
    }
  }

  return value.trim();
}

export function canonicalizeInstructionTextForBun(text: string): string {
  let value = String(text ?? "");
  if (!value.trim()) return "";

  value = value.replace(/`([^`\n]+)`/g, (_full, command: string) => {
    const canonical = canonicalizeValidationCommandForBun(command);
    return canonical ? `\`${canonical}\`` : `\`${command}\``;
  });

  value = value.replace(/\bnpx\s+/gi, "bunx ");
  value = value.replace(/\bnpm\s+exec\s+/gi, "bunx ");
  value = value.replace(/\bpnpm\s+(?:dlx|exec)\s+/gi, "bunx ");
  value = value.replace(/\byarn\s+dlx\s+/gi, "bunx ");

  value = value.replace(/\bnpm\s+--prefix\s+(\S+)\s+run\s+/gi, "bun --cwd $1 run ");
  value = value.replace(/\bnpm\s+--prefix\s+(\S+)\s+test\b/gi, "bun --cwd $1 test");
  value = value.replace(/\bnpm\s+run\s+/gi, "bun run ");
  value = value.replace(/\bpnpm\s+run\s+/gi, "bun run ");
  value = value.replace(/\byarn\s+run\s+/gi, "bun run ");

  value = value.replace(/\bnpm\s+test\b/gi, "bun test");
  value = value.replace(/\bpnpm\s+test\b/gi, "bun test");
  value = value.replace(/\byarn\s+test\b/gi, "bun test");

  return value;
}
