const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const workspacePackagesRoot = path.resolve(workspaceRoot, "packages");
const workspaceNodeModulesRoot = path.resolve(workspaceRoot, "node_modules");

const config = getDefaultConfig(projectRoot);

// Keep watch scope minimal: app project + shared workspace packages only.
// Expo's monorepo defaults can include repo-root node_modules, which in this
// workspace contains inaccessible Bun junctions on Windows.
config.watchFolders = [workspacePackagesRoot];

// Resolve packages from the app-level node_modules to avoid crawling
// repo-root workspace links that can be inaccessible on Windows.
config.resolver = config.resolver ?? {};
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;

// Bun workspace installs can create repo-root workspace links under node_modules
// that trigger EACCES on lstat() for Metro's fallback watcher on Windows.
// Keep Metro scoped to app-level node_modules and ignore those root links.
const escapedWorkspaceNodeModulesRoot = workspaceNodeModulesRoot.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
config.resolver.blockList = [
  new RegExp(
    `^${escapedWorkspaceNodeModulesRoot}[\\\\/](?:client|localbuddy|remotebuddy|server|source_control_manager|workerpals|protocol|shared|pushpals-vscode-client)(?:[\\\\/].*)?$`,
  ),
];

module.exports = config;
