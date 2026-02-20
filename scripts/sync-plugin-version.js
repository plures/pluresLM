#!/usr/bin/env node
// Copies the version from package.json into openclaw.plugin.json.
// Run automatically via the npm "version" lifecycle hook.
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const pluginPath = resolve(root, 'openclaw.plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));

plugin.version = pkg.version;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
console.log(`synced openclaw.plugin.json version → ${pkg.version}`);
