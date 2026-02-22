const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const workspacePackagesRoot = path.resolve(workspaceRoot, "packages");

const config = getDefaultConfig(projectRoot);

// Ensure Metro can read workspace packages (protocol/shared, etc.) without
// recursively traversing the whole repo (e.g. .worktrees/ with restricted perms).
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), workspacePackagesRoot]));

// Resolve all packages from the workspace root first so React/ReactDOM
// share a single module identity across app code and web SSR.
config.resolver = config.resolver ?? {};
config.resolver.nodeModulesPaths = [
  path.resolve(workspaceRoot, "node_modules"),
  path.resolve(projectRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
