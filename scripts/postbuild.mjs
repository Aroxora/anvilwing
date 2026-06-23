#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const SRC_CONTRACTS_DIR = resolve(ROOT_DIR, 'src/contracts');
const DIST_CONTRACTS_DIR = resolve(ROOT_DIR, 'dist/contracts');
const EXECUTABLES = [
  resolve(ROOT_DIR, 'dist/bin/anvilwing.js'),
];

copyJsonContracts(SRC_CONTRACTS_DIR, DIST_CONTRACTS_DIR);
markExecutables(EXECUTABLES);

function copyJsonContracts(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) {
    return;
  }
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyJsonContracts(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function markExecutables(files) {
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    chmodSync(file, 0o755);
  }
}
