/**
 * Parallel sub-agents surfaced as Claude Code-style Task notes.
 *
 * Pure note formatting is tested directly. The wiring is exercised against the
 * REAL built parallel_agents tool in a subprocess (agentSpawningWiring pulls in
 * the import.meta runtime graph, so it can't be imported under Jest's CJS
 * transform): the tool is registered, bad input is rejected without firing any
 * note, and a valid task fires notifySubAgent start→complete around the
 * sub-agent run (no API key → the sub-agent errors, but the lifecycle notes
 * still fire — exactly the path the UI renders). Source assertions lock the
 * contract events + the agent/controller/shell wiring.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatSubAgentStart, formatSubAgentComplete } from '../src/core/subAgentNote.js';

const REPO = resolve(__dirname, '..');
const CONTRACT = readFileSync(join(REPO, 'src', 'contracts', 'v1', 'agent.ts'), 'utf8');
const CONTROLLER = readFileSync(join(REPO, 'src', 'runtime', 'agentController.ts'), 'utf8');
const WIRING = readFileSync(join(REPO, 'src', 'runtime', 'agentSpawningWiring.ts'), 'utf8');
const SHELL = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');

describe('sub-agent note formatting (pure)', () => {
  it('start renders a Task(label) line', () => {
    expect(formatSubAgentStart('read config')).toBe('Task(read config)');
  });
  it('complete renders status + label + elapsed seconds', () => {
    expect(formatSubAgentComplete({ description: 'grep imports', success: true, elapsedMs: 1234 }))
      .toBe('✓ Task(grep imports) · 1.2s');
    expect(formatSubAgentComplete({ description: 'build index', success: false, elapsedMs: 0 }))
      .toBe('✗ Task(build index) · 0.0s');
  });
});

describe('parallel_agents wiring — REAL built tool, subprocess against dist', () => {
  it('registers the tool, rejects bad input silently, and fires start→complete per task', () => {
    const wiringDist = join(REPO, 'dist', 'runtime', 'agentSpawningWiring.js');
    if (!existsSync(wiringDist)) {
      throw new Error(`dist artifact missing: ${wiringDist}\nRun: npx tsc`);
    }

    const script = `
      const repo = ${JSON.stringify(REPO)};
      const { wireAgentSpawning } = await import(repo + '/dist/runtime/agentSpawningWiring.js');
      let suite = null;
      const session = { toolRuntime: { registerSuite: (s) => { suite = s; } } };
      const events = [];
      wireAgentSpawning({
        session, workingDir: repo,
        getSelection: () => ({ provider: 'anvilwing', model: 'anvilwing', temperature: 0, maxTokens: 100 }),
        notifySubAgent: (e) => events.push(e),
      });
      const tool = suite && suite.tools.find((t) => t.name === 'parallel_agents');
      const bad = await tool.handler({ tasks: 'not json' });
      const notifyAfterBad = events.length;
      await tool.handler({ tasks: JSON.stringify([{ id: 't1', description: 'read config', prompt: 'do x' }]) });
      process.stdout.write('PROBE ' + JSON.stringify({
        registered: !!tool,
        badIsError: /JSON parse failed|must be/.test(bad),
        notifyAfterBad,
        phases: events.map((e) => e.phase),
        startDesc: (events.find((e) => e.phase === 'start') || {}).description,
        completeSuccess: (events.find((e) => e.phase === 'complete') || {}).success,
      }));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO,
      env: { ...process.env, ANVILWING_API_KEY: '', ANVILWING_HOME: REPO, ANVILWING_SKIP_AUTH: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const line = out.split('\n').find((l) => l.startsWith('PROBE '));
    expect(line).toBeTruthy();
    const r = JSON.parse(line!.slice('PROBE '.length));
    expect(r.registered).toBe(true);
    expect(r.badIsError).toBe(true);
    expect(r.notifyAfterBad).toBe(0);          // bad input fires no Task notes
    expect(r.phases).toEqual(['start', 'complete']); // valid task: lifecycle surfaced
    expect(r.startDesc).toBe('read config');
    expect(r.completeSuccess).toBe(false);     // no key → sub-agent errors, still reported
  }, 70_000);
});

describe('sub-agent events — source wiring locked', () => {
  it('contract declares subagent.start / subagent.complete', () => {
    expect(CONTRACT).toMatch(/'subagent\.start'/);
    expect(CONTRACT).toMatch(/'subagent\.complete'/);
    expect(CONTRACT).toMatch(/interface SubAgentStartEvent/);
  });
  it('the spawning handler notifies on start and complete', () => {
    expect(WIRING).toMatch(/notifySubAgent\?\.\(\{ phase: 'start'/);
    expect(WIRING).toMatch(/phase: 'complete'/);
  });
  it('controller pushes subagent events to the sink', () => {
    expect(CONTROLLER).toMatch(/emitSubAgentEvent\(/);
    expect(CONTROLLER).toMatch(/type: 'subagent\.start'/);
    expect(CONTROLLER).toMatch(/type: 'subagent\.complete'/);
  });
  it('shell renders Task notes and suppresses the raw parallel_agents call', () => {
    expect(SHELL).toMatch(/case 'subagent\.start'/);
    expect(SHELL).toMatch(/formatSubAgentComplete\(/);
    expect(SHELL).toMatch(/toolName !== 'parallel_agents'/);
  });
});
