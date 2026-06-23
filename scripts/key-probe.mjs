import process from 'node:process';
import { Readable } from 'node:stream';
import React from 'react';
import { render, useInput, Box, Text } from 'ink';

class FakeStdin extends Readable {
  constructor() { super({ read() {} }); this.isTTY = true; this.setRawMode = () => this; this.ref = () => this; this.unref = () => this; }
}
const fakeStdin = new FakeStdin();
process.stdin.on('data', (chunk) => fakeStdin.push(chunk));
process.stdin.on('end', () => fakeStdin.push(null));

const Probe = () => {
  useInput((input, key) => {
    process.stderr.write(`KEY: input=${JSON.stringify(input)} ret=${key.return} bs=${key.backspace}\n`);
    if (key.return) { process.exit(0); }
  });
  return React.createElement(Box, null, React.createElement(Text, null, 'probe'));
};
const inst = render(React.createElement(Probe), { stdin: fakeStdin, stdout: process.stdout });
await inst.waitUntilExit().catch(() => undefined);
