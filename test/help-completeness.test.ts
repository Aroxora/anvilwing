/**
 * /help discoverability guard. The interactive `/help` panel (showHelp) is the
 * command reference; if a real, user-facing command isn't listed there it is
 * effectively undiscoverable. The command surface was trimmed to the lean set
 * (anvilwing is locked, ultracode is always on) — this guards that the
 * kept commands stay documented AND that the removed ones stay gone, in both
 * the /help panel and the dispatch. Source assertion (the panel is a static
 * lines[] array; the dispatch is `lower === '/x'` checks).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHELL = resolve(__dirname, '..', 'src', 'headless', 'interactiveShell.ts');
const src = readFileSync(SHELL, 'utf8');

// The help panel is assembled from `cmd('/x ...')` entries in showHelp().
const helpCommands = new Set(
  [...src.matchAll(/cmd\('(\/[a-zA-Z]+)/g)].map((m) => m[1]),
);

describe('/help lists only the user actions: /key, /update, /resume, /context, /cost, /diff, /rewind', () => {
  test('the help command set is exactly the kept actions/views', () => {
    expect(helpCommands.has('/key')).toBe(true);
    expect(helpCommands.has('/update')).toBe(true);
    expect(helpCommands.has('/resume')).toBe(true);
    expect(helpCommands.has('/context')).toBe(true);
    expect(helpCommands.has('/cost')).toBe(true);
    expect(helpCommands.has('/diff')).toBe(true);
    expect(helpCommands.has('/rewind')).toBe(true);
    // No sign-in (/login, /account removed) and no toggles — everything else is
    // on by default. These are all actions or views, not feature switches: /key
    // sets the key, /update upgrades from npm, /resume restores a past
    // conversation, /context shows window usage, /cost shows spend, /diff
    // reviews changes this run, /rewind undoes them.
    expect([...helpCommands].sort()).toEqual(['/context', '/cost', '/diff', '/key', '/resume', '/rewind', '/update']);
  });

  test('/help tells the user everything else is automatic', () => {
    expect(src).toMatch(/Everything else runs automatically —/);
    expect(src).toMatch(/ultracode · adversarial verifier, all on/);
  });
});

describe('removed commands stay removed (no /help listing, no dispatch)', () => {
  const REMOVED = ['/model', '/secrets', '/ultracode', '/email', '/auto', '/adversarial', '/debug',
    // hosting/login subsystem removed entirely — bring-your-own-key only.
    '/login', '/logout', '/account'];
  test.each(REMOVED)('%s is not listed in /help', (cmdName) => {
    expect(helpCommands.has(cmdName)).toBe(false);
  });

  test('the dispatch no longer handles the removed toggle commands', () => {
    expect(src).not.toMatch(/lower === '\/model'/);
    expect(src).not.toMatch(/lower\.startsWith\('\/secrets'\)/);
    expect(src).not.toMatch(/lower === '\/ultracode'/);
    expect(src).not.toMatch(/lower\.startsWith\('\/email'\)/);
    expect(src).not.toMatch(/lower === '\/auto'/);
    expect(src).not.toMatch(/lower === '\/adversarial'/);
    expect(src).not.toMatch(/lower\.startsWith\('\/debug'\)/);
  });

  test('the dispatch no longer handles the sign-in commands', () => {
    expect(src).not.toMatch(/lower === '\/login'/);
    expect(src).not.toMatch(/lower === '\/logout'/);
    expect(src).not.toMatch(/lower === '\/account'/);
    expect(src).not.toMatch(/loginViaLoopback|clearHostedSession|handleLogin/);
  });
});
