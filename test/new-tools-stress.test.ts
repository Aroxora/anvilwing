/**
 * Cross-tool stress: exercise the recently-added tools (TodoWrite,
 * MultiEdit, memory, Glob, WebFetch, hooks) under interleaved
 * patterns to surface latent bugs.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTodoTools, getCurrentTodos, clearCurrentTodos } from '../src/tools/todoTools.js';
import { createMemoryTools } from '../src/tools/memoryTools.js';
import { createEditTools } from '../src/tools/editTools.js';
import { createSearchTools } from '../src/tools/searchTools.js';

describe('new-tools cross-stress', () => {
  let workingDir: string;
  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-stress-'));
    clearCurrentTodos();
  });
  afterEach(() => rmSync(workingDir, { recursive: true, force: true }));

  it('TodoWrite state survives many sequential rewrites', async () => {
    const todo = createTodoTools().find((t) => t.name === 'TodoWrite')!;
    const handler = todo.handler as (a: Record<string, unknown>) => Promise<string>;
    for (let i = 0; i < 50; i++) {
      await handler({
        todos: [
          { content: `task ${i}.a`, status: 'completed' },
          { content: `task ${i}.b`, status: 'in_progress' },
          { content: `task ${i}.c`, status: 'pending' },
        ],
      });
    }
    const final = getCurrentTodos();
    expect(final.length).toBe(3);
    expect(final[0].content).toBe('task 49.a');
  });

  it('memory tools handle 100 saves + 100 loads without corruption', async () => {
    const mem = createMemoryTools(workingDir);
    const save = mem.find((t) => t.name === 'memory_save')!.handler as never;
    const load = mem.find((t) => t.name === 'memory_load')!.handler as never;
    const list = mem.find((t) => t.name === 'memory_list')!.handler as never;
    for (let i = 0; i < 100; i++) {
      await save({
        name: `entry_${i}`,
        content: `body for entry ${i}`,
        description: `desc ${i}`,
      });
    }
    const ls = await list({});
    expect(ls).toContain('entry_0');
    expect(ls).toContain('entry_99');
    for (let i = 0; i < 100; i++) {
      const got = await load({ name: `entry_${i}` });
      expect(got).toContain(`body for entry ${i}`);
    }
  });

  it('memory_save with the SAME name 50 times stays consistent', async () => {
    const mem = createMemoryTools(workingDir);
    const save = mem.find((t) => t.name === 'memory_save')!.handler as never;
    const load = mem.find((t) => t.name === 'memory_load')!.handler as never;
    for (let i = 0; i < 50; i++) {
      await save({ name: 'shared', content: `iteration ${i}`, description: `v${i}` });
    }
    const got = await load({ name: 'shared' });
    expect(got).toContain('iteration 49');
    expect(got).not.toContain('iteration 0\n'); // overwritten
  });

  it('MultiEdit followed by another MultiEdit on same file is consistent', async () => {
    const tools = createEditTools(workingDir);
    const multi = tools.find((t) => t.name === 'MultiEdit')!.handler as (a: Record<string, unknown>) => Promise<string>;
    const filePath = join(workingDir, 'src.ts');
    writeFileSync(filePath, 'a\nb\nc\nd\ne', 'utf-8');
    // Mark the file as read.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const tracker: any = require('../src/tools/fileReadTracker.js');
    tracker.recordFileRead(filePath, 'a\nb\nc\nd\ne');

    await multi({
      file_path: filePath,
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'c', new_string: 'C' },
      ],
    });
    // Re-mark as read after the edit.
    tracker.recordFileRead(filePath, readFileSync(filePath, 'utf-8'));
    await multi({
      file_path: filePath,
      edits: [
        { old_string: 'b', new_string: 'B' },
        { old_string: 'e', new_string: 'E' },
      ],
    });
    const final = readFileSync(filePath, 'utf-8');
    expect(final).toBe('A\nB\nC\nd\nE');
  });

  it('Glob from a non-existent path returns no matches without throwing', async () => {
    const tools = createSearchTools(workingDir);
    const glob = tools.find((t) => t.name === 'Glob')!.handler as never;
    const out = await glob({ pattern: '**/*.ts', path: 'does/not/exist' });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('Glob on workingDir with deep nesting (5 levels) finds everything', async () => {
    const tools = createSearchTools(workingDir);
    const glob = tools.find((t) => t.name === 'Glob')!.handler as never;
    // Build src/a/b/c/d/e.ts
    writeFileSync(join(workingDir, 'top.ts'), '', 'utf-8');
    const deep = ['lvl1', 'lvl2', 'lvl3', 'lvl4', 'lvl5'];
    let p = workingDir;
    for (const d of deep) {
      p = join(p, d);
      // mkdir if needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').mkdirSync(p, { recursive: true });
    }
    writeFileSync(join(p, 'deep.ts'), '', 'utf-8');
    const out = await glob({ pattern: '**/*.ts' });
    expect(out).toContain('top.ts');
    expect(out).toContain('deep.ts');
  });
});
