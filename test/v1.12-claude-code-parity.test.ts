/**
 * Claude Code capability-parity fixes (audit wf_01ae0532). Source contract,
 * CI-runnable; the live behavioural proof for /clear is the 'clearmem'
 * scenario in test/e2e-agentic-tasks.test.ts (the model forgets the secret).
 *
 *  #1 The system prompt redirected 3+ independent reads/greps to heavyweight
 *     parallel_agents sub-agents instead of teaching the cheap batched-tool-
 *     call idiom Claude Code uses (already fully wired in dispatch + provider).
 *  #3 /clear wiped the screen but never reset the model's conversation history
 *     — a Claude Code user expects /clear to start fresh.
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

const SHELL = read('src', 'headless', 'interactiveShell.ts');
const RULES = JSON.parse(read('agents', 'anvilwing-code.rules.json'));

describe('#3 — /clear starts a fresh conversation, not just a screen wipe', () => {
  test('the /clear branch resets the model history and per-session state', () => {
    const branch = SHELL.slice(
      SHELL.indexOf("lower === '/clear'"),
      SHELL.indexOf("lower === '/clear'") + 860,
    );
    expect(branch).toMatch(/this\.controller\.clearHistory\(\);/);   // the load-bearing reset
    expect(branch).toMatch(/clearCurrentTodos\(\);/);
    expect(branch).toMatch(/this\.autoGovernor\.reset\(\);/);
    expect(branch).toMatch(/getTaskCompletionDetector\(\)\.reset\(\);/); // F4: detector singleton too
    expect(branch).toMatch(/this\.sessionId = null;/);
    expect(branch).toMatch(/clearScreen\(\)/);                       // still wipes the screen too
  });
});

describe('#1 — the prompt teaches batched tool calls, not sub-agents, for independent ops', () => {
  const principles: Array<{ id: string; summary: string; severity: string }> = RULES.globalPrinciples;
  const byId = (id: string) => principles.find((p) => p.id === id);

  test('a REQUIRED core.batch_independent rule teaches multiple tool calls in one message', () => {
    const r = byId('core.batch_independent');
    expect(r).toBeDefined();
    expect(r!.severity).toBe('required');
    expect(r!.summary).toMatch(/MULTIPLE tool calls in ONE assistant message/);
    expect(r!.summary).toMatch(/read_files/);
  });

  test('parallel_agents is downgraded to OPTIONAL and reserved for multi-step subtasks', () => {
    const r = byId('core.parallel_agents');
    expect(r).toBeDefined();
    expect(r!.severity).toBe('optional');
    expect(r!.summary).toMatch(/MULTI-STEP subtasks/);
    // It must NO LONGER claim the plain "3+ independent reads/greps" case.
    expect(r!.summary).not.toMatch(/3\+ INDEPENDENT reads\/greps\/file-creations/);
  });

  test('the old REQUIRED "use parallel_agents for 3+ reads" steer is gone repo-wide in the rules', () => {
    const raw = read('agents', 'anvilwing-code.rules.json');
    expect(raw).not.toMatch(/issue them as ONE parallel_agents call \(cap 5\) instead of sequential/);
  });
});
