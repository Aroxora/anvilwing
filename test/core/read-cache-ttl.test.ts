/**
 * read_file / Grep / Glob are cached (CACHEABLE_TOOLS) to dedup the agent's
 * tight-loop re-reads. But they used the 5-MINUTE default TTL, so after a file
 * changed EXTERNALLY (a background build, a formatter/watcher, a manual edit)
 * a re-read could serve 5-minute-stale content for up to 5 minutes. (list_files
 * already used a short 4s TTL "to avoid stale listings"; read_file/Grep/Glob —
 * which go stale the same way — were missed.) A mutating tool already clears the
 * whole cache; this only bounds the EXTERNAL-change window.
 *
 * Drives the REAL ToolRuntime + read_file. The behavioural test waits ~4.3s so a
 * fresh read after the 4s TTL proves the bound (the old 5-min default would
 * still serve stale here).
 */

import { describe, expect, test, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRuntime } from '../../src/core/toolRuntime.js';
import { createFileTools } from '../../src/tools/fileTools.js';

jest.setTimeout(15_000);

describe('cacheable file reads have a short TTL (bounded staleness)', () => {
  test('read_file serves the cache within the TTL but goes fresh after ~4s', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-ttl-'));
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, 'V1\n');
    const rt = new ToolRuntime([...createFileTools(dir)], { workingDir: dir });
    const read = () => rt.execute({ id: 'c' + Math.random(), name: 'read_file', arguments: { path: f } } as any);
    try {
      expect(String(await read())).toContain('V1');
      fs.writeFileSync(f, 'V2\n'); // external change, no tool call
      expect(String(await read())).toContain('V1'); // within TTL → cached (dedup still works)
      await new Promise((r) => setTimeout(r, 4300)); // > 4s TTL, << 5min
      const after = String(await read());
      expect(after).toContain('V2'); // fresh; the old 5-min default would still be stale here
      expect(after).not.toContain('V1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('source guard: read_file, Grep, Glob all set a short cacheTtlMs', () => {
    const tools = path.resolve(__dirname, '..', '..', 'src', 'tools');
    expect(fs.readFileSync(path.join(tools, 'fileTools.ts'), 'utf8')).toMatch(/name: 'read_file',[\s\S]{0,600}cacheTtlMs: 4000/);
    expect(fs.readFileSync(path.join(tools, 'grepTools.ts'), 'utf8')).toMatch(/name: 'Grep',[\s\S]{0,600}cacheTtlMs: 4000/);
    expect(fs.readFileSync(path.join(tools, 'searchTools.ts'), 'utf8')).toMatch(/name: 'Glob',[\s\S]{0,600}cacheTtlMs: 4000/);
  });
});
