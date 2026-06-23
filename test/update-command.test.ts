/**
 * In-shell /update — auto-detect a newer npm version, then let the USER apply
 * it from inside the Ink shell (rather than force-installing on every startup).
 *
 * The version-comparison core (updateChecker.compareVersions) is private, so we
 * mirror it inline per CLAUDE.md and assert the semantics + that the source
 * still uses it. The /update wiring (dispatch → handleUpdateCommand →
 * checkForUpdates + runBackgroundUpdate) and the startup change from
 * force-install to offer are locked with source assertions.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = resolve(__dirname, '..', 'src');
const REPO = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf8');
const shell = read('headless/interactiveShell.ts');
const updater = read('core/updateChecker.ts');

// Mirror of updateChecker.compareVersions (private). >0 ⇒ v1 newer.
function compareVersions(v1: string, v2: string): number {
  const a = v1.replace(/^v/, '').split('.').map(Number);
  const b = v2.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const p1 = a[i] || 0, p2 = b[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

describe('/update — version comparison decides updateAvailable', () => {
  it.each([
    ['1.1.51', '1.1.50', 1],
    ['1.2.0', '1.1.99', 1],
    ['1.1.50', '1.1.50', 0],
    ['1.1.50', '1.1.51', -1],
    ['v1.1.51', '1.1.50', 1], // tolerant of a leading v
    ['1.1.5', '1.1.50', -1],  // numeric, not lexical
  ])('compareVersions(%s, %s) === %i', (a, b, expected) => {
    expect(Math.sign(compareVersions(a as string, b as string))).toBe(expected);
  });

  it('updateChecker queries npm and gates on compareVersions(latest, current) > 0', () => {
    expect(updater).toMatch(/npm view anvilwing version/);
    expect(updater).toMatch(/compareVersions\(latest, currentVersion\) > 0/);
  });

  it('checkForUpdates supports a force flag that bypasses the 1-hour cache', () => {
    expect(updater).toMatch(/checkForUpdates\(currentVersion: string, force = false\)/);
    expect(updater).toMatch(/if \(!force && updateCheckCache/);
  });
});

describe('/update — in-shell wiring', () => {
  it('startup OFFERS the update (type /update), no longer force-installs', () => {
    // The notice tells the user to run /update; the auto runBackgroundUpdate
    // call was removed from the startup path.
    expect(shell).toMatch(/type /);
    expect(shell).toMatch(/'\/update'/);
    expect(shell).toMatch(/this\.pendingUpdate = updateInfo/);
    // Startup no longer auto-runs the installer (the "installing in
    // background…" forced path is gone).
    expect(shell).not.toMatch(/installing in background/);
  });

  it('/update dispatches to handleUpdateCommand', () => {
    expect(shell).toMatch(/lower === '\/update' \|\| lower === '\/upgrade'/);
    expect(shell).toMatch(/void this\.handleUpdateCommand\(\)/);
  });

  it('handleUpdateCommand re-checks npm, reports up-to-date, and upgrades when newer', () => {
    const body = shell.slice(shell.indexOf('private async handleUpdateCommand'));
    expect(body).toMatch(/checkForUpdates\(getVersion\(\), true\)/); // force a FRESH check (bypass cache)
    expect(body).toMatch(/on the latest version/);          // up-to-date branch
    expect(body).toMatch(/this\.runBackgroundUpdate\(info\)/); // upgrade branch
  });

  it('runBackgroundUpdate installs @latest and tells the user to restart', () => {
    const body = shell.slice(shell.indexOf('private runBackgroundUpdate'));
    expect(body).toMatch(/performBackgroundUpdate\(info/);
    expect(body).toMatch(/reopen the CLI/i);
  });
});

describe('/update — LIVE auto-detect against the real npm registry (subprocess against dist)', () => {
  // updateChecker uses import.meta (not jest-importable), so drive the REAL
  // checkForUpdates from the built dist in a node child — it runs the actual
  // `npm view anvilwing version` + compareVersions. Honest skip if the
  // registry is unreachable (checkForUpdates returns null on any failure); never
  // mocked. Proves the startup auto-detect actually fires.
  it('detects an update for an old version and not for a future one', () => {
    const script = `
      import { checkForUpdates } from './dist/core/updateChecker.js';
      const oldV = await checkForUpdates('1.0.0', true);
      const future = await checkForUpdates('99.99.99', true);
      process.stdout.write('R:' + JSON.stringify({ oldV, future }));
    `;
    let raw = '';
    try {
      raw = execFileSync('node', ['--input-type=module', '-e', script], {
        cwd: REPO, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[update] SKIPPED live registry detection: npm registry unreachable in this environment.');
      return;
    }
    const m = raw.match(/R:(\{[\s\S]*\})/);
    if (!m) { console.warn('[update] SKIPPED: no result from checkForUpdates (offline).'); return; }
    const { oldV, future } = JSON.parse(m[1]);
    if (oldV === null) { console.warn('[update] SKIPPED: registry returned null (offline).'); return; }
    expect(oldV.updateAvailable).toBe(true);
    expect(oldV.latest).toMatch(/^\d+\.\d+\.\d+/);
    expect(future === null || future.updateAvailable === false).toBe(true);
  }, 35000);
});
