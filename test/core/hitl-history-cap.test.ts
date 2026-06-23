/**
 * HITLSystem.decisionHistory is held by a process-lifetime singleton and was
 * append-only — a multi-hour agent run that hit many decision points grew it
 * without bound. This locks the FIFO cap: oldest decisions evict, newest stay.
 *
 * Drives the real HITLSystem through requestDecision with autoPause:false, the
 * non-interactive path that records a decision without any stdin/readline.
 *
 * Fail-before: without the cap, getHistory().length === 200.
 * Pass-after:  with the cap, getHistory().length === 100 (oldest 100 evicted).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HITLSystem, type DecisionRequest } from '../../src/core/hitl.js';

const hitlSrc = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'hitl.ts'), 'utf8');

function makeRequest(i: number): DecisionRequest {
  return {
    id: `req-${i}`,
    title: 't',
    description: 'd',
    context: 'c',
    options: [{ id: 'go', label: 'Go', description: '' }],
    requiresExplicitChoice: false,
    defaultOptionId: 'go',
  };
}

describe('HITLSystem decision-history cap', () => {
  it('caps decisionHistory at 100 and evicts oldest-first (FIFO)', async () => {
    const hitl = new HITLSystem({ autoPause: false, logLevel: 'none' });

    for (let i = 0; i < 200; i++) {
      const chosen = await hitl.requestDecision(makeRequest(i));
      expect(chosen).toBe('go'); // confirms the non-interactive record path ran
    }

    const history = hitl.getHistory();
    expect(history).toHaveLength(100);

    const ids = history.map((r) => r.requestId);
    // oldest 100 evicted...
    expect(ids).not.toContain('req-0');
    expect(ids).not.toContain('req-99');
    // ...newest 100 retained, in order, newest last.
    expect(ids[0]).toBe('req-100');
    expect(ids[ids.length - 1]).toBe('req-199');
  });

  it('does not evict below the cap', async () => {
    const hitl = new HITLSystem({ autoPause: false, logLevel: 'none' });
    for (let i = 0; i < 100; i++) await hitl.requestDecision(makeRequest(i));
    expect(hitl.getHistory()).toHaveLength(100);
    expect(hitl.getHistory()[0].requestId).toBe('req-0');
  });

  // Source assertion: a future refactor that drops the eviction gets caught here
  // even if behaviour somehow passes (e.g. someone re-stubs the method).
  it('source keeps the FIFO eviction guard', () => {
    expect(hitlSrc).toMatch(/decisionHistory\.length > [A-Za-z0-9_]+[\s\S]{0,60}shift\(\)/);
  });
});
