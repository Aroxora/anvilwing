/**
 * End-to-end through ToolRuntime: exercise each major tool family
 * (Edit, MultiEdit, memory_save/load, Skill, NotebookEdit) the way
 * the agent loop would. Each test runs the tool via runtime.execute
 * and asserts on the result.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRuntime } from '../src/core/toolRuntime.js';
import type { ToolDefinition } from '../src/core/toolRuntime.js';
import { createEditTools } from '../src/tools/editTools.js';
import { createMemoryTools } from '../src/tools/memoryTools.js';
import { createSkillTools } from '../src/tools/skillTools.js';
import { createNotebookTools } from '../src/tools/notebookTools.js';

function buildRuntime(workingDir: string): ToolRuntime {
  const tools: ToolDefinition[] = [
    ...createEditTools(workingDir),
    ...createMemoryTools(workingDir),
    ...createSkillTools(workingDir),
    ...createNotebookTools(workingDir),
  ];
  return new ToolRuntime(tools, { workingDir, enableCache: false });
}

describe('ToolRuntime tool-suite integration', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-tools-'));
  });
  afterEach(() => {
    try { rmSync(workingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Edit creates a file via empty old_string', async () => {
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'e1',
      name: 'Edit',
      arguments: { file_path: 'hello.txt', old_string: '', new_string: 'Hello, world!\n' },
    });
    expect(result).not.toMatch(/^Error/);
    expect(readFileSync(join(workingDir, 'hello.txt'), 'utf-8')).toBe('Hello, world!\n');
  });

  it('MultiEdit applies sequential edits atomically', async () => {
    writeFileSync(join(workingDir, 'src.txt'), 'apple banana cherry\n');
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'me1',
      name: 'MultiEdit',
      arguments: {
        file_path: 'src.txt',
        edits: [
          { old_string: 'apple', new_string: 'APPLE' },
          { old_string: 'cherry', new_string: 'CHERRY' },
        ],
      },
    });
    expect(result).not.toMatch(/^Error/);
    expect(readFileSync(join(workingDir, 'src.txt'), 'utf-8')).toBe('APPLE banana CHERRY\n');
  });

  it('MultiEdit rolls back if any edit fails', async () => {
    const original = 'apple banana\n';
    writeFileSync(join(workingDir, 'rollback.txt'), original);
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'me2',
      name: 'MultiEdit',
      arguments: {
        file_path: 'rollback.txt',
        edits: [
          { old_string: 'apple', new_string: 'APPLE' },
          // This won't match — should trigger rollback.
          { old_string: 'NOT-PRESENT', new_string: 'X' },
        ],
      },
    });
    expect(result).toMatch(/Error|not found|did not match|failed/i);
    // File restored to original.
    expect(readFileSync(join(workingDir, 'rollback.txt'), 'utf-8')).toBe(original);
  });

  it('memory_save then memory_load roundtrip', async () => {
    const runtime = buildRuntime(workingDir);
    const save = await runtime.execute({
      id: 'm1',
      name: 'memory_save',
      arguments: {
        name: 'project_notes',
        description: 'one-liner about the project',
        content: 'This is the body of the memory.',
      },
    });
    expect(save).not.toMatch(/^Error/);
    const load = await runtime.execute({
      id: 'm2',
      name: 'memory_load',
      arguments: { name: 'project_notes' },
    });
    expect(load).toContain('This is the body of the memory');
  });

  it('memory_save rejects path-traversal in name', async () => {
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'm3',
      name: 'memory_save',
      arguments: {
        name: '../../../etc/passwd',
        description: 'evil',
        content: 'pwn',
      },
    });
    expect(result).toMatch(/Error|invalid|name/i);
  });

  it('Skill loading: a project-local skill resolves', async () => {
    const skillDir = join(workingDir, '.anvilwing', 'skills', 'pirate-mode');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: pirate-mode\ndescription: speak like a pirate\n---\n\nArrr! Speak like a pirate matey.\n',
      'utf-8',
    );
    const runtime = buildRuntime(workingDir);
    const list = await runtime.execute({ id: 's1', name: 'list_skills', arguments: {} });
    expect(list).toContain('pirate-mode');
    const skill = await runtime.execute({
      id: 's2',
      name: 'Skill',
      arguments: { name: 'pirate-mode' },
    });
    expect(skill).toContain('Arrr');
  });

  it('Skill blocks unknown skill name with a useful error', async () => {
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 's3',
      name: 'Skill',
      arguments: { name: 'definitely-does-not-exist' },
    });
    expect(result).toMatch(/not found|unknown|no such/i);
  });

  it('NotebookEdit: replace mode rewrites a code cell + clears outputs', async () => {
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
      cells: [
        {
          cell_type: 'code',
          source: ['print("old")\n'],
          metadata: {},
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['old\n'] }],
          execution_count: 1,
        },
      ],
    };
    writeFileSync(join(workingDir, 'nb.ipynb'), JSON.stringify(nb));
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'n1',
      name: 'NotebookEdit',
      arguments: {
        notebook_path: 'nb.ipynb',
        cell_index: 0,
        new_source: 'print("new")\n',
      },
    });
    expect(result).not.toMatch(/^Error/);
    const updated = JSON.parse(readFileSync(join(workingDir, 'nb.ipynb'), 'utf-8'));
    const cell = updated.cells[0];
    const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
    expect(src).toContain('print("new")');
    expect(cell.outputs).toEqual([]);
    expect(cell.execution_count).toBeNull();
    expect(updated.metadata.kernelspec.name).toBe('python3');
  });

  it('NotebookEdit: insert mode adds a new cell at the right position', async () => {
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: 'code', source: 'first\n', metadata: {}, outputs: [], execution_count: null },
        { cell_type: 'code', source: 'third\n', metadata: {}, outputs: [], execution_count: null },
      ],
    };
    writeFileSync(join(workingDir, 'nb.ipynb'), JSON.stringify(nb));
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'n2',
      name: 'NotebookEdit',
      arguments: {
        notebook_path: 'nb.ipynb',
        cell_index: 1,
        new_source: 'second\n',
        mode: 'insert',
      },
    });
    expect(result).not.toMatch(/^Error/);
    const updated = JSON.parse(readFileSync(join(workingDir, 'nb.ipynb'), 'utf-8'));
    expect(updated.cells.length).toBe(3);
    const middle = Array.isArray(updated.cells[1].source) ? updated.cells[1].source.join('') : updated.cells[1].source;
    expect(middle).toContain('second');
  });

  it('NotebookEdit: invalid path rejected', async () => {
    const runtime = buildRuntime(workingDir);
    const result = await runtime.execute({
      id: 'n3',
      name: 'NotebookEdit',
      arguments: {
        notebook_path: 'does-not-exist.ipynb',
        cell_index: 0,
        new_source: 'x',
      },
    });
    expect(result).toMatch(/Error|not found|ENOENT/i);
  });

  it('Edit refuses to overwrite without read for existing file', async () => {
    writeFileSync(join(workingDir, 'existing.txt'), 'original line\n');
    const runtime = buildRuntime(workingDir);
    // Edit with a non-empty old_string that doesn't match should fail.
    const result = await runtime.execute({
      id: 'e2',
      name: 'Edit',
      arguments: {
        file_path: 'existing.txt',
        old_string: 'wrong line text',
        new_string: 'replaced',
      },
    });
    expect(result).toMatch(/Error|not found|did not match/i);
    // File unchanged.
    expect(readFileSync(join(workingDir, 'existing.txt'), 'utf-8')).toBe('original line\n');
  });
});
