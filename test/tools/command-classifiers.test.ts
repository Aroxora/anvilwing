/**
 * The cloud-CLI (needsRealHome) and interactive-command classifiers matched a
 * bare \btool\b ANYWHERE in the command, so innocuous lines misfired: `echo
 * "let's fly"` / `cat az.txt` ran against the REAL home (exposing credentials),
 * and `cat login.txt` / `grep ftp x` were refused as "interactive". Both now
 * match only at a command position (start / pipeline segment, after benign
 * prefixes like sudo/env/npx).
 */
import { describe, expect, test, afterEach, beforeEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolvesToRealHome, createBashTools } from '../../src/tools/bashTools.js';

afterEach(() => { delete process.env['ANVILWING_PRESERVE_HOME']; });

describe('needsRealHome — cloud CLI must be INVOKED, not merely mentioned', () => {
  const realHome = (command: string) => {
    delete process.env['ANVILWING_PRESERVE_HOME'];
    return resolvesToRealHome({ command });
  };

  test('actual cloud-CLI invocations preserve the real home', () => {
    expect(realHome('firebase deploy')).toBe(true);
    expect(realHome('aws s3 ls')).toBe(true);
    expect(realHome('cd web && firebase deploy')).toBe(true);
    expect(realHome('sudo firebase deploy')).toBe(true);
    expect(realHome('npx vercel --prod')).toBe(true);
    expect(realHome('npm publish')).toBe(true);
  });

  test('innocuous commands that merely mention the token stay SANDBOXED', () => {
    expect(realHome('echo "let us fly to the moon"')).toBe(false);
    expect(realHome('cat az.txt')).toBe(false);
    expect(realHome('grep aws config.json')).toBe(false);
    expect(realHome('ls helm/')).toBe(false);
    expect(realHome('echo gh is a tool')).toBe(false);
  });
});

describe('interactive classifier — only blocks real interactive commands', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cmd-classify-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const bash = () => createBashTools(dir).find((t) => t.name === 'execute_bash')!.handler as (a: Record<string, unknown>) => Promise<string>;

  test('a file named login/ftp is not refused as interactive', async () => {
    writeFileSync(join(dir, 'login.txt'), 'NEEDLE_LOGIN_CONTENT\n');
    const out = await bash()({ command: 'cat login.txt' });
    expect(out).toContain('NEEDLE_LOGIN_CONTENT');
    expect(out).not.toContain('requires interactive authentication');
  });

  test('a genuine interactive command is still blocked', async () => {
    const out = await bash()({ command: 'passwd' });
    expect(out).toContain('requires interactive authentication');
  });
});
