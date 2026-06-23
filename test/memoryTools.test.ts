import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryTools } from '../src/tools/memoryTools.js';

describe('memory tools', () => {
  let workingDir: string;
  let save: (a: Record<string, unknown>) => Promise<string>;
  let list: (a: Record<string, unknown>) => Promise<string>;
  let load: (a: Record<string, unknown>) => Promise<string>;
  let del: (a: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-mem-'));
    const tools = createMemoryTools(workingDir);
    save = tools.find((t) => t.name === 'memory_save')!.handler as never;
    list = tools.find((t) => t.name === 'memory_list')!.handler as never;
    load = tools.find((t) => t.name === 'memory_load')!.handler as never;
    del = tools.find((t) => t.name === 'memory_delete')!.handler as never;
  });
  afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

  it('saves, lists, and loads a memory entry', async () => {
    await save({ name: 'project_style', content: 'No emojis. TypeScript strict.', description: 'Coding style' });
    const ls = await list({});
    expect(ls).toContain('project_style');
    expect(ls).toContain('Coding style');
    const got = await load({ name: 'project_style' });
    expect(got).toContain('No emojis');
    expect(got).toContain('Coding style');
  });

  it('rebuilds the MEMORY.md index after each save', async () => {
    await save({ name: 'a', content: 'A body', description: 'a-desc' });
    await save({ name: 'b', content: 'B body', description: 'b-desc' });
    const index = readFileSync(join(workingDir, '.anvilwing', 'memory', 'MEMORY.md'), 'utf-8');
    expect(index).toContain('[a](./a.md)');
    expect(index).toContain('[b](./b.md)');
    expect(index).toContain('a-desc');
  });

  it('rejects names with path traversal or special characters', async () => {
    expect(await save({ name: '../etc/passwd', content: 'x' })).toContain('Error');
    expect(await save({ name: 'has space', content: 'x' })).toContain('Error');
    expect(await save({ name: 'has.dot', content: 'x' })).toContain('Error');
    expect(await save({ name: '', content: 'x' })).toContain('Error');
  });

  it('overwrites the same name on repeat save', async () => {
    await save({ name: 'note', content: 'first' });
    await save({ name: 'note', content: 'second' });
    const got = await load({ name: 'note' });
    expect(got).toContain('second');
    expect(got).not.toContain('first');
  });

  it('memory_load returns clear error for missing name', async () => {
    expect(await load({ name: 'never_saved' })).toContain('not found');
  });

  it('memory_delete removes the file and updates the index', async () => {
    await save({ name: 'temp', content: 'x' });
    expect(existsSync(join(workingDir, '.anvilwing', 'memory', 'temp.md'))).toBe(true);
    const out = await del({ name: 'temp' });
    expect(out).toContain('removed');
    expect(existsSync(join(workingDir, '.anvilwing', 'memory', 'temp.md'))).toBe(false);
    const index = readFileSync(join(workingDir, '.anvilwing', 'memory', 'MEMORY.md'), 'utf-8');
    expect(index).not.toContain('[temp](./temp.md)');
  });

  it('memory_list returns "no memories" before anything saved', async () => {
    expect(await list({})).toContain('No memories');
  });
});
