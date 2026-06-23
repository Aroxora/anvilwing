/**
 * Boot contract: bare `anvilwing` opens straight into the Ink chat (like
 * `claude`) with NO marketing splash — no "freedom coding CLI" banner, no
 * gradient brand line, no ero.solar / npm links. The only thing shown is the
 * load-bearing status: how to set a key, or the active model + masked key.
 *
 * This is the PTY-free, environment-independent verification of that contract
 * (a real boot needs a forkable PTY, which sandboxed CI / this dev box can't
 * always provide — see test/e2e-ink-cli.test.ts, which skips when node-pty
 * can't fork). It exercises the REAL compiled artifact: the dist exports
 * composeWelcomeLines() (the single source of truth for WHICH welcome lines
 * appear) but is ESM-with-import.meta, so jest can't import it in-process —
 * we spawn a child `node` that imports the dist, the same pattern the repo's
 * esm-runtime / print-mode tests use.
 *
 * Two assertions per CLAUDE.md: behavioural (run the real composer) + source
 * (dist string-guard so a refactor that re-adds the splash fails at CI time).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
const dist = join(repoRoot, 'dist', 'headless', 'interactiveShell.js');
// On Windows, Node ESM imports require a file:// URL — passing a raw
// "C:\\…" path makes the loader treat "c:" as the scheme and throw.
const distUrl = pathToFileURL(dist).href;

/** Run composeWelcomeLines() from the REAL dist in a child node and return its lines joined. */
function welcome(input: Record<string, unknown>): string {
  const script = `
    import { composeWelcomeLines } from ${JSON.stringify(distUrl)};
    const lines = composeWelcomeLines(${JSON.stringify(input)});
    process.stdout.write('WELCOME_START\\n' + lines.join('\\n') + '\\nWELCOME_END');
  `;
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
  });
  return out.slice(out.indexOf('WELCOME_START') + 'WELCOME_START\n'.length, out.indexOf('\nWELCOME_END'));
}

const SPLASH = [/freedom coding CLI/i, /Anvilwing Coder —/i, /npmjs\.com/i, /ero\.solar/i];

describe('boot welcome — no marketing splash, key guidance kept', () => {
  beforeAll(() => {
    expect(existsSync(dist)).toBe(true); // pretest builds dist
  });

  test('no-key boot shows ONLY key-setup guidance, no splash', () => {
    const text = welcome({ hasApiKey: false, maskedKey: '', model: 'anvilwing', provider: 'anvilwing' });
    expect(text).toMatch(/No Anvilwing API key configured/);
    // Bring-your-own-key only — no sign-in.
    expect(text).not.toMatch(/\/login/);
    expect(text).toMatch(/\/key sk-/);
    expect(text).toMatch(/\/key tvly-/);
    for (const re of SPLASH) expect(text).not.toMatch(re);
  });

  test('version is shown in the welcome title', () => {
    const text = welcome({ hasApiKey: false, maskedKey: '', model: 'anvilwing', provider: 'anvilwing', version: 'v1.2.3' });
    expect(text).toMatch(/Welcome to Anvilwing Coder v1\.2\.3/);
  });

  test('keyed boot shows model + help hint — no provider chip, NO key material (§7)', () => {
    const text = welcome({ hasApiKey: true, maskedKey: 'sk-abc…wxyz', model: 'anvilwing', provider: 'anvilwing' });
    expect(text).toMatch(/anvilwing · \/help for commands/);
    // Claude Code never surfaces credentials in the banner; /keys shows the
    // masked key on demand.
    expect(text).not.toMatch(/sk-abc/);
    expect(text).not.toMatch(/No Anvilwing API key configured/);
    for (const re of SPLASH) expect(text).not.toMatch(re);
  });

  test('update line is carried through when present', () => {
    const text = welcome({ hasApiKey: false, maskedKey: '', model: 'm', provider: 'p', updateLines: ['  ⬆ Update available: v1 → v2'] });
    expect(text).toMatch(/Update available: v1 → v2/);
  });

  // Source-string guard: a refactor that re-adds the splash to the built shell
  // must fail here, not silently ship (the boot is hard to e2e in CI).
  test('compiled shell carries no splash banner', () => {
    const src = readFileSync(dist, 'utf8');
    expect(src).not.toMatch(/freedom coding CLI/i);
    expect(src).not.toMatch(/BANNER_GRADIENT/);
    expect(src).not.toMatch(/gradientString/);
    expect(src).toMatch(/No Anvilwing API key configured/); // key-guidance contract still compiled in
    expect(src).toMatch(/\/key tvly-/);                    // Tavily BYO key guidance compiled in
  });
});
