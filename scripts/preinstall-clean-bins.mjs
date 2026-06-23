#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Legacy bin names this product shipped under before the Anvilwing rebrand, so
// upgraders shed stale commands. The current `anvilwing` bin is managed by npm
// and is intentionally NOT listed here.
const BIN_NAMES = [
  'deepseek', 'erosolar', 'erosolar-cli', 'erosolar-ts',
  'trenchwork', 'trenchwork-coder', 'agi', 'agi-cli',
];
const OWNERSHIP_MARKERS = ['trenchwork', 'erosolar', 'deepseek', 'codex runtime ready', 'launchCli'];

const isGlobalInstall = process.env.npm_config_global === 'true';
const prefix = process.env.npm_config_prefix;

if (!isGlobalInstall || !prefix) {
  process.exit(0);
}

const binDir = process.platform === 'win32' ? join(prefix, 'Scripts') : join(prefix, 'bin');

for (const name of BIN_NAMES) {
  for (const target of candidatePaths(binDir, name)) {
    cleanCandidate(target);
  }
}

function candidatePaths(baseDir, name) {
  if (process.platform === 'win32') {
    return [join(baseDir, name), join(baseDir, `${name}.cmd`), join(baseDir, `${name}.ps1`)];
  }
  return [join(baseDir, name)];
}

function cleanCandidate(path) {
  if (!existsSync(path)) {
    return;
  }

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (ownsLink(target)) {
        rmSync(path);
      }
      return;
    }

    if (stat.isFile() && containsOwnershipMarker(path)) {
      rmSync(path);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[AGI] Unable to clean conflicting binary at ${path}: ${message}`);
  }
}

function ownsLink(linkTarget) {
  const normalized = linkTarget.toLowerCase();
  return (
    normalized.includes('trenchwork') ||
    normalized.includes('erosolar') ||
    normalized.includes('deepseek') ||
    normalized.includes('bo-shang')
  );
}

function containsOwnershipMarker(path) {
  try {
    const data = readFileSync(path, 'utf8').toLowerCase();
    return OWNERSHIP_MARKERS.some((marker) => data.includes(marker));
  } catch {
    return false;
  }
}
