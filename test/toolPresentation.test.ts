/**
 * toolPresentation — the pure formatters that give the shell its Claude-Code
 * transcript shape (`⏺ Tool(arg)` / `  ⎿  summary`). Covers both naming
 * conventions (PascalCase + Anvilwing snake_case), the editTools passthrough,
 * emoji-freeness, and result summarisation / overflow.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatToolCall,
  toolActivityLabel,
  formatToolResult,
  formatToolError,
  ACTION_BULLET,
  RESULT_PREFIX,
} from '../src/shell/toolPresentation.js';
import { createFileTools } from '../src/tools/fileTools.js';

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{2190}-\u{21FF}⭐✨]/u;

describe('formatToolCall — ⏺ Name(arg)', () => {
  it('renders Read with a basename', () => {
    expect(formatToolCall('Read', { file_path: 'fibonacci.py' })).toBe('⏺ Read(fibonacci.py)');
  });

  it('maps Anvilwing snake_case read_file → Read', () => {
    expect(formatToolCall('read_file', { path: '/x/y/quicksort.js' })).toBe('⏺ Read(quicksort.js)');
  });

  it('maps execute_bash → Bash with the command', () => {
    expect(formatToolCall('execute_bash', { command: 'python3 fibonacci.py' })).toBe('⏺ Bash(python3 fibonacci.py)');
  });

  it('maps Edit → Update', () => {
    expect(formatToolCall('Edit', { file_path: 'src/app.ts' }, 'src')).toContain('⏺ Update(');
  });

  it('quotes a web search query and drops the emoji', () => {
    const out = formatToolCall('WebSearch', { query: 'trump latest news' });
    expect(out).toBe('⏺ Web Search("trump latest news")');
    expect(out).not.toMatch(EMOJI);
  });

  it('opens every call with the action bullet and no [brackets]', () => {
    const out = formatToolCall('WebFetch', { url: 'https://apnews.com/hub/donald-trump' });
    expect(out.startsWith(`${ACTION_BULLET} `)).toBe(true);
    expect(out).not.toContain('[');
  });
});

describe('toolActivityLabel — spinner text, emoji-free', () => {
  it('describes the action in present tense without emoji', () => {
    expect(toolActivityLabel('Read', { file_path: 'a.py' })).toBe('Reading a.py');
    expect(toolActivityLabel('WebSearch', { query: 'x' })).toBe('Searching the web');
    expect(toolActivityLabel('execute_bash', { command: 'ls' })).not.toMatch(EMOJI);
  });
});

describe('formatToolResult — dim ⎿ block', () => {
  it('summarises a Read as a line count', () => {
    const res = 'File: fibonacci.py (38 lines)\n   1  x';
    expect(formatToolResult('Read', res, undefined)).toBe(`${RESULT_PREFIX}Read 38 lines`);
  });

  it('shows compact bash output and strips the FAILED decoration', () => {
    const res = '═══ FAILED ═══\n\nCommand failed with exit code 127\n\nCommand: python x\n\nOutput:\n/bin/bash: python: command not found\n\nSuggested actions:\n  → Review the error';
    const out = formatToolResult('execute_bash', res, undefined);
    expect(out).toContain('command not found');
    expect(out).not.toContain('═══');
    expect(out).not.toContain('Suggested actions');
    expect(out.startsWith(RESULT_PREFIX)).toBe(true);
  });

  it('passes an editTools ⏺ block through, stripping the duplicate header', () => {
    const res = '⏺ Update(app.ts)\n  ⎿  Updated app.ts with 3 additions and 1 removal';
    expect(formatToolResult('Edit', res, undefined)).toBe('  ⎿  Updated app.ts with 3 additions and 1 removal');
  });

  it('collapses long output with a ctrl+o overflow note', () => {
    const res = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = formatToolResult('Bash', res, undefined);
    expect(out).toContain('… +15 lines (ctrl+o to expand)');
  });
});

describe('formatToolError — red ⎿ Error line', () => {
  it('renders a single-line ⎿ Error', () => {
    expect(formatToolError('Tavily API error: 401\n<details>')).toBe(`${RESULT_PREFIX}Error: Tavily API error: 401`);
  });
});

describe('TodoRead vs TodoWrite — separate display names', () => {
  it('TodoRead shows "Read Todos", not "Update Todos"', () => {
    expect(formatToolCall('TodoRead', {})).toBe('⏺ Read Todos');
  });

  it('TodoWrite still shows "Update Todos"', () => {
    expect(formatToolCall('TodoWrite', {})).toBe('⏺ Update Todos');
  });

  it('TodoRead spinner label is "Reading todos"', () => {
    expect(toolActivityLabel('TodoRead', {})).toBe('Reading todos');
  });

  it('TodoWrite spinner label is "Updating todos"', () => {
    expect(toolActivityLabel('TodoWrite', {})).toBe('Updating todos');
  });

  it('TodoRead result with no todos shows "No todos"', () => {
    const result = 'No todos. Use TodoWrite to create a plan.';
    expect(formatToolResult('TodoRead', result, undefined)).toBe(`${RESULT_PREFIX}No todos`);
  });

  it('TodoRead result renders the checklist from JSON (☐/☒ lines)', () => {
    const todos = JSON.stringify([
      { content: 'Task A', status: 'pending' },
      { content: 'Task B', status: 'in_progress' },
      { content: 'Task C', status: 'completed' },
    ]);
    expect(formatToolResult('TodoRead', todos, undefined)).toBe(
      `${RESULT_PREFIX}☐ Task A\n     ▸ Task B\n     ☒ Task C`,
    );
  });

  it('TodoWrite renders the checklist from the call parameters', () => {
    const args = {
      todos: [
        { content: 'Set up the project', status: 'completed' },
        { content: 'Write the tests', status: 'in_progress' },
        { content: 'Run the suite', status: 'pending' },
      ],
    };
    expect(formatToolResult('TodoWrite', 'plan text', args)).toBe(
      `${RESULT_PREFIX}☒ Set up the project\n     ▸ Write the tests\n     ☐ Run the suite`,
    );
  });

  it('TodoWrite falls back to "Todos updated" when no parameters reach the formatter', () => {
    expect(formatToolResult('TodoWrite', 'plan text', undefined)).toBe(`${RESULT_PREFIX}Todos updated`);
  });
});

// Drives the REAL read tool against REAL files on disk (no mocked output) so the
// summariser is verified against the exact header strings fileTools emits.
describe('formatToolResult — Read line count (real read tool)', () => {
  let dir: string;
  let readHandler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eros-read-'));
    const read = createFileTools(dir).find((t) => t.name === 'read_file');
    if (!read) throw new Error('read_file tool not found');
    readHandler = read.handler as typeof readHandler;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, lineCount: number): string {
    const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
    writeFileSync(join(dir, name), content, 'utf-8');
    return name;
  }

  it('whole-file read reports the file total', async () => {
    const p = write('whole.txt', 38);
    const out = String(await readHandler({ path: p }));
    expect(out).toMatch(/\(38 lines\)/); // confirm the real header shape
    expect(formatToolResult('read_file', out, { path: p })).toBe(`${RESULT_PREFIX}Read 38 lines`);
  });

  it('ranged read reports the window size, not the file total or output height', async () => {
    const p = write('big.txt', 200);
    const out = String(await readHandler({ path: p, offset: 5, limit: 41 }));
    expect(out).toMatch(/\(lines 5-45 of 200\)/); // confirm the real ranged header
    // 41 lines in the window. Pre-fix this returned "Read 43 lines" (header +
    // blank + 41 numbered output rows) — a real, user-visible miscount.
    expect(formatToolResult('read_file', out, { path: p })).toBe(`${RESULT_PREFIX}Read 41 lines`);
  });

  it('single-line window reads "Read 1 line" (singular)', async () => {
    const p = write('one.txt', 50);
    const out = String(await readHandler({ path: p, offset: 7, limit: 1 }));
    expect(formatToolResult('read_file', out, { path: p })).toBe(`${RESULT_PREFIX}Read 1 line`);
  });

  it('window clamped at EOF reports only the lines actually returned', async () => {
    const p = write('tail.txt', 30);
    // Ask for 100 lines starting at 25 → only 6 lines exist (25..30).
    const out = String(await readHandler({ path: p, offset: 25, limit: 100 }));
    expect(formatToolResult('read_file', out, { path: p })).toBe(`${RESULT_PREFIX}Read 6 lines`);
  });

  it('read_files (plural) header surfaces the file count', async () => {
    const a = write('a.txt', 3);
    const b = write('b.txt', 4);
    const readFiles = createFileTools(dir).find((t) => t.name === 'read_files');
    const out = String(await (readFiles!.handler as typeof readHandler)({ paths: [a, b] }));
    expect(formatToolResult('read_files', out, { paths: [a, b] })).toBe(`${RESULT_PREFIX}Read 2 files`);
  });

  it('source guard: the summariser parses the ranged-read header', () => {
    // A future refactor that drops the ranged branch and reverts to a bare
    // `(\d+) lines` regex would silently reintroduce the miscount.
    const src = readFileSync(resolve(__dirname, '../src/shell/toolPresentation.ts'), 'utf-8');
    expect(src).toMatch(/lines\\s\+\(\\d\+\)-\(\\d\+\)\\s\+of/);
  });
});
