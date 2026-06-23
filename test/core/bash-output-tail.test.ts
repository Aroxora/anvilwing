/**
 * execute_bash must keep the TAIL of an over-cap command, not the head.
 *
 * Output is buffered to ~1MB/stream to avoid OOM. The old appendChunk dropped
 * the NEWEST bytes once full, so a verbose build/test that overflowed kept its
 * startup noise and lost its CONCLUSION — the compile error, the "N tests
 * failed" summary, the final exit line. Since a coding agent runs builds/tests
 * constantly and the result is always at the end, it would be left unable to
 * tell what happened. Now the oldest bytes roll off and the tail survives.
 *
 * Drives the REAL execute_bash tool against REAL bash with >1MB of output
 * bookended by markers. OPT-OUT only where bash is unavailable.
 */

import { describe, expect, test, jest } from '@jest/globals';
import { createBashTools } from '../../src/tools/bashTools.js';

jest.setTimeout(40_000);

// ~1.9MB of output between the two markers (each line ~46 bytes × 40k).
const CMD =
  'echo HEAD_MARKER_FIRST; ' +
  'seq 1 40000 | awk \'{print "padding line " $1 " xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\'; ' +
  'echo TAIL_MARKER_CONCLUSION';

describe('execute_bash keeps the tail (conclusion) of over-cap output', () => {
  const tool = createBashTools(process.cwd()).find((t) => t.name === 'execute_bash')!;

  test('the final marker survives when output exceeds the 1MB buffer', async () => {
    const out = String(await tool.handler({ command: CMD }));
    // sanity: the run actually overflowed the buffer (else the test proves nothing)
    expect(out).toMatch(/truncated/i);
    // the CONCLUSION at the very end must be present (was dropped before the fix)
    expect(out).toContain('TAIL_MARKER_CONCLUSION');
    expect(out).toContain('padding line 40000'); // near-end output kept
    // the HEAD output was the part dropped (an early line is gone). Note: the
    // echoed command string contains "HEAD_MARKER_FIRST", so assert on an early
    // OUTPUT line instead — "padding line 1 x" matches only line 1.
    expect(out).not.toContain('padding line 1 x');
  });

  test('small output is returned whole, untouched (no spurious truncation)', async () => {
    const out = String(await tool.handler({ command: 'echo ONLY_LINE_HERE' }));
    expect(out).toContain('ONLY_LINE_HERE');
    expect(out).not.toMatch(/truncated/i);
  });

  test('source guard: appendChunk rolls oldest chunks off (keeps the tail)', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'tools', 'bashTools.ts'), 'utf8');
    expect(src).toMatch(/chunks\.shift\(\)/);          // rolls from the front
    expect(src).toMatch(/showing the LAST/i);          // notice reflects head-drop
    expect(src).not.toMatch(/if \(available <= 0\)/);  // old head-keep branch is gone
  });
});
