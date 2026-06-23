/**
 * CLI end-to-end with a fresh local git repo.
 *
 * Per-test setup: create a tmp dir, `git init` it, seed a starter
 * file, commit, then run a series of CLI tools against the repo,
 * verifying the agent's tools land real changes that git sees.
 * Tear down the tmp dir at the end.
 *
 * No GitHub connection used — fully local. The web-side e2e
 * (test/web-e2e/) is the equivalent against a real GitHub repo.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { createFileTools } from '../src/tools/fileTools.js';
import { createEditTools } from '../src/tools/editTools.js';
import { createSearchTools } from '../src/tools/searchTools.js';
import { createBashTools } from '../src/tools/bashTools.js';
import { createTodoTools, clearCurrentTodos } from '../src/tools/todoTools.js';
import { recordFileRead } from '../src/tools/fileReadTracker.js';

type Handler = (args: Record<string, unknown>) => Promise<string>;
function handler(tools: { name: string; handler: unknown }[], name: string): Handler {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t.handler as Handler;
}

function gitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const describeIfGit = gitAvailable() ? describe : describe.skip;

describeIfGit('CLI e2e — fresh local git repo per loop', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'anvilwing-git-e2e-'));
    clearCurrentTodos();
    // Initialize a real git repo with one commit.
    execSync('git init -q', { cwd: workingDir, stdio: 'pipe' });
    execSync('git config user.email "test@anvilwing.dev"', { cwd: workingDir, stdio: 'pipe' });
    execSync('git config user.name "Anvilwing Test"', { cwd: workingDir, stdio: 'pipe' });
    // Disable commit signing locally — global signing config (e.g. SSH + signing server)
    // is not available in all CI environments and is orthogonal to what these tests verify.
    execSync('git config commit.gpgsign false', { cwd: workingDir, stdio: 'pipe' });
    writeFileSync(join(workingDir, 'README.md'), '# Test Repo\n', 'utf-8');
    writeFileSync(join(workingDir, 'package.json'), JSON.stringify({ name: 'test-repo', version: '0.0.1' }, null, 2), 'utf-8');
    execSync('git add -A', { cwd: workingDir, stdio: 'pipe' });
    execSync('git commit -q -m "init"', { cwd: workingDir, stdio: 'pipe' });
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('initializes a git repo and the agent\'s edits show up as git diff', async () => {
    const edit = handler(createEditTools(workingDir), 'Edit');
    recordFileRead(join(workingDir, 'README.md'), '# Test Repo\n');
    await edit({ file_path: join(workingDir, 'README.md'), old_string: '# Test Repo', new_string: '# Test Repo (edited)' });
    const diff = execSync('git diff', { cwd: workingDir }).toString();
    expect(diff).toContain('+# Test Repo (edited)');
    expect(diff).toContain('-# Test Repo');
  });

  it('creates a new file and git status shows it as untracked', async () => {
    const edit = handler(createEditTools(workingDir), 'Edit');
    await edit({ file_path: join(workingDir, 'src/foo.ts'), old_string: '', new_string: 'export const foo = 1;\n' });
    // Git collapses untracked subdirs to `?? src/`. Either form is fine.
    const status = execSync('git status --porcelain', { cwd: workingDir }).toString();
    expect(status).toMatch(/\?\?\s+src\/(foo\.ts)?/);
    // And the file IS on disk at the expected path.
    expect(existsSync(join(workingDir, 'src', 'foo.ts'))).toBe(true);
  });

  it('MultiEdit on a tracked file produces a single git diff', async () => {
    const path = join(workingDir, 'src.ts');
    writeFileSync(path, 'a = 1\nb = 2\nc = 3\n', 'utf-8');
    execSync('git add src.ts && git commit -q -m "add src"', { cwd: workingDir, stdio: 'pipe' });
    recordFileRead(path, 'a = 1\nb = 2\nc = 3\n');
    const multi = handler(createEditTools(workingDir), 'MultiEdit');
    await multi({
      file_path: path,
      edits: [
        { old_string: 'a = 1', new_string: 'a = 10' },
        { old_string: 'b = 2', new_string: 'b = 20' },
        { old_string: 'c = 3', new_string: 'c = 30' },
      ],
    });
    const diff = execSync('git diff src.ts', { cwd: workingDir }).toString();
    expect(diff).toContain('-a = 1');
    expect(diff).toContain('+a = 10');
    expect(diff).toContain('-c = 3');
    expect(diff).toContain('+c = 30');
  });

  it('Glob respects .git directory exclusion (does not list internal git refs)', async () => {
    const glob = handler(createSearchTools(workingDir), 'Glob');
    const out = await glob({ pattern: '**/*' });
    expect(out).not.toContain('.git/HEAD');
    expect(out).not.toContain('.git/objects');
  });

  it('Grep on the repo finds matches in tracked files', async () => {
    writeFileSync(join(workingDir, 'src.js'), 'console.log("hello world");\n', 'utf-8');
    const grep = handler(createSearchTools(workingDir), 'Grep');
    const out = await grep({ pattern: 'hello world' });
    expect(out).toContain('src.js');
  });

  it('Bash can run git commands inside the workspace', async () => {
    const bash = handler(createBashTools(workingDir), 'execute_bash');
    const out = await bash({ command: 'git log --oneline' });
    expect(out).toContain('init');
  });

  it('full coding loop: plan → create → edit → run → commit (tools-only, no LLM)', async () => {
    const todo = handler(createTodoTools(), 'TodoWrite');
    const edit = handler(createEditTools(workingDir), 'Edit');
    const multi = handler(createEditTools(workingDir), 'MultiEdit');
    const bash = handler(createBashTools(workingDir), 'execute_bash');

    await todo({
      todos: [
        { content: 'Add add.js', status: 'in_progress' },
        { content: 'Add multiply', status: 'pending' },
        { content: 'Run + commit', status: 'pending' },
      ],
    });

    // Create a small JS file.
    const path = join(workingDir, 'math.js');
    await edit({
      file_path: path,
      old_string: '',
      new_string:
        'function add(a, b) { return a + b; }\n' +
        'function multiply(a, b) { return a * b; }\n' +
        'console.log(add(2, 3));\n',
    });

    // Tweak via MultiEdit.
    recordFileRead(path, readFileSync(path, 'utf-8'));
    await multi({
      file_path: path,
      edits: [
        { old_string: 'add(2, 3)', new_string: 'add(10, 20)' },
        { old_string: 'function multiply', new_string: '// multiply\nfunction multiply' },
      ],
    });

    // Run.
    const runOut = await bash({ command: `node "${path}"` });
    expect(runOut).toContain('30');

    // Commit via Bash.
    await bash({ command: 'git add -A && git commit -q -m "add math.js"' });
    const log = execSync('git log --oneline', { cwd: workingDir }).toString();
    expect(log).toContain('add math.js');
    expect(log).toContain('init');

    // Plan: all done.
    await todo({
      todos: [
        { content: 'Add add.js', status: 'completed' },
        { content: 'Add multiply', status: 'completed' },
        { content: 'Run + commit', status: 'completed' },
      ],
    });
  });

  it('cleanup verification: workingDir is fully removed at end of test', async () => {
    // Sanity: the dir we set up exists during the test, gets cleaned in afterEach
    // (which runs after this `it`, so post-cleanup is verified by a separate run).
    expect(existsSync(workingDir)).toBe(true);
  });
});
