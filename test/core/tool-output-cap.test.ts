/**
 * Long-horizon reliability: the production per-tool output cap must not
 * cripple file reads. createDefaultContextManager (the factory the real
 * agentSession wires into the ToolRuntime chokepoint) capped tool output at
 * 5,000 chars — ~1% of anvilwing's 131k-token window — which cut the
 * MIDDLE out of any read over ~100 lines. The model then edited from
 * incomplete content and looped on "old_string not found" re-reads.
 *
 * Fail-before: a 30k-char Read (a perfectly ordinary source file) came back
 * truncated. Pass-after: it comes through whole; only truly enormous outputs
 * are truncated, and old-turn pruning (targetTokens) remains the real
 * window-protection mechanism.
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDefaultContextManager } from '../../src/core/contextManager.js';

const mk = () => createDefaultContextManager(undefined, 'anvilwing');

// ~30k chars / ~600 lines — an ordinary source file (this repo's
// interactiveShell.ts is ~4x bigger).
const ORDINARY_FILE = Array.from({ length: 600 }, (_, i) => `line ${i + 1}: ${'x'.repeat(40)}`).join('\n');

describe('production tool-output cap (createDefaultContextManager)', () => {
  test('an ordinary file read (~30k chars) passes through WHOLE', () => {
    const r = mk().truncateToolOutput(ORDINARY_FILE, 'Read');
    expect(r.wasTruncated).toBe(false);
    expect(r.content).toBe(ORDINARY_FILE);
  });

  test('the middle of a moderate file is NOT cut out (the edit-from-blind bug)', () => {
    const r = mk().truncateToolOutput(ORDINARY_FILE, 'read_file');
    expect(r.content).toContain('line 300:'); // the middle — where edits live
  });

  test('a truly enormous output (300k chars) is still truncated', () => {
    const huge = 'y'.repeat(300_000);
    const r = mk().truncateToolOutput(huge, 'Bash');
    expect(r.wasTruncated).toBe(true);
    expect(r.content.length).toBeLessThan(100_000);
  });

  test('source: the production cap is 50k, sized to the model window (not 5k)', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'contextManager.ts'), 'utf8');
    const factory = src.slice(src.indexOf('export function createDefaultContextManager'));
    expect(factory).toMatch(/maxToolOutputLength:\s*50_000/);
    expect(factory).not.toMatch(/maxToolOutputLength:\s*5000\b/);
  });
});
