#!/usr/bin/env node
/**
 * Postinstall:
 *   1. chmod the bin entrypoints so they're executable on POSIX (no-op on Windows).
 *   2. On Windows, print a friendly one-time notice about PowerShell execution
 *      policy and the canonical command forms so users don't get blocked the
 *      first time they type `anvilwing` in PowerShell.
 *
 * Errors are intentionally swallowed: a postinstall must never fail an
 * `npm install` for a non-essential courtesy step.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BINS = [
  'dist/bin/anvilwing.js',
];

for (const rel of BINS) {
  try {
    fs.chmodSync(path.resolve(__dirname, '..', rel), 0o755);
  } catch {
    // Missing files (clean tree pre-build) and Windows chmod no-ops both land here.
  }
}

if (process.platform === 'win32' && !process.env['ANVILWING_QUIET_POSTINSTALL']) {
  // Single, scannable message — no banners, no marketing. Users see this once
  // per global install and can move on.
  const lines = [
    '',
    '[36mAnvilwing Coder[0m installed. Two notes for Windows:',
    '',
    '  [2m• Command available on PATH:[0m anvilwing',
    '    These work in [1mCommand Prompt[0m and [1mPowerShell[0m via the .cmd shims',
    '    npm installs automatically.',
    '',
    '  [2m• If PowerShell says "running scripts is disabled on this system",[0m',
    '    run this [2m(once, no admin needed)[0m and reopen the shell:',
    '',
    '      [33mSet-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser[0m',
    '',
    '    Or invoke the .cmd shim directly: [33manvilwing.cmd[0m',
    '',
  ];
  // Use stderr so the notice is visible even when npm is captured to stdout
  // by automation. The notice is short and bounded.
  try {
    process.stderr.write(lines.join(os.EOL) + os.EOL);
  } catch {
    // Even the notice itself is non-essential.
  }
}
