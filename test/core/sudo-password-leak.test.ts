import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSudoWithPassword } from '../../src/tools/bashTools.js';

/**
 * Security regression: execSudoWithPassword used to (a) build `sudo -S` WITHOUT
 * `-k`, so cached sudo credentials made sudo skip stdin, and (b) blindly write
 * the password to the child's stdin on a 100ms timer regardless of whether sudo
 * prompted. Together, when sudo did not consume stdin, the user's password fell
 * through to the command's OWN stdin — leaking into its output/any file it wrote.
 *
 * This drives the real function with a command that echoes its stdin (`cat`),
 * standing in for the leak path WITHOUT needing sudo/privileges: the replace
 * only matches a leading `sudo `, so a non-sudo command runs under the same
 * stdin-handling harness. Fail-before: the blind timer writes the password to
 * cat → it appears in output. Pass-after: the password is only written in
 * response to a real sudo prompt, so cat sees EOF and never echoes it.
 */
describe('execSudoWithPassword — password never leaks into the command stdin', () => {
  const SECRET = 'hunter2-do-not-leak';

  test('a stdin-reading command never receives the password', async () => {
    const result = await execSudoWithPassword('cat', SECRET, {
      cwd: process.cwd(),
      timeout: 8000,
      env: process.env as NodeJS.ProcessEnv,
    });
    expect(result.stdout).not.toContain(SECRET);
    expect(result.stderr).not.toContain(SECRET);
  }, 15000);

  test('source: -k is passed and the password is written in exactly one place', () => {
    const src = readFileSync(resolve(__dirname, '../../src/tools/bashTools.ts'), 'utf8');
    // -S -k -p sentinel must be how the sudo command is built.
    expect(src).toMatch(/sudo -S -k -p \$\{SUDO_PROMPT_SENTINEL\}/);
    // The password must be written ONLY in the prompt-response path — never on a
    // blind timer. Before the fix there were two such writes (prompt + blind
    // timer); now there is exactly one.
    const writes = src.match(/stdin\?\.write\(password \+ '\\n'\)/g) ?? [];
    expect(writes).toHaveLength(1);
    // The safety-net timer exists and only closes stdin.
    expect(src).toMatch(/Safety net[\s\S]*?child\.stdin\?\.end\(\)/);
  });
});
