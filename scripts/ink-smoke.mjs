#!/usr/bin/env node
// Phase-1 Ink smoke harness. Renders the StatusLine component to an
// in-memory writable, prints the cleaned frame to stdout, exits 0.
// Spawned by test/ink-statusline.test.ts so jest can assert on real Ink
// output without fighting its ESM loader.

import { Writable } from 'node:stream';
import process from 'node:process';
import React from 'react';
import { render } from 'ink';
import { StatusLine } from '../dist/ui/ink/StatusLine.js';

const [, , scenario, ...args] = process.argv;
const props = (() => {
  switch (scenario) {
    case 'status':       return { message: args[0] ?? 'Thinking' };
    case 'spinner':      return { message: args[0] ?? 'Loading', spinning: true };
    case 'spinner-meta': return { message: args[0] ?? 'Synthesizing', spinning: true, startTime: Date.now() - 8000, tokensUsed: 1234 };
    case 'gerund':       return { message: 'Thinking', spinning: true, thinkingGerund: true };
    case 'cjk':          return { message: args[0] ?? '处理中 你好世界 👨‍👩‍👧‍👦' };
    case 'empty':        return {};
    default:
      console.error(`unknown scenario: ${scenario}`); process.exit(2);
  }
})();

let captured = '';
const sink = new Writable({
  write(chunk, _enc, cb) { captured += chunk.toString(); cb(); },
});
sink.isTTY = true;
sink.columns = 80;
sink.rows = 24;

const inst = render(React.createElement(StatusLine, props), { stdout: sink });
await new Promise((r) => setImmediate(r));
inst.unmount();
await inst.waitUntilExit().catch(() => undefined);

// Take the last committed frame — Ink emits a clear-region escape then
// the new content, so the tail is the current screen state.
const segments = captured.split(/\x1b\[\d*J/);
let frame = segments[segments.length - 1] || captured;
frame = frame
  .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\x1b./g, '');
process.stdout.write(frame.trim());
process.exit(0);
