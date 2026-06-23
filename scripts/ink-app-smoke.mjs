#!/usr/bin/env node
// Phase-3 Ink App smoke harness. Mounts StatusLine + Prompt together.
// Driven from the parent test exactly like the prompt
// smoke (real pipe stdin, fake-stdin bridge so Ink's raw-mode contract
// is satisfied). Outcome markers go to stderr.

import process from 'node:process';
import { Readable } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { App } from '../dist/ui/ink/App.js';

process.env['ANVILWING_INK_DEBUG'] = '1';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

class FakeStdin extends Readable {
  constructor() { super({ read() {} }); this.isTTY = true; this.setRawMode = () => this; this.ref = () => this; this.unref = () => this; }
}
const fakeStdin = new FakeStdin();
process.stdin.on('data', (chunk) => fakeStdin.push(chunk));
process.stdin.on('end', () => fakeStdin.push(null));

const status = has('--no-status') ? undefined : {
  message: arg('--message') ?? 'Ready',
  spinning: has('--spin'),
};
// --mode feeds the meta line below the input box (StatusLine no longer
// carries a mode row).
const metaLine = arg('--mode');

// --history accepts a "kind:text|kind:text|…" string so the harness can
// drive ChatStatic from the test layer. Kinds are user/assistant/system/
// tool/error/banner; missing kind defaults to 'system'.
const historyRaw = arg('--history');
const history = historyRaw
  ? historyRaw.split('|').map((entry, i) => {
      const colon = entry.indexOf(':');
      const kind = colon > 0 ? entry.slice(0, colon) : 'system';
      const text = colon > 0 ? entry.slice(colon + 1) : entry;
      return { id: `h-${i}`, kind, text };
    })
  : undefined;

const inst = render(
  React.createElement(App, {
    history,
    status,
    metaLine,
    prompt: {
      initial: arg('--initial') ?? '',
      onSubmit: (text) => {
        process.stderr.write(`SUBMIT: ${text}\n`);
        inst.unmount();
        setImmediate(() => process.exit(0));
      },
      onCancel: () => {
        process.stderr.write('CANCEL\n');
        inst.unmount();
        setImmediate(() => process.exit(0));
      },
    },
  }),
  { stdin: fakeStdin, stdout: process.stdout, exitOnCtrlC: false },
);

await inst.waitUntilExit().catch(() => undefined);
