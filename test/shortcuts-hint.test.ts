/**
 * The dim "? for shortcuts" hint must be a REAL promise: pressing `?` on an
 * empty buffer shows the shortcuts panel (Claude Code parity / honest-bar).
 * Source guard so a refactor that drops the wiring is caught on CI; the
 * behavioural real-binary proof is in test/e2e-input-modes.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

test('Prompt shows shortcuts when ? is pressed on an empty buffer', () => {
  const prompt = read('src/ui/ink/Prompt.tsx');
  expect(prompt).toMatch(/input === '\?'[\s\S]*?text\.length === 0[\s\S]*?onShowShortcuts/);
});

test('the shell wires onShowShortcuts to the shortcuts panel', () => {
  expect(read('src/headless/interactiveShell.ts')).toMatch(/onShowShortcuts: \(\) => this\.showKeyboardShortcuts\(\)/);
});

test('the input box still advertises the hint', () => {
  // permissionMode.permissionHint owns the wording; App falls back to the
  // LIVE module state (same as the strip) instead of a hardcoded literal.
  expect(read('src/core/permissionMode.ts')).toMatch(/\? for shortcuts/);
  expect(read('src/ui/ink/App.tsx')).toMatch(/permissionHint \?\? permissionHintFn\(\)/);
});
