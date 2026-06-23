/**
 * Two input bugs the repo-wide audit surfaced, source-guarded for CI (the
 * behavioural real-binary proof is in test/e2e-input-modes.test.ts):
 *   - forward-Delete (Del) must remove the char AT the cursor, not backspace.
 *   - a multi-line paste (one chunk, embedded newlines) must land in the buffer
 *     instead of submitting line 1 and dropping the rest.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prompt = readFileSync(resolve(__dirname, '..', 'src/ui/ink/Prompt.tsx'), 'utf8');

test('forward-Delete routes to the reducer forward-delete, not backspace', () => {
  expect(prompt).toMatch(/if \(key\.delete\) return apply\(\{ type: 'delete' \}\)/);
});

test('internal newlines in a chunk are inserted (multi-line paste), only a terminating newline submits', () => {
  expect(prompt).toMatch(/apply\(\{ type: 'insert', text: '\\n' \}\)/);
});

test('any key dismisses an open inline panel and is consumed; Esc also interrupts', () => {
  // Dismiss-and-consume is preserved, AND Esc reaches onEscape so a panel open
  // during a running turn does not swallow the documented "esc to interrupt".
  expect(prompt).toMatch(/if \(panelOpen\) \{ onDismissPanel\?\.\(\); if \(key\.escape\) onEscape\?\.\(\); return; \}/);
});

test('the shell wires onDismissPanel to clear the inline panel', () => {
  const shell = readFileSync(resolve(__dirname, '..', 'src/headless/interactiveShell.ts'), 'utf8');
  expect(shell).toMatch(/onDismissPanel: \(\) => this\.dismissInlinePanel\(\)/);
});
