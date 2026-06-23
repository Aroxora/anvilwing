/**
 * read_file must DETECT binary files instead of decoding them as utf-8 — reading
 * a PNG/PDF/executable/zip as text dumped its NUL bytes and control chars into
 * the model's context (wasted tokens; the control bytes can corrupt the
 * terminal). A NUL byte in the first 8 KB is the standard binary signal; text
 * files (including source + unicode) don't contain NUL. This is binary
 * DETECTION, distinct from rendering images/PDFs.
 *
 * Drives the REAL read_file against REAL files.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileTools } from '../../src/tools/fileTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let read: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-bin-'));
  read = createFileTools(dir).find((t) => t.name === 'read_file');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

async function read1(name: string, bytes: Buffer | string): Promise<string> {
  fs.writeFileSync(path.join(dir, name), bytes);
  return read.handler({ path: name });
}

describe('read_file detects binary files', () => {
  test('a binary file is refused with a clear message, no NUL bytes dumped', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000, 0), Buffer.from([0xff, 0xfe])]);
    const out = await read1('image.png', png);
    expect(out).toMatch(/binary file/i);
    expect((out.match(/\x00/g) || []).length).toBe(0); // no NUL garbage
    expect(out.length).toBeLessThan(300); // a short message, not a 2KB dump
  });

  test('a NUL embedded mid-file (not just byte 0) is still detected', async () => {
    const out = await read1('data.bin', Buffer.concat([Buffer.from('some leading ascii text '), Buffer.from([0x00, 0x01, 0x02])]));
    expect(out).toMatch(/binary file/i);
  });

  test('a normal text/source file still reads with line numbers', async () => {
    const out = await read1('code.ts', 'const x = 1;\nconst y = 2;\n');
    expect(out).not.toMatch(/binary file/i);
    expect(out).toContain('const x = 1');
    expect(out).toMatch(/\(2 lines\)/);
  });

  test('unicode text (multi-byte, no NUL) is NOT flagged as binary', async () => {
    const out = await read1('uni.txt', 'café ☕ 日本語\nمرحبا\n');
    expect(out).not.toMatch(/binary file/i);
    expect(out).toContain('日本語');
  });

  test('an empty file is not binary', async () => {
    const out = await read1('e.txt', '');
    expect(out).not.toMatch(/binary file/i);
  });

  test('source guard: read_file scans for a NUL byte before decoding', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'fileTools.ts'), 'utf8');
    expect(src).toMatch(/head\.indexOf\(0,/);
    expect(src).toMatch(/binary file/i);
  });
});
