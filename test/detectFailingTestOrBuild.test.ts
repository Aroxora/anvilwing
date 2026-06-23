/**
 * Regression: when the agent's response contains a visible test or
 * build failure, the auto-loop must FORCE continuation — even if the
 * model claims completion. This is the single highest-leverage
 * Claude-Code-parity upgrade: the loop never accepts "I'm done" while
 * the suite is red.
 */

import { detectFailingTestOrBuild } from '../src/core/taskCompletionDetector.js';

describe('detectFailingTestOrBuild', () => {
  it('catches Jest failure summary', () => {
    expect(detectFailingTestOrBuild('Tests:       3 failed, 12 passed, 15 total')).toBe('jest test count');
  });

  it('catches Jest test-suite failure summary', () => {
    expect(detectFailingTestOrBuild('Test Suites: 1 failed, 4 passed, 5 total')).toBe('jest suite count');
  });

  it('catches a FAIL line for a specific test file', () => {
    const out = '\nFAIL src/foo.test.ts\n  ✕ should add\n';
    expect(detectFailingTestOrBuild(out)).toBe('jest fail line');
  });

  it('catches Vitest summary form', () => {
    expect(detectFailingTestOrBuild('Test Files  2 failed | 6 passed')).toBe('vitest fail count');
  });

  it('catches mocha-style "N failing"', () => {
    expect(detectFailingTestOrBuild('  4 failing\n\n  1)  myTest:')).toBe('failing tests count');
  });

  it('catches TypeScript compilation errors', () => {
    expect(detectFailingTestOrBuild('src/foo.ts(10,5): error TS2304: Cannot find name "x".')).toBe('tsc error');
  });

  it('catches webpack build failures', () => {
    expect(detectFailingTestOrBuild('webpack 5.95.0 compiled with errors and webpack failed in 3.2s')).toBe('webpack failed');
  });

  it('catches generic compilation/build failed lines', () => {
    expect(detectFailingTestOrBuild('Build failed: ModuleParseError')).toBe('compilation failed');
    expect(detectFailingTestOrBuild('Compilation failed in /tmp/foo')).toBe('compilation failed');
  });

  it('catches non-zero exit codes', () => {
    expect(detectFailingTestOrBuild('command exited with code 1')).toBe('exited non-zero');
    expect(detectFailingTestOrBuild('Process exited 2')).toBe('exited non-zero');
  });

  it('returns null for clean output', () => {
    expect(detectFailingTestOrBuild('Tests: 12 passed, 12 total')).toBe(null);
    expect(detectFailingTestOrBuild('Build succeeded.')).toBe(null);
    expect(detectFailingTestOrBuild('All checks pass.')).toBe(null);
  });

  it('returns null for empty / whitespace input', () => {
    expect(detectFailingTestOrBuild('')).toBe(null);
    expect(detectFailingTestOrBuild('   \n\t')).toBe(null);
  });

  it('only scans the last ~6KB so historical context is ignored', () => {
    // 7KB of "passing" text followed by an old "failed" mention near
    // the end — the historical context shouldn't cause a false trip
    // if it's outside the tail window. We deliberately put a fail
    // INSIDE the tail to verify positive detection works at the
    // expected scan depth.
    const head = 'all green here. '.repeat(450); // > 6000 chars
    const tail = 'Tests: 1 failed, 0 passed, 1 total\n';
    expect(detectFailingTestOrBuild(head + tail)).toBe('jest test count');
  });

  it('does NOT match historical "we fixed the failing test" prose', () => {
    const benign = "I fixed the test that was previously failing. Now Tests: 5 passed, 5 total.";
    expect(detectFailingTestOrBuild(benign)).toBe(null);
  });
});
