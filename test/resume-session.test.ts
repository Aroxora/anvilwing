/**
 * /resume — restore a saved conversation into the agent's context.
 *
 * The feasibility hinge (per the loop rule "FIRST verify the agent can
 * actually reload a saved session's message history into context") is proven
 * here against the REAL AgentController + real sessionStore on disk: save a
 * conversation, load it by id, call controller.loadHistory, and assert
 * getHistory() returns the full thread (including a unique marker) — no mocks
 * for the thing under test, no LLM round-trip needed because the claim is
 * about the message array the agent will send, not generation.
 *
 * Source assertions lock the shell wiring (/resume handler, autosave,
 * loadHistory call, transcript reprint) and the controller's loadHistory
 * (sets cachedHistory + sanitizes) so a future refactor that drops them
 * fails at CI time.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { relativeTime } from '../src/core/relativeTime.js';

const REPO = resolve(__dirname, '..');
const SHELL = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');
const CONTROLLER = readFileSync(join(REPO, 'src', 'runtime', 'agentController.ts'), 'utf8');

// The controller's dep graph uses import.meta (real ESM), which Jest's CJS
// transform can't parse — so this round-trip runs against the BUILT dist in a
// real node subprocess (same artifact the binary loads). Plain node, no PTY,
// so it runs in CI too.
describe('/resume — controller restores a saved session into context (real built artifact)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'anvilwing-resume-'));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loadHistory hydrates controller.getHistory() with the saved thread', () => {
    const controllerDist = join(REPO, 'dist', 'runtime', 'agentController.js');
    if (!existsSync(controllerDist)) {
      throw new Error(`dist artifact missing: ${controllerDist}\nRun: npx tsc`);
    }

    const script = `
      const repo = ${JSON.stringify(REPO)};
      const { saveSessionSnapshot, loadSessionById } = await import(repo + '/dist/core/sessionStore.js');
      const { createAgentController } = await import(repo + '/dist/runtime/agentController.js');
      const messages = [
        { role: 'system', content: 'You are a coding agent.' },
        { role: 'user', content: 'remember the secret code BANANA42' },
        { role: 'assistant', content: 'Understood — the secret code is BANANA42.' },
      ];
      const summary = saveSessionSnapshot({ profile: 'anvilwing-code', provider: 'anvilwing', model: 'anvilwing', workspaceRoot: process.env.ANVILWING_DATA_DIR, messages, title: 'remember the secret code BANANA42' });
      const stored = loadSessionById(summary.id);
      const controller = await createAgentController({ profile: 'anvilwing-code', workspaceContext: null, workingDir: process.env.ANVILWING_DATA_DIR, skipProviderDiscovery: true });
      const before = controller.getHistory().length;
      controller.loadHistory(stored.messages);
      const after = controller.getHistory();
      process.stdout.write('PROBE ' + JSON.stringify({ storedLen: stored.messages.length, before, afterRoles: after.map(m => m.role), hasMarker: after.some(m => /BANANA42/.test(m.content)) }));
    `;

    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: REPO,
      env: { ...process.env, ANVILWING_DATA_DIR: tempDir, ANVILWING_HOME: tempDir, ANVILWING_SKIP_AUTH: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });

    const line = out.split('\n').find((l) => l.startsWith('PROBE '));
    expect(line).toBeTruthy();
    const r = JSON.parse(line!.slice('PROBE '.length)) as {
      storedLen: number; before: number; afterRoles: string[]; hasMarker: boolean;
    };
    expect(r.storedLen).toBe(3);
    expect(r.before).toBe(0); // fresh controller starts empty
    expect(r.afterRoles).toEqual(['system', 'user', 'assistant']); // full thread restored
    expect(r.hasMarker).toBe(true); // the unique marker survived the round-trip into context
  }, 70_000);
});

describe('relativeTime — compact session timestamps', () => {
  const now = Date.parse('2026-06-01T12:00:00.000Z');

  test.each<[string, string]>([
    ['2026-06-01T11:59:50.000Z', 'just now'],
    ['2026-06-01T11:57:00.000Z', '3m ago'],
    ['2026-06-01T09:00:00.000Z', '3h ago'],
    ['2026-05-30T12:00:00.000Z', '2d ago'],
    ['2026-04-02T12:00:00.000Z', '2mo ago'],
    ['2024-06-01T12:00:00.000Z', '2y ago'],
  ])('%s → %s', (iso, label) => {
    expect(relativeTime(iso, now)).toBe(label);
  });

  it('returns empty string for unparseable input (never throws)', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
    expect(relativeTime('', now)).toBe('');
  });
});

describe('/resume — source wiring locked', () => {
  it('shell registers /resume and restores history into the controller', () => {
    expect(SHELL).toMatch(/lower === '\/resume'/);
    expect(SHELL).toMatch(/private handleResume\(\)/);
    expect(SHELL).toMatch(/this\.controller\.loadHistory\(stored\.messages\)/);
  });

  it('shell autosaves each turn so there is something to resume', () => {
    expect(SHELL).toMatch(/private persistSessionSnapshot\(\)/);
    expect(SHELL).toMatch(/saveSessionSnapshot\(\{/);
    expect(SHELL).toMatch(/this\.persistSessionSnapshot\(\)/);
  });

  it('shell reprints the restored exchange', () => {
    expect(SHELL).toMatch(/addUserHistoryItem\(m\.content\)/);
    expect(SHELL).toMatch(/Resumed "/);
  });

  it('controller.loadHistory sets cached history and sanitizes orphaned tool calls', () => {
    expect(CONTROLLER).toMatch(/loadHistory\(history: ConversationMessage\[\]\): void \{/);
    expect(CONTROLLER).toMatch(/this\.cachedHistory = Array\.isArray\(history\)/);
    expect(CONTROLLER).toMatch(/this\.sanitizeHistory\(\)/);
  });
});
