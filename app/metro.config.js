// L'app consomme directement le cœur TypeScript du dossier parent (src/),
// sans étape de build : Metro surveille ce dossier et expose l'alias "@core".
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, "..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [coreRoot];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  "@core": path.resolve(coreRoot, "src"),
};
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(coreRoot, "node_modules"),
];

module.exports = config;
