/**
 * Secret-store isolation guard. A prior test wrote a placeholder Tavily key
 * via setSecretValue() with no dir override, clobbering the developer's REAL
 * ~/.anvilwing/secrets.json on every `npm test`. The fix isolates the secret
 * store to a temp dir for the whole run by setting ANVILWING_HOME in
 * test/jest-setup.cjs (secretStore resolves its dir from ANVILWING_HOME).
 *
 * Fail-before/pass-after: before the fix ANVILWING_HOME was unset and writes
 * landed in the home dir; this asserts the run is isolated and that a write
 * lands under ANVILWING_HOME, not the user's home.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setSecretValue } from '../src/core/secretStore.js';

const SETUP = join(__dirname, 'jest-setup.cjs');
const setupSrc = readFileSync(SETUP, 'utf8');

describe('secret store is isolated from the real home during tests', () => {
  test('ANVILWING_HOME is set to a throwaway dir, not ~/.anvilwing', () => {
    const home = process.env['ANVILWING_HOME'];
    expect(home).toBeTruthy();
    expect(home).not.toBe(join(homedir(), '.anvilwing'));
    expect(home).not.toBe(homedir());
  });

  test('jest-setup.cjs sets ANVILWING_HOME before any secret-store import', () => {
    expect(setupSrc).toMatch(/ANVILWING_HOME/);
    expect(setupSrc).toMatch(/tmpdir/);
  });

  test('setSecretValue writes under ANVILWING_HOME, never the real home secrets.json', () => {
    setSecretValue('TAVILY_API_KEY', 'tvly-isolation-probe');
    const isolated = join(process.env['ANVILWING_HOME']!, 'secrets.json');
    expect(existsSync(isolated)).toBe(true);
    const stored = JSON.parse(readFileSync(isolated, 'utf8'));
    expect(stored.TAVILY_API_KEY).toBe('tvly-isolation-probe');
    // The temp file must not be the real home secrets file.
    expect(isolated).not.toBe(join(homedir(), '.anvilwing', 'secrets.json'));
  });
});
