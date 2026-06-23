/**
 * Turn governor — bounds + stall-detects the auto-continue loop, and derives
 * continuation from the live TODO plan.
 *
 * The governor logic is pure → tested directly (fail-before: the module didn't
 * exist; pass-after: these cases). The wiring into the unbounded auto-continue
 * recursion in interactiveShell.ts is source-asserted (that file pulls in the
 * import.meta runtime graph Jest can't import; the loop-behavior against the
 * real binary is key-gated like the other live-turn tests).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TurnGovernor,
  fingerprintTurn,
  pendingTodos,
  nextTodoPrompt,
  type TurnMetrics,
} from '../src/core/turnGovernor.js';

const SHELL = readFileSync(resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');
const m = (over: Partial<TurnMetrics> = {}): TurnMetrics => ({ toolsUsed: ['Edit'], filesModified: ['a.ts'], failingSignal: null, ...over });

describe('TurnGovernor — hard turn limit', () => {
  it('stops at the limit and not before', () => {
    const g = new TurnGovernor({ maxAutoTurns: 5 });
    for (let i = 0; i < 4; i++) { g.recordTurn(m({ filesModified: [`f${i}.ts`] })); expect(g.check().stop).toBe(false); }
    g.recordTurn(m({ filesModified: ['f4.ts'] }));
    const v = g.check();
    expect(v).toEqual({ stop: true, reason: 'limit', turn: 5 });
  });

  it('reset() starts a fresh budget', () => {
    const g = new TurnGovernor({ maxAutoTurns: 2 });
    g.recordTurn(m()); g.recordTurn(m({ filesModified: ['b.ts'] }));
    expect(g.check().stop).toBe(true);
    g.reset();
    expect(g.turnCount).toBe(0);
    expect(g.check().stop).toBe(false);
  });

  it('honors ANVILWING_MAX_AUTO_TURNS', () => {
    process.env['ANVILWING_MAX_AUTO_TURNS'] = '3';
    try {
      const g = new TurnGovernor();
      expect(g.maxTurns).toBe(3);
      g.recordTurn(m()); g.recordTurn(m({ filesModified: ['b.ts'] }));
      expect(g.check().stop).toBe(false);
      g.recordTurn(m({ filesModified: ['c.ts'] }));
      expect(g.check()).toMatchObject({ stop: true, reason: 'limit' });
    } finally {
      delete process.env['ANVILWING_MAX_AUTO_TURNS'];
    }
  });
});

describe('TurnGovernor — stall detection', () => {
  it('stops when the same non-empty work repeats stallWindow times', () => {
    const g = new TurnGovernor({ maxAutoTurns: 100, stallWindow: 3 });
    g.recordTurn(m({ toolsUsed: ['Bash'], filesModified: [], failingSignal: 'FAIL auth.test.ts' }));
    expect(g.check().stop).toBe(false);
    g.recordTurn(m({ toolsUsed: ['Bash'], filesModified: [], failingSignal: 'FAIL auth.test.ts' }));
    expect(g.check().stop).toBe(false);
    g.recordTurn(m({ toolsUsed: ['Bash'], filesModified: [], failingSignal: 'FAIL auth.test.ts' }));
    expect(g.check()).toMatchObject({ stop: true, reason: 'stall' });
  });

  it('does NOT stall when the work changes each turn', () => {
    const g = new TurnGovernor({ maxAutoTurns: 100, stallWindow: 3 });
    g.recordTurn(m({ filesModified: ['a.ts'], failingSignal: 'FAIL a' }));
    g.recordTurn(m({ filesModified: ['b.ts'], failingSignal: 'FAIL b' }));
    g.recordTurn(m({ filesModified: ['c.ts'], failingSignal: null }));
    expect(g.check().stop).toBe(false);
  });

  it('repeated no-op turns (no tools/files/progress) count as a stall too', () => {
    const g = new TurnGovernor({ maxAutoTurns: 100, stallWindow: 3 });
    g.recordTurn({ toolsUsed: [], filesModified: [], failingSignal: null });
    g.recordTurn({ toolsUsed: [], filesModified: [], failingSignal: null });
    expect(g.check().stop).toBe(false);
    g.recordTurn({ toolsUsed: [], filesModified: [], failingSignal: null });
    expect(g.check()).toMatchObject({ stop: true, reason: 'stall' });
  });
});

describe('fingerprintTurn', () => {
  it('is order-independent and deterministic', () => {
    expect(fingerprintTurn(m({ toolsUsed: ['Edit', 'Read'], filesModified: ['b.ts', 'a.ts'] })))
      .toBe(fingerprintTurn(m({ toolsUsed: ['Read', 'Edit'], filesModified: ['a.ts', 'b.ts'] })));
  });
  it('differs when work differs', () => {
    expect(fingerprintTurn(m({ failingSignal: 'FAIL x' }))).not.toBe(fingerprintTurn(m({ failingSignal: 'FAIL y' })));
  });
});

describe('plan-aware continuation', () => {
  const todos = [
    { content: 'set up the schema', status: 'completed' },
    { content: 'write the migration', status: 'in_progress' },
    { content: 'wire the API', status: 'pending' },
  ];
  it('pendingTodos returns only pending/in_progress', () => {
    expect(pendingTodos(todos).map((t) => t.content)).toEqual(['write the migration', 'wire the API']);
    expect(pendingTodos([])).toEqual([]);
    expect(pendingTodos(null)).toEqual([]);
  });
  it('nextTodoPrompt targets the in-progress item and is an IMPORTANT auto-continue', () => {
    const p = nextTodoPrompt(todos)!;
    expect(p.startsWith('IMPORTANT:')).toBe(true);
    expect(p).toContain('write the migration');
  });
  it('nextTodoPrompt falls back to the first pending when none in-progress', () => {
    expect(nextTodoPrompt([{ content: 'do the thing', status: 'pending' }])).toContain('do the thing');
  });
  it('nextTodoPrompt is null when the plan has no pending work', () => {
    expect(nextTodoPrompt([{ content: 'done', status: 'completed' }])).toBeNull();
    expect(nextTodoPrompt([])).toBeNull();
  });
});

describe('auto-continue wiring — source locked', () => {
  it('shell instantiates the governor and resets it on a fresh prompt', () => {
    expect(SHELL).toMatch(/private autoGovernor = new TurnGovernor\(\)/);
    expect(SHELL).toMatch(/this\.autoGovernor\.reset\(\)/);
  });
  it('shell records each turn and breaks the loop on governor stop', () => {
    expect(SHELL).toMatch(/this\.autoGovernor\.recordTurn\(/);
    expect(SHELL).toMatch(/const gov = this\.autoGovernor\.check\(\)/);
    expect(SHELL).toMatch(/gov\.stop/);
  });
  it('shell drives continuation from the live TODO plan', () => {
    expect(SHELL).toMatch(/getCurrentTodos\(\)/);
    expect(SHELL).toMatch(/nextTodoPrompt\(todos\)/);
    // Continuation is now the default; the turn ends only when the analysis
    // says complete AND the live plan has no pending todos (or quietDone).
    expect(SHELL).toMatch(/analysis\.isComplete && pending\.length === 0/);
  });
});
