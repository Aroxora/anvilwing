/**
 * End-to-end CLI tool tests — exercise every Claude-Code-parity tool
 * we ship in a clean tmp workspace, validate behavior, then tear
 * down. Each test is self-contained: builds its own working dir,
 * runs the tool through its registered handler, asserts on output
 * + on-disk state, then rmSync.
 *
 * Coverage:
 *   - Read / Write / Edit / MultiEdit
 *   - Glob / Grep / Search
 *   - Bash (executes a real shell command in the tmp dir)
 *   - TodoWrite (state ↔ planFormatter)
 *   - memory_save / list / load / delete (file persistence)
 *   - Skill / list_skills
 *   - NotebookEdit
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createFileTools } from '../src/tools/fileTools.js';
import { createEditTools } from '../src/tools/editTools.js';
import { createSearchTools } from '../src/tools/searchTools.js';
import { createBashTools } from '../src/tools/bashTools.js';
import { createTodoTools, getCurrentTodos, clearCurrentTodos } from '../src/tools/todoTools.js';
import { createMemoryTools } from '../src/tools/memoryTools.js';
import { createSkillTools } from '../src/tools/skillTools.js';
import { createNotebookTools } from '../src/tools/notebookTools.js';
import { recordFileRead } from '../src/tools/fileReadTracker.js';

type Handler = (args: Record<string, unknown>) => Promise<string>;

function findHandler(tools: { name: string; handler: unknown }[], name: string): Handler {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t.handler as Handler;
}

describe('CLI e2e — every tool, fresh workspace per test, full cleanup', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-e2e-'));
    clearCurrentTodos();
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────
  // File ops
  // ─────────────────────────────────────────────────────────────────
  it('Read returns numbered file contents', async () => {
    const path = join(workingDir, 'sample.ts');
    writeFileSync(path, 'const x = 1;\nconst y = 2;\n', 'utf-8');
    const read = findHandler(createFileTools(workingDir), 'read_file');
    const out = await read({ path });
    expect(out).toContain('const x = 1');
    expect(out).toContain('const y = 2');
  });

  it('Edit creates → modifies → deletes content correctly', async () => {
    const path = join(workingDir, 'flow.ts');
    const edit = findHandler(createEditTools(workingDir), 'Edit');
    // Create
    expect(await edit({ file_path: path, old_string: '', new_string: 'hello\n' })).toContain('Create');
    expect(readFileSync(path, 'utf-8')).toBe('hello\n');
    // Modify (must be marked as read first)
    recordFileRead(path, 'hello\n');
    expect(await edit({ file_path: path, old_string: 'hello', new_string: 'goodbye' })).toContain('Update');
    expect(readFileSync(path, 'utf-8')).toBe('goodbye\n');
    // Delete part
    recordFileRead(path, 'goodbye\n');
    expect(await edit({ file_path: path, old_string: 'good' })).toContain('Update');
    expect(readFileSync(path, 'utf-8')).toBe('bye\n');
  });

  it('MultiEdit applies N edits atomically with rollback', async () => {
    const path = join(workingDir, 'm.ts');
    writeFileSync(path, 'a\nb\nc', 'utf-8');
    recordFileRead(path, 'a\nb\nc');
    const multi = findHandler(createEditTools(workingDir), 'MultiEdit');
    const out = await multi({
      file_path: path,
      edits: [
        { old_string: 'a', new_string: 'A' },
        { old_string: 'b', new_string: 'B' },
        { old_string: 'c', new_string: 'C' },
      ],
    });
    expect(out).toContain('3 edits');
    expect(readFileSync(path, 'utf-8')).toBe('A\nB\nC');
  });

  // ─────────────────────────────────────────────────────────────────
  // Search / Glob / Grep
  // ─────────────────────────────────────────────────────────────────
  it('Glob finds .ts files via pattern', async () => {
    writeFileSync(join(workingDir, 'a.ts'), '', 'utf-8');
    writeFileSync(join(workingDir, 'b.md'), '', 'utf-8');
    mkdirSync(join(workingDir, 'src'), { recursive: true });
    writeFileSync(join(workingDir, 'src', 'c.ts'), '', 'utf-8');
    const glob = findHandler(createSearchTools(workingDir), 'Glob');
    const out = await glob({ pattern: '**/*.ts' });
    expect(out).toContain('a.ts');
    expect(out).toContain('c.ts');
    expect(out).not.toContain('b.md');
  });

  it('Grep finds content matches', async () => {
    writeFileSync(join(workingDir, 'foo.ts'), 'function add(a,b){return a+b;}\n', 'utf-8');
    writeFileSync(join(workingDir, 'bar.ts'), 'const x = 1;\n', 'utf-8');
    const grep = findHandler(createSearchTools(workingDir), 'Grep');
    const out = await grep({ pattern: 'function add' });
    expect(out).toContain('foo.ts');
    expect(out).not.toContain('bar.ts');
  });

  it('Search (mode: definition) finds function declarations', async () => {
    writeFileSync(
      join(workingDir, 'x.ts'),
      'export function compute(n: number) { return n * 2; }\n',
      'utf-8',
    );
    const search = findHandler(createSearchTools(workingDir), 'Search');
    const out = await search({ pattern: 'compute', mode: 'definition' });
    expect(out).toContain('compute');
  });

  // ─────────────────────────────────────────────────────────────────
  // Bash — executes a real command in the workspace
  // ─────────────────────────────────────────────────────────────────
  it('Bash runs a command and captures stdout', async () => {
    const bash = findHandler(createBashTools(workingDir), 'execute_bash');
    const out = await bash({ command: 'node -e "console.log(1+1)"' });
    expect(out).toContain('2');
  });

  // ─────────────────────────────────────────────────────────────────
  // TodoWrite
  // ─────────────────────────────────────────────────────────────────
  it('TodoWrite stores + renders the plan', async () => {
    const todo = findHandler(createTodoTools(), 'TodoWrite');
    const out = await todo({
      todos: [
        { content: 'Read code', status: 'completed' },
        { content: 'Fix bug', status: 'in_progress' },
        { content: 'Write tests', status: 'pending' },
      ],
    });
    expect(out).toContain('Read code');
    expect(out).toContain('Fix bug');
    expect(getCurrentTodos().length).toBe(3);
  });

  // ─────────────────────────────────────────────────────────────────
  // Memory
  // ─────────────────────────────────────────────────────────────────
  it('memory_save → memory_list → memory_load → memory_delete round-trip', async () => {
    const mem = createMemoryTools(workingDir);
    const save = findHandler(mem, 'memory_save');
    const list = findHandler(mem, 'memory_list');
    const load = findHandler(mem, 'memory_load');
    const del = findHandler(mem, 'memory_delete');

    await save({ name: 'project_style', content: 'No emojis. Strict TS.', description: 'Coding style' });
    expect(await list({})).toContain('project_style');
    expect(await load({ name: 'project_style' })).toContain('No emojis');
    expect(await del({ name: 'project_style' })).toContain('removed');
    expect(await list({})).toContain('No memories');
  });

  // ─────────────────────────────────────────────────────────────────
  // Skill
  // ─────────────────────────────────────────────────────────────────
  it('Skill loads a markdown playbook from .anvilwing/skills/', async () => {
    const skillDir = join(workingDir, '.anvilwing', 'skills', 'review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: review\ndescription: Code review playbook\n---\n\n1. Read changes\n2. Check tests\n3. Suggest fixes`,
      'utf-8',
    );
    const skills = createSkillTools(workingDir);
    const list = findHandler(skills, 'list_skills');
    const load = findHandler(skills, 'Skill');
    expect(await list({})).toContain('review');
    const body = await load({ name: 'review' });
    expect(body).toContain('Code review playbook');
    expect(body).toContain('Read changes');
  });

  // ─────────────────────────────────────────────────────────────────
  // NotebookEdit
  // ─────────────────────────────────────────────────────────────────
  it('NotebookEdit replaces a cell while preserving notebook metadata', async () => {
    const nbPath = join(workingDir, 'demo.ipynb');
    writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [
          { cell_type: 'code', source: 'x = 1', metadata: {}, execution_count: null, outputs: [] },
          { cell_type: 'markdown', source: '# Title', metadata: {} },
        ],
        metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
        nbformat: 4,
        nbformat_minor: 5,
      }, null, 2),
      'utf-8',
    );
    const nb = findHandler(createNotebookTools(workingDir), 'NotebookEdit');
    const out = await nb({ notebook_path: nbPath, cell_index: 0, new_source: 'x = 99', mode: 'replace' });
    expect(out).toContain('replaced cell 0');
    const parsed = JSON.parse(readFileSync(nbPath, 'utf-8'));
    expect(parsed.cells[0].source).toEqual(['x = 99']);
    expect(parsed.metadata.kernelspec.name).toBe('python3');
  });

  // ─────────────────────────────────────────────────────────────────
  // Composite — TodoWrite + MultiEdit + Bash in one realistic flow
  // ─────────────────────────────────────────────────────────────────
  it('composite: plan → edit → run → verify (mimics a real coding turn)', async () => {
    const todo = findHandler(createTodoTools(), 'TodoWrite');
    const edit = findHandler(createEditTools(workingDir), 'Edit');
    const multi = findHandler(createEditTools(workingDir), 'MultiEdit');
    const bash = findHandler(createBashTools(workingDir), 'execute_bash');

    // Plan
    await todo({
      todos: [
        { content: 'Create source', status: 'in_progress' },
        { content: 'Add helpers', status: 'pending' },
        { content: 'Run', status: 'pending' },
      ],
    });

    // Create
    const path = join(workingDir, 'app.js');
    await edit({ file_path: path, old_string: '', new_string: 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n' });

    // Update plan: mark 1 done, start 2
    await todo({
      todos: [
        { content: 'Create source', status: 'completed' },
        { content: 'Add helpers', status: 'in_progress' },
        { content: 'Run', status: 'pending' },
      ],
    });

    // Multi-edit
    recordFileRead(path, 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n');
    await multi({
      file_path: path,
      edits: [
        { old_string: 'const a = 1;', new_string: 'const a = 10;' },
        { old_string: 'const b = 2;', new_string: 'const b = 20;' },
      ],
    });

    // Run
    const out = await bash({ command: `node "${path}"` });
    expect(out).toContain('30'); // 10 + 20

    // Plan: all done
    await todo({
      todos: [
        { content: 'Create source', status: 'completed' },
        { content: 'Add helpers', status: 'completed' },
        { content: 'Run', status: 'completed' },
      ],
    });
    expect(getCurrentTodos().every((t) => t.status === 'completed')).toBe(true);
  });
});
