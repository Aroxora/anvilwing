/**
 * read_files must truncate like read_file (head+tail), not head-only.
 *
 * intelligentTruncate routes 'read_file' to truncateFileOutput (keeps the head
 * AND the tail), but 'read_files' — the parallel multi-file sibling — fell
 * through to truncateDefault (head-only). So when a multi-file read overflowed
 * the per-tool cap, the LAST files the agent explicitly asked for vanished with
 * no sign they existed. read_files concatenates files in order, so the tail is
 * exactly the later files; head-only is the wrong strategy for it.
 *
 * Drives the REAL ContextManager.truncateToolOutput().
 */

import { describe, expect, test } from '@jest/globals';
import { ContextManager } from '../../src/core/contextManager.js';

const CAP = 10_000;
const cm = () => new ContextManager({ maxToolOutputLength: CAP });

/** A read_files payload that overflows the cap: a big first file (>cap chars,
 *  >2×keepLines lines so head+tail engages) then a small last file whose marker
 *  must survive on the tail. */
function multiFileOutput(): string {
  const fileA = Array.from({ length: 500 }, (_, i) => `   ${i + 1}\tfile A content line number ${i} here`).join('\n');
  return `Read 2 files in parallel:\n\nFile: /a.ts\n${fileA}\n\n---\n\nFile: /z.ts\n   1\tLAST_FILE_UNIQUE_MARKER`;
}

describe('read_files truncates head+tail (the last file stays visible)', () => {
  test('the last file marker survives an over-cap read_files (was dropped head-only)', () => {
    const out = multiFileOutput();
    expect(out.length).toBeGreaterThan(CAP);
    const r = cm().truncateToolOutput(out, 'read_files');
    expect(r.wasTruncated).toBe(true);
    expect(r.content).toContain('LAST_FILE_UNIQUE_MARKER');
  });

  test('read_file and read_files truncate the same way (consistent siblings)', () => {
    const out = multiFileOutput();
    const a = cm().truncateToolOutput(out, 'read_file').content;
    const b = cm().truncateToolOutput(out, 'read_files').content;
    expect(b).toBe(a);
  });

  test('under-cap read_files output is returned untouched', () => {
    const r = cm().truncateToolOutput('File: /a.ts\n   1\thi', 'read_files');
    expect(r.wasTruncated).toBe(false);
  });

  test('source guard: read_files routes to the file (head+tail) branch', () => {
    const { readFileSync } = require('node:fs');
    const { resolve } = require('node:path');
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'contextManager.ts'), 'utf8');
    expect(src).toMatch(/'read_files'/);
  });
});
