/**
 * Ctrl+O expand truncated tool result. The `(ctrl+o to expand)` marker on a
 * truncated result used to be a dead/deceptive affordance — Ctrl+O did
 * nothing. Now Ctrl+O re-emits the SAME result with no line cap.
 *
 * Behavioural: the REAL formatter truncates by default (with the marker) and
 * shows everything when expanded (maxLines huge). Source assertions lock the
 * wiring: the shell stores the full result ONLY when truncated (so the promise
 * is honest), re-emits it uncapped on Ctrl+O, and the key is wired through
 * Prompt → controller → shell.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatToolResult } from '../src/shell/toolPresentation.js';

const SRC = resolve(__dirname, '..', 'src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');

describe('Ctrl+O expand — formatter truncation vs full', () => {
  const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

  it('truncates by default and advertises the expand affordance', () => {
    const out = formatToolResult('bash', long, {});
    expect(out).toMatch(/\(ctrl\+o to expand\)/);
    expect(out.split('\n').length).toBeLessThanOrEqual(7); // ⎿ head + 5 + overflow
    expect(out).not.toContain('line 20');
  });

  it('shows the whole result when expanded (no cap, no marker)', () => {
    const out = formatToolResult('bash', long, {}, { maxLines: 100000 });
    expect(out).toContain('line 1');
    expect(out).toContain('line 20');
    expect(out).not.toMatch(/ctrl\+o to expand/);
  });

  it('a short result is not truncated (nothing to expand)', () => {
    const out = formatToolResult('bash', 'only one line', {});
    expect(out).not.toMatch(/ctrl\+o to expand/);
  });
});

describe('Ctrl+O expand — wiring (refactor-proofing)', () => {
  const shell = read('headless/interactiveShell.ts');

  it('the shell remembers the full result ONLY when the summary truncated', () => {
    // Guards the honesty: no marker → nothing stored → "Nothing to expand".
    expect(shell).toMatch(/lastExpandableResult\s*=\s*summary\.includes\('\(ctrl\+o to expand\)'\)/);
  });

  it('Ctrl+O re-emits the stored result uncapped', () => {
    expect(shell).toMatch(/private handleExpandToolResult\(\)/);
    expect(shell).toMatch(/maxLines: 100000/);
    expect(shell).toMatch(/onExpandToolResult: \(\) => this\.handleExpandToolResult\(\)/);
  });

  it('the key is wired Prompt → controller → shell', () => {
    expect(read('ui/ink/Prompt.tsx')).toMatch(/input === 'o' \|\| input === 'O'.*onExpandToolResult/);
    expect(read('ui/ink/InkPromptController.ts')).toMatch(/onExpandToolResult: \(\) => this\.callbacks\.onExpandToolResult/);
  });
});
