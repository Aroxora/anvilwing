/**
 * The execute_bash "[sandboxed]" / "[real credentials]" label was computed from
 * needsRealHome(command) alone, ignoring ANVILWING_PRESERVE_HOME — but
 * buildSandboxEnv honors that env var. So the label could claim "[sandboxed]"
 * while the command actually ran against the real home (or vice versa). Both now
 * use resolvesToRealHome, so the label always matches the real environment.
 */
import { describe, expect, test, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvesToRealHome, buildSandboxEnv } from '../../src/tools/bashTools.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(() => {
  delete process.env['ANVILWING_PRESERVE_HOME'];
});

describe('sandbox label honors ANVILWING_PRESERVE_HOME', () => {
  test('PRESERVE_HOME=1 forces real home even for a non-cloud command', () => {
    process.env['ANVILWING_PRESERVE_HOME'] = '1';
    expect(resolvesToRealHome({ command: 'ls -la' })).toBe(true);
  });

  test('PRESERVE_HOME=0 forces sandbox even for a cloud-CLI command', () => {
    process.env['ANVILWING_PRESERVE_HOME'] = '0';
    expect(resolvesToRealHome({ command: 'firebase deploy' })).toBe(false);
  });

  test('unset: derived from whether the command needs cloud credentials', () => {
    delete process.env['ANVILWING_PRESERVE_HOME'];
    expect(resolvesToRealHome({ command: 'firebase deploy' })).toBe(true);
    expect(resolvesToRealHome({ command: 'echo hi' })).toBe(false);
  });

  test('the built env matches the decision — the label cannot lie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-label-'));
    try {
      process.env['ANVILWING_PRESERVE_HOME'] = '1';
      const env = await buildSandboxEnv(dir, { command: 'ls' }); // non-cloud, but forced real
      // preserveHome ⇒ HOME stays the real home, distinct from the sandbox home.
      expect(env['HOME']).not.toBe(env['ANVILWING_SANDBOX_HOME']);
      expect(resolvesToRealHome({ command: 'ls' })).toBe(true); // label agrees

      process.env['ANVILWING_PRESERVE_HOME'] = '0';
      const env2 = await buildSandboxEnv(dir, { command: 'firebase deploy' }); // cloud, but forced sandbox
      expect(env2['HOME']).toBe(env2['ANVILWING_SANDBOX_HOME']);
      expect(resolvesToRealHome({ command: 'firebase deploy' })).toBe(false); // label agrees
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('source: the execute_bash label is derived from resolvesToRealHome, not needsRealHome', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'tools', 'bashTools.ts'), 'utf8');
    expect(src).toMatch(/const usesRealHome = resolvesToRealHome\(\{ command \}\)/);
  });
});
