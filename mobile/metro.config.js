const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

// RegExp.escape does not exist on Node 22.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const config = getDefaultConfig(__dirname);

// Mobile reuses the shared JSON locales and type-only files read-only. Nothing
// in these folders imports a package.
config.watchFolders = [
  path.resolve(__dirname, '../src/locales'),
  path.resolve(__dirname, '../src/types'),
];

// Never resolve a package from the repo root's node_modules: mobile has its own
// lockfile and React version. Anchored to the root path, so it cannot match
// mobile/node_modules.
config.resolver.blockList = [].concat(
  config.resolver.blockList ?? [],
  new RegExp('^' + escapeRegExp(path.resolve(__dirname, '..', 'node_modules')) + '/'),
);

module.exports = config;
