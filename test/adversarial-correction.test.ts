/**
 * Adversarial auto-correction — turns a FAILED adversarial review from an
 * advisory caveat into an actual bounded re-fix through the tool-executing
 * auto-continue loop.
 *
 * The prompt builder is pure → tested directly. The end-to-end wiring spans
 * agent (callback) → controller (event) → shell (bounded correction branch);
 * each layer is import.meta-blocked from Jest, so it's source-asserted (the
 * live re-fix behavior is key-gated like the other live-turn tests). tsc
 * already proves the new event is part of AgentEventUnion.
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildAdversarialCorrectionPrompt, MAX_ADVERSARIAL_CORRECTIONS } from '../src/core/adversarialCorrection.js';

const REPO = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');
const CONTRACT = read('src', 'contracts', 'v1', 'agent.ts');
const AGENT = read('src', 'core', 'agent.ts');
const CONTROLLER = read('src', 'runtime', 'agentController.ts');
const SHELL = read('src', 'headless', 'interactiveShell.ts');

describe('buildAdversarialCorrectionPrompt (pure)', () => {
  it('is an IMPORTANT auto-continue that includes the findings and demands a real fix', () => {
    const p = buildAdversarialCorrectionPrompt('clamp() ignores the upper bound');
    expect(p.startsWith('IMPORTANT:')).toBe(true); // so the loop doesn't treat it as a fresh request
    expect(p).toContain('clamp() ignores the upper bound');
    expect(p).toMatch(/re-run the relevant test\/build\/command|verify/i);
    expect(p).toMatch(/Do not just describe/i);
    expect(p).toMatch(/Do NOT create docs/);
  });
  it('tolerates empty findings', () => {
    expect(typeof buildAdversarialCorrectionPrompt('')).toBe('string');
    expect(buildAdversarialCorrectionPrompt('').startsWith('IMPORTANT:')).toBe(true);
  });
  it('is bounded by a small positive cap', () => {
    expect(MAX_ADVERSARIAL_CORRECTIONS).toBeGreaterThan(0);
    expect(MAX_ADVERSARIAL_CORRECTIONS).toBeLessThanOrEqual(3);
  });
});

describe('adversarial auto-correction — source wiring locked (agent → controller → shell)', () => {
  it('contract declares the adversarial.findings event', () => {
    expect(CONTRACT).toMatch(/'adversarial\.findings'/);
    expect(CONTRACT).toMatch(/interface AdversarialFindingsEvent/);
    expect(CONTRACT).toMatch(/\| AdversarialFindingsEvent/);
  });
  it('agent fires onAdversarialFindings when the reviewer refutes the draft', () => {
    expect(AGENT).toMatch(/onAdversarialFindings\?\(findings: string\): void/);
    expect(AGENT).toMatch(/this\.callbacks\.onAdversarialFindings\?\.\(review\.findings\)/);
  });
  it('controller emits the adversarial.findings event to the sink', () => {
    expect(CONTROLLER).toMatch(/onAdversarialFindings:/);
    expect(CONTROLLER).toMatch(/type: 'adversarial\.findings'/);
  });
  it('shell captures findings and runs a BOUNDED correction via the auto-continue loop', () => {
    expect(SHELL).toMatch(/case 'adversarial\.findings'/);
    expect(SHELL).toMatch(/turnAdversarialFindings = event\.findings/);
    expect(SHELL).toMatch(/this\.adversarialCorrectionCount < MAX_ADVERSARIAL_CORRECTIONS/);
    expect(SHELL).toMatch(/buildAdversarialCorrectionPrompt\(turnAdversarialFindings\)/);
    expect(SHELL).toMatch(/this\.adversarialCorrectionCount = 0/); // reset on fresh prompt
  });
});
