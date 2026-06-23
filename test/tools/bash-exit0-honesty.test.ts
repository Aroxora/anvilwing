/**
 * execute_bash used to override a successful (exit 0) command into a
 * VERIFIED_FAILURE whenever its output merely CONTAINED words like "failed",
 * "ENOENT" or "error:" — which appear constantly in legitimate output (grep
 * results, "0 tests failed", a cat'd log). A command that exits 0 succeeded;
 * the verdict must reflect that.
 *
 * Drives the REAL execute_bash tool with real commands.
 */
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBashTools } from '../../src/tools/bashTools.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bash-honesty-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function bash() {
  const t = createBashTools(dir).find((x) => x.name === 'execute_bash');
  if (!t) throw new Error('execute_bash not registered');
  return t.handler as (a: Record<string, unknown>) => Promise<string>;
}

const isFailureVerdict = (out: string) =>
  /═══ FAILED ═══|indicates failure|exit code [1-9]/.test(out);

describe('execute_bash — exit 0 is reported as success even if output mentions failures', () => {
  test('output containing "failed" / "error" at exit 0 is NOT a failure', async () => {
    const out = await bash()({ command: `echo "Summary: 0 tests failed, no errors found"` });
    expect(out).toContain('0 tests failed, no errors found');
    expect(isFailureVerdict(out)).toBe(false);
  });

  test('output containing ENOENT at exit 0 is NOT a failure', async () => {
    const out = await bash()({ command: `node -e "console.log('grep result: ENOENT mentioned in a log line')"` });
    expect(out).toContain('ENOENT mentioned');
    expect(isFailureVerdict(out)).toBe(false);
  });

  test('a genuinely failing command (nonzero exit) IS still a failure', async () => {
    const out = await bash()({ command: `node -e "process.exit(3)"` });
    expect(isFailureVerdict(out)).toBe(true);
  });
});
