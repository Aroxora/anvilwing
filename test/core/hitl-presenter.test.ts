/**
 * HITL decision presenter injection. When a presenter is registered (the Ink
 * shell does this so decisions render as a menu BELOW the prompt), every
 * decision routes through it instead of the screen-clearing raw-mode menu.
 * This locks: the presenter receives the full request, its choice is returned,
 * the decision is recorded, and the write-in path carries the custom text.
 *
 * No terminal: the presenter is a plain async function, so this runs headless.
 */

import { describe, expect, test, afterEach } from '@jest/globals';
import {
  HITLSystem,
  setDecisionPresenter,
  type DecisionRequest,
  type DecisionChoice,
} from '../../src/core/hitl';

afterEach(() => setDecisionPresenter(null));

const REQUEST: DecisionRequest = {
  id: 'dec-1',
  title: 'Pick a refactor scope',
  description: 'How broad should the change be?',
  context: 'three callers affected',
  options: [
    { id: 'a', label: 'Narrow', description: 'just the one function' },
    { id: 'b', label: 'Medium', description: 'the module' },
    { id: 'c', label: 'Broad', description: 'all callers' },
    { id: 'd', label: 'Full', description: 'the subsystem' },
  ],
  defaultOptionId: 'b',
  requiresExplicitChoice: true,
};

describe('HITL decision presenter', () => {
  test('a registered presenter receives the request and its pick is returned + recorded', async () => {
    let seen: DecisionRequest | null = null;
    setDecisionPresenter(async (req) => { seen = req; return { optionId: 'c' }; });

    const hitl = new HITLSystem({ autoPause: true, logLevel: 'none' });
    const result = await hitl.requestDecision(REQUEST);

    expect(result).toBe('c');
    expect(seen!.title).toBe('Pick a refactor scope');
    expect(seen!.options).toHaveLength(4); // the shell appends the write-in in the UI, not here
    const history = hitl.getHistory();
    expect(history[history.length - 1]!.selectedOptionId).toBe('c');
  });

  test('the write-in path returns a custom id and records the typed text', async () => {
    setDecisionPresenter(async (): Promise<DecisionChoice> => ({ optionId: '__custom__', customInput: 'do X instead' }));

    const hitl = new HITLSystem({ autoPause: true, logLevel: 'none' });
    const result = await hitl.requestDecision(REQUEST);

    expect(result).toMatch(/^custom-/);
    const last = hitl.getHistory().at(-1)!;
    expect(last.userInput).toBe('do X instead');
    expect(last.selectedOptionId).toBe(result);
  });

  test('#13 getDecisionInput surfaces the write-in text by result id (was lost to the model)', async () => {
    setDecisionPresenter(async (): Promise<DecisionChoice> => ({ optionId: '__custom__', customInput: 'rewrite it in Rust' }));
    const hitl = new HITLSystem({ autoPause: true, logLevel: 'none' });
    const result = await hitl.requestDecision(REQUEST);
    // The synthetic custom-id matches no option, but its typed text is now
    // retrievable so the HITL_Decision tool can hand it to the model.
    expect(hitl.getDecisionInput(result)).toBe('rewrite it in Rust');
    // a normal (non-write-in) pick has no custom input
    setDecisionPresenter(async () => ({ optionId: 'c' }));
    const hitl2 = new HITLSystem({ autoPause: true, logLevel: 'none' });
    expect(hitl2.getDecisionInput(await hitl2.requestDecision(REQUEST))).toBeUndefined();
  });

  test('an empty optionId falls back to the model default, then the first option', async () => {
    setDecisionPresenter(async () => ({ optionId: '' }));
    const hitl = new HITLSystem({ autoPause: true, logLevel: 'none' });
    expect(await hitl.requestDecision(REQUEST)).toBe('b'); // defaultOptionId

    setDecisionPresenter(async () => ({ optionId: '' }));
    const noDefault = new HITLSystem({ autoPause: true, logLevel: 'none' });
    const req2 = { ...REQUEST, defaultOptionId: undefined };
    expect(await noDefault.requestDecision(req2)).toBe('a'); // first option
  });

  test('#17 a byte-identical decision is NOT re-asked — prior answer is reused', async () => {
    let prompts = 0;
    setDecisionPresenter(async () => { prompts++; return { optionId: 'c' }; });
    const hitl = new HITLSystem({ autoPause: true, logLevel: 'none' });
    expect(await hitl.requestDecision({ ...REQUEST, id: 'q1' })).toBe('c');
    // identical request (different id) → cached answer, presenter NOT called again
    expect(await hitl.requestDecision({ ...REQUEST, id: 'q2' })).toBe('c');
    expect(prompts).toBe(1);
  });

  test('#17 a DIFFERENT decision still prompts (dedupe is exact-match only)', async () => {
    let prompts = 0;
    setDecisionPresenter(async () => { prompts++; return { optionId: 'a' }; });
    const hitl = new HITLSystem({ autoPause: true, logLevel: 'none' });
    await hitl.requestDecision({ ...REQUEST, id: 'q1' });
    // same title, different option set → not a repeat
    await hitl.requestDecision({ ...REQUEST, id: 'q2', options: [
      { id: 'x', label: 'X', description: '...' }, { id: 'y', label: 'Y', description: '...' },
    ] });
    expect(prompts).toBe(2);
  });

  test('clearing the presenter restores the raw-mode path (no presenter call)', async () => {
    let called = false;
    setDecisionPresenter(async () => { called = true; return { optionId: 'a' }; });
    setDecisionPresenter(null);
    // autoPause:false short-circuits to the default WITHOUT any prompt/presenter,
    // proving the presenter is no longer in the path.
    const hitl = new HITLSystem({ autoPause: false, logLevel: 'none' });
    expect(await hitl.requestDecision(REQUEST)).toBe('b');
    expect(called).toBe(false);
  });
});

describe('the shell wires the Ink presenter (source guard)', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const shell = readFileSync(resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

  test('registers a presenter that renders HITL choices through the in-app menu', () => {
    expect(shell).toMatch(/setDecisionPresenter\(\(request\) => this\.presentHitlDecision\(request\)\)/);
    // the choices go through the same setMenu surface as the slash palette…
    expect(shell).toMatch(/presentHitlDecision[\s\S]*?controller\.setMenu\(/);
    // …with an "Enter your own" write-in and custom-text capture
    expect(shell).toMatch(/Enter your own/);
    expect(shell).toMatch(/presentHitlDecision[\s\S]*?captureInput/);
  });

  test('#15 dismissal (Esc) maps to a decline-like option, not the default (safety)', () => {
    // A decline-like option id/label (no/reject/cancel/…) becomes the dismiss
    // target, so dismissing a "yes"-default approval declines rather than
    // consents. Only when none exists does it fall back to the default.
    expect(shell).toMatch(/const declineId = request\.options\.find/);
    expect(shell).toMatch(/no\|n\|reject\|decline\|cancel\|skip\|abort/);
    expect(shell).toMatch(/const dismissId = declineId \?\? request\.defaultOptionId/);
    expect(shell).toMatch(/resolve\(\{ optionId: dismissId \}\); \/\/ Esc/);
  });
});

describe('#13 the HITL_Decision tool surfaces the write-in text (source guard)', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const tools = readFileSync(resolve(__dirname, '..', '..', 'src', 'tools', 'hitlTools.ts'), 'utf8');

  test('handler reads getDecisionInput and hands the user instruction to the model', () => {
    expect(tools).toMatch(/getDecisionInput\(selectedOptionId\)/);
    expect(tools).toMatch(/wrote their own instruction/i);
    expect(tools).toMatch(/Follow this instruction directly/i);
  });

  test('#18 HITL_Decision accepts 2-4 options (recommended first), not exactly 4', () => {
    expect(tools).toMatch(/options\.length < 2 \|\| options\.length > 4/);
    expect(tools).not.toMatch(/options\.length !== 4/);
    expect(tools).toMatch(/minItems: 2/);
    expect(tools).toMatch(/maxItems: 4/);
    // recommended-first: default lands on the first option when unspecified
    expect(tools).toMatch(/typedArgs\.defaultOptionId = options\[0\]\.id/);
  });
});
