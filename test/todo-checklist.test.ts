/**
 * TodoWrite/TodoRead render as a Claude-Code checklist.
 *
 * Claude Code shows the actual task list under `⏺ Update Todos` — one
 * `☐`/`☒` line per task — not a "Todos updated" summary. For that to work
 * the structured `todos` array has to reach the result formatter, so the
 * fix is two-part:
 *
 *   1. `tool.complete` now carries the originating call's `parameters`
 *      (the contract + agentController emit).
 *   2. `formatToolResult` renders the checklist from `args.todos`
 *      (TodoWrite) or the parsed JSON result (TodoRead).
 *
 * Pure rendering is asserted directly. The end-to-end pipeline is exercised
 * against the REAL built dist: the real TodoWrite tool stores the list, and
 * the real `formatToolResult` turns the same args into the checklist a user
 * sees. Source assertions lock the wiring (contract field + controller emit +
 * shell read) so a future refactor that drops it fails CI.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderTodoChecklist, formatToolResult, RESULT_PREFIX } from '../src/shell/toolPresentation.js';

const REPO = resolve(__dirname, '..');
const CONTRACT = readFileSync(join(REPO, 'src', 'contracts', 'v1', 'agent.ts'), 'utf8');
const CONTROLLER = readFileSync(join(REPO, 'src', 'runtime', 'agentController.ts'), 'utf8');
const SHELL = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('renderTodoChecklist (pure)', () => {
  it('renders ☒ completed, ▸ in-progress (active), ☐ pending', () => {
    const out = renderTodoChecklist([
      { content: 'Set up the project', status: 'completed' },
      { content: 'Write the tests', status: 'in_progress' },
      { content: 'Run the suite', status: 'pending' },
    ]);
    expect(out).toBe(
      `${RESULT_PREFIX}☒ Set up the project\n     ▸ Write the tests\n     ☐ Run the suite`,
    );
  });

  it('the active step uses its gerund activeForm when present', () => {
    const out = renderTodoChecklist([
      { content: 'Wire the controller', status: 'in_progress', activeForm: 'Wiring the controller' },
    ]);
    expect(out).toBe(`${RESULT_PREFIX}▸ Wiring the controller`);
  });

  it('returns null for empty / non-array input so callers can fall back', () => {
    expect(renderTodoChecklist([])).toBeNull();
    expect(renderTodoChecklist(undefined)).toBeNull();
    expect(renderTodoChecklist('nope')).toBeNull();
    expect(renderTodoChecklist([{ status: 'pending' }])).toBeNull(); // no content
  });

  it('TodoWrite result is the checklist, not a "Todos updated" summary', () => {
    const args = { todos: [{ content: 'A', status: 'pending' }, { content: 'B', status: 'completed' }] };
    const out = formatToolResult('TodoWrite', 'plan text', args);
    expect(out).toBe(`${RESULT_PREFIX}☐ A\n     ☒ B`);
    expect(out).not.toContain('Todos updated');
  });
});

describe('wiring source assertions', () => {
  it('ToolCompleteEvent carries parameters', () => {
    expect(CONTRACT).toMatch(/type:\s*'tool\.complete'/);
    expect(CONTRACT).toMatch(/parameters\?:\s*Record<string,\s*unknown>/);
  });
  it('the controller emits parameters on tool.complete', () => {
    const block = CONTROLLER.slice(CONTROLLER.indexOf("type: 'tool.complete'"));
    expect(block).toMatch(/parameters:\s*\{\s*\.\.\.call\.arguments\s*\}/);
  });
  it('the shell passes the event parameters into formatToolResult', () => {
    expect(SHELL).toMatch(/const params = event\.parameters/);
    expect(SHELL).toMatch(/formatToolResult\(event\.toolName, event\.result, params\)/);
  });
});

describe('end-to-end against the real built dist', () => {
  it('the real TodoWrite tool + real formatToolResult produce the checklist', () => {
    const todoDist = join(REPO, 'dist', 'tools', 'todoTools.js');
    const presDist = join(REPO, 'dist', 'shell', 'toolPresentation.js');
    for (const p of [todoDist, presDist]) {
      if (!existsSync(p)) throw new Error(`dist artifact missing: ${p}\nRun: npx tsc`);
    }

    const script = `
      const repo = ${JSON.stringify(REPO)};
      const { createTodoTools } = await import(repo + '/dist/tools/todoTools.js');
      const { formatToolResult } = await import(repo + '/dist/shell/toolPresentation.js');
      const write = createTodoTools().find((t) => t.name === 'TodoWrite');
      const args = { todos: [
        { content: 'Explore the codebase', status: 'completed' },
        { content: 'Implement the feature', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' },
      ] };
      const result = await write.handler(args);
      // The shell hands the SAME args (carried on tool.complete) to the formatter.
      const rendered = formatToolResult('TodoWrite', result, args);
      process.stdout.write('PROBE ' + JSON.stringify({ rendered }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    const probe = JSON.parse(out.slice(out.indexOf('PROBE ') + 6)) as { rendered: string };
    expect(probe.rendered).toBe(
      `${RESULT_PREFIX}☒ Explore the codebase\n     ▸ Implement the feature\n     ☐ Run tests`,
    );
  });
});
