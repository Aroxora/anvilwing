import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSearchTools } from '../src/tools/searchTools.js';

describe('Glob tool', () => {
  let workingDir: string;
  let glob: (a: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-glob-'));
    const tools = createSearchTools(workingDir);
    const tool = tools.find((t) => t.name === 'Glob');
    if (!tool) throw new Error('Glob tool not registered');
    glob = tool.handler as never;
  });
  afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

  function touch(rel: string, content = ''): void {
    const full = join(workingDir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  it('matches a simple **/*.ts pattern', async () => {
    touch('a.ts', '');
    touch('src/b.ts', '');
    touch('src/nested/c.ts', '');
    touch('docs/readme.md', '');
    const out = await glob({ pattern: '**/*.ts' });
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).toContain('c.ts');
    expect(out).not.toContain('readme.md');
  });

  it('respects head_limit', async () => {
    for (let i = 0; i < 30; i++) touch(`file${i}.ts`, '');
    const out = await glob({ pattern: '*.ts', head_limit: 5 });
    // Output should mention 5 explicitly or only contain 5 paths.
    const matches = (out.match(/file\d+\.ts/g) || []).length;
    expect(matches).toBeLessThanOrEqual(5);
  });

  it('rejects empty pattern', async () => {
    expect(await glob({ pattern: '' })).toContain('Error');
    expect(await glob({})).toContain('Error');
  });

  it('returns no matches for impossible pattern without crashing', async () => {
    touch('a.ts', '');
    const out = await glob({ pattern: '**/*.nonexistent-extension' });
    expect(typeof out).toBe('string');
  });

  it('honors a relative path subdirectory', async () => {
    touch('src/x.ts', '');
    touch('docs/y.ts', '');
    const out = await glob({ pattern: '**/*.ts', path: 'src' });
    expect(out).toContain('x.ts');
    expect(out).not.toContain('y.ts');
  });

  it('a directory-scoped glob does not match the same name in another directory', async () => {
    touch('src/app.ts', '');
    touch('web/src/app.ts', '');
    const out = await glob({ pattern: 'src/*.ts' });
    expect(out).toContain('src/app.ts');
    expect(out).not.toContain('web/src/app.ts'); // was a false match (no ^ anchor)
  });

  it('**/*.ts matches a direct child at the root, not just nested files', async () => {
    touch('root.ts', '');
    touch('deep/nested/file.ts', '');
    const out = await glob({ pattern: '**/*.ts' });
    expect(out).toContain('root.ts'); // was missed (globstar required a slash)
    expect(out).toContain('nested/file.ts');
  });
});
