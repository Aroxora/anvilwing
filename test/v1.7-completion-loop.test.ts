/**
 * Completion-loop hardening — the governor-halt over-verification batch from
 * the 2026-06-12 design audit (findings #8-#12, each probe-verified against
 * the real dist before fixing).
 *
 * The shipped failure mode: a FINISHED task kept auto-continuing until the
 * governor halted it with "Paused — tell me how to proceed", because
 *  (#8)  hedge/error words ANYWHERE in the reply vetoed structural completion
 *        ('I created the file, then ran sha256sum' → incomplete; 'Fixed the
 *        bug' → incomplete via the noun 'bug');
 *  (#9)  the system prompt never specified a detectable completion shape;
 *  (#10) the detector's medium-confidence band (shouldVerify) had zero
 *        callers, so 'done… Let me know if you need anything.' re-prompted;
 *  (#11) a re-verify loop alternating Read/Bash never matched the stall
 *        fingerprint and burned all 25 turns;
 *  (#12) the halt branch ran BEFORE the completion check, and user-typed
 *        'continue' skipped the governor reset (one extra turn per
 *        'continue', forever).
 *
 * Behavioral tests drive the REAL detector and REAL governor in-process;
 * shell/prompt wiring is pinned with source assertions per repo convention.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { TaskCompletionDetector } from '../src/core/taskCompletionDetector';
import { TurnGovernor, fingerprintTurn } from '../src/core/turnGovernor';

const REPO = resolve(__dirname, '..');
const SHELL = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');
const SCHEMAS = readFileSync(join(REPO, 'src', 'contracts', 'agent-schemas.json'), 'utf8');
const RULEBOOK = readFileSync(join(REPO, 'agents', 'anvilwing-code.rules.json'), 'utf8');

const analyze = (response: string, tools: string[] = []) =>
  new TaskCompletionDetector().analyzeCompletion(response, tools);

describe('#8 — hedges/error-nouns no longer veto a stated completion', () => {
  test('past-tense narration with "then" reads as complete', () => {
    const a = analyze('I created the file at scripts/run.sh, then ran sha256sum — the hashes match exactly.');
    expect(a.isComplete).toBe(true);
  });

  test('"Fixed the bug … tests pass" reads as complete (noun mentions are not failures)', () => {
    const a = analyze('Fixed the bug in src/x.ts — the race no longer occurs. All 12 tests pass.');
    expect(a.isComplete).toBe(true);
  });

  test('a forward-looking hedge in the FINAL paragraph still blocks completion', () => {
    const a = analyze('I created the file at scripts/run.sh.\n\nLet me double-check the bytes match.');
    expect(a.isComplete).toBe(false);
  });

  test('a REAL failing-test signal still overrides any completion claim', () => {
    const a = analyze('All done! Tests: 3 failed, 9 passed. I created everything requested.');
    expect(a.isComplete).toBe(false);
    expect(a.reason).toMatch(/failure visible/i);
  });

  test.each([
    ['courtesy sign-off', 'Created scripts/run.sh and verified it runs. Let me know if you need anything else.', true],
    ['real question', 'Created scripts/run.sh. Would you like me to also update the README?', false],
    ['trailing question mark', 'I wrote the file. Should I commit it?', false],
  ])('%s → isComplete %s', (_label, text, complete) => {
    expect(analyze(text).isComplete).toBe(complete);
  });
});

describe('#9 — DONE: sentinel (the system-prompt completion contract)', () => {
  test('a final DONE: line is decisive completion at high confidence', () => {
    const a = analyze('Wrote the migration and ran it.\n\nDONE: created scripts/run.sh; bash scripts/run.sh exited 0');
    expect(a.isComplete).toBe(true);
    expect(a.confidence).toBeGreaterThanOrEqual(0.95);
  });

  test('DONE: cannot punch through red tests', () => {
    const a = analyze('Build output: 2 failed, 1 passed.\n\nDONE: finished everything');
    expect(a.isComplete).toBe(false);
  });

  test('the system prompt mandates the DONE: shape and bans post-check hedging', () => {
    expect(SCHEMAS).toMatch(/starts exactly with `DONE:`/);
    expect(SCHEMAS).toMatch(/never announce another check/);
    expect(SCHEMAS).toMatch(/do NOT emit `DONE:`/);
  });
});

describe('#11 — stall detection is progress-based, not tool-identity-based', () => {
  test('alternating read-only tools stalls at the window, not the 25-turn limit', () => {
    const gov = new TurnGovernor();
    const noop = (tools: string[]) => ({ toolsUsed: tools, filesModified: [], failingSignal: null });
    let verdict = gov.check();
    const sequence = [['Read'], ['Bash'], ['Read'], ['Bash']];
    let stoppedAt = 0;
    for (let turn = 1; turn <= 25 && !verdict.stop; turn++) {
      gov.recordTurn(noop(sequence[turn % sequence.length]!));
      verdict = gov.check();
      stoppedAt = turn;
    }
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe('stall');
    expect(stoppedAt).toBe(3); // STALL_WINDOW, not 25
  });

  test('turns that modify DIFFERENT files never false-stall', () => {
    const gov = new TurnGovernor();
    for (let i = 0; i < 6; i++) {
      gov.recordTurn({ toolsUsed: ['Edit'], filesModified: [`src/f${i}.ts`], failingSignal: null });
    }
    expect(gov.check().stop).toBe(false);
  });

  test('fingerprint collapses all read-only no-failing turns to one signature', () => {
    expect(fingerprintTurn({ toolsUsed: ['Read'], filesModified: [], failingSignal: null }))
      .toBe(fingerprintTurn({ toolsUsed: ['Bash'], filesModified: [], failingSignal: null }));
    expect(fingerprintTurn({ toolsUsed: ['Read'], filesModified: ['a.ts'], failingSignal: null }))
      .not.toBe(fingerprintTurn({ toolsUsed: ['Bash'], filesModified: ['a.ts'], failingSignal: null }));
  });
});

describe('#10/#12 — shell wiring: completion first, working continue, live shouldVerify', () => {
  test('completion (incl. quiet medium-confidence) is checked BEFORE gov.stop', () => {
    const completionIdx = SHELL.indexOf('if ((analysis.isComplete && pending.length === 0) || quietDone || conversationalDone)');
    const govIdx = SHELL.indexOf('} else if (gov.stop) {');
    expect(completionIdx).toBeGreaterThan(-1);
    expect(govIdx).toBeGreaterThan(-1);
    expect(completionIdx).toBeLessThan(govIdx);
  });

  test('quietDone consumes the previously-dead shouldVerify band', () => {
    expect(SHELL).toMatch(/analysis\.shouldVerify &&\s*\n\s*pending\.length === 0 &&\s*\n\s*filesModified\.length === 0/);
  });

  test('a pure-text conversational turn completes instead of churning (no tools, no pending, not promising more)', () => {
    // A conversational reply (an ack, a question answer) needs no tools and is
    // done when given — auto-continuing it made the model repeat itself to the
    // stall halt. conversationalDone joins the completion branch.
    expect(SHELL).toMatch(/const conversationalDone =\s*\n\s*toolsUsed\.length === 0 &&\s*\n\s*pending\.length === 0 &&\s*\n\s*filesModified\.length === 0 &&\s*\n\s*!analysis\.signals\.hasIncompleteWorkIndicators/);
    expect(SHELL).toMatch(/\|\| quietDone \|\| conversationalDone\) \{/);
  });

  test('the auto-continue fallback is IMPORTANT:-prefixed, never the bare word "continue"', () => {
    expect(SHELL).not.toMatch(/\?\? 'continue'/);
    expect(SHELL).toMatch(/\?\? `IMPORTANT: continue the original task/);
  });

  test('user-typed "continue" resets the governor but keeps the original task prompt', () => {
    expect(SHELL).not.toMatch(/prompt !== 'continue' && !prompt\.startsWith\('IMPORTANT:'\)/);
    expect(SHELL).toMatch(/isBareResume = \/\^\(continue\|keep\\s\+going\|go\\s\+on\|resume\)/);
  });

  test('a governor halt no longer discards the original prompt', () => {
    const govBlock = SHELL.slice(SHELL.indexOf('} else if (gov.stop) {'), SHELL.indexOf('turnAdversarialFindings'));
    expect(govBlock).not.toMatch(/originalPromptForAutoContinue = null/);
  });
});

describe('#19 — rulebook no longer contradicts the prompt or orders phantom tools', () => {
  test('phantom-tool workflow and anti-finish-once rules are gone', () => {
    expect(RULEBOOK).not.toMatch(/MarkExplorationComplete|ProposePlan/);
    expect(RULEBOOK).not.toMatch(/persistent_completion/);
    expect(RULEBOOK).not.toMatch(/WAIT for user approval/);
  });

  test('no unrestricted/no-safety rules contradicting the permission system', () => {
    expect(RULEBOOK).not.toMatch(/ALL OPERATIONS ARE PERMITTED|no safety restrictions/i);
    expect(RULEBOOK).toMatch(/core\.confirm_destructive/);
  });

  test('real strategy guidance replaced the phantom workflow', () => {
    expect(RULEBOOK).toMatch(/core\.effort_ladder/);
    // Concrete parallelism guidance is now the batched-tool-call idiom (Claude
    // Code parity), not "spin up parallel_agents for 3+ reads" (audit wf_01ae0532).
    expect(RULEBOOK).toMatch(/core\.batch_independent/);
  });
});
