/**
 * Regression: tool path resolution must respect platform-aware
 * absolute-path checks. The earlier `path.startsWith('/')` heuristic
 * was POSIX-only, so on Windows an absolute path like
 * `C:\Users\x\file.txt` slipped through and got `path.join`-ed onto
 * the working directory — producing the doubled
 * `C:\GitHub\milly\C:\GitHub\milly\.anvilwing\pinned-prompt.txt` we saw
 * in the user's trace.
 *
 * Tests run on whatever OS Jest is currently on, but the assertion is
 * cross-platform because we're checking that whatever path we hand to
 * the tool comes back unchanged when it's already absolute (using the
 * platform's native absolute form).
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools } from '../src/tools/fileTools.js';

describe('windows-style absolute-path resolution', () => {
  let workingDir: string;
  let absoluteFile: string;
  let readHandler: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-pathres-'));
    // The actual file lives OUTSIDE workingDir, at a platform-native
    // absolute path. If resolveFilePath joins this onto workingDir
    // we'll get a non-existent path and read_file will fail.
    const externalDir = mkdtempSync(join(tmpdir(), 'anvilwing-pathres-ext-'));
    absoluteFile = resolve(externalDir, 'sample.txt');
    writeFileSync(absoluteFile, 'sentinel-content', 'utf-8');

    const readTool = createFileTools(workingDir).find((t) => t.name === 'read_file');
    if (!readTool) throw new Error('read_file tool not found');
    readHandler = readTool.handler as (args: Record<string, unknown>) => Promise<string>;
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    try { rmSync(absoluteFile, { force: true }); } catch { /* ignore */ }
  });

  it('reads a file at a platform-absolute path without re-joining it onto cwd', async () => {
    expect(existsSync(absoluteFile)).toBe(true);
    const out = await readHandler({ path: absoluteFile });
    // The file's content shows up — proves the tool found the file at
    // the absolute path rather than at ${workingDir}/${absoluteFile}.
    expect(out).toContain('sentinel-content');
    // Negative assertion: the result must not echo a doubled path.
    expect(out).not.toContain(workingDir + absoluteFile);
  });

  it('still resolves relative paths against the working directory', async () => {
    const relName = 'rel.txt';
    writeFileSync(join(workingDir, relName), 'rel-content', 'utf-8');
    const out = await readHandler({ path: relName });
    expect(out).toContain('rel-content');
  });
});
