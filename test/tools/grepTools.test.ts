import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGrepTools } from '../../src/tools/grepTools.js';

describe('grepTools', () => {
  it('accepts alias flags without dashes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'grep-alias-'));
    const filePath = join(workspace, 'sample.txt');
    writeFileSync(filePath, 'Alpha\nbeta\n');

    const tools = createGrepTools(workspace);
    const grep = tools.find(tool => tool.name === 'Grep');
    expect(grep).toBeDefined();

    const result = await grep!.handler({
      pattern: 'alpha',
      path: workspace,
      output_mode: 'content',
      // Use aliases without dashes
      i: true,
      n: true,
    });

    expect(String(result)).toContain('sample.txt:1:Alpha');
  });

  it('searches a single FILE path (not just directories)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'grep-file-'));
    const filePath = join(workspace, 'only.ts');
    writeFileSync(filePath, 'const needle = 1;\nother line\n');
    writeFileSync(join(workspace, 'noise.ts'), 'needle elsewhere\n');

    const grep = createGrepTools(workspace).find((t) => t.name === 'Grep')!;
    // path points at a FILE — used to return "No matches found" (ENOTDIR).
    const result = String(await grep.handler({ pattern: 'needle', path: filePath, output_mode: 'content', n: true }));

    expect(result).toContain('only.ts:1:const needle = 1;');
    expect(result).not.toContain('noise.ts'); // scoped to the one file
    expect(result).not.toContain('No matches found');
  });
});
