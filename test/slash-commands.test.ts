/**
 * `/`-command autocomplete (Claude Code parity, the `/` half mirroring the
 * `@`-mention palette). Deterministic logic + a catalog-drift guard — both run
 * on CI (no PTY / no Ink mount). The real-binary render is proven separately in
 * the PTY e2e (pre-push); here we lock the partial-detection, ranking,
 * completion, and the invariant that every palette command is actually handled
 * by interactiveShell.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SLASH_COMMANDS,
  activeSlashPartial,
  rankCommandMatches,
  applySlashCompletion,
} from '../src/core/slashCommands';

describe('activeSlashPartial — only the first token, only at buffer start', () => {
  test.each([
    ['/', 1, ''],
    ['/c', 2, 'c'],
    ['/clear', 6, 'clear'],
    ['/clear ', 7, null],          // a space → entering args, palette closes
    ['/key sk-abc', 11, null],     // arg typed
    ['hello /x', 8, null],         // slash not at the start
    ['', 0, null],
    ['x', 1, null],
  ])('%j @%i → %j', (text, cursor, expected) => {
    expect(activeSlashPartial(text as string, cursor as number)).toBe(expected);
  });

  test('uses the cursor, not the full text', () => {
    // cursor sits right after "/co" even though more is typed after it
    expect(activeSlashPartial('/context', 3)).toBe('co');
  });
});

describe('rankCommandMatches', () => {
  test('bare partial returns the catalog (capped)', () => {
    expect(rankCommandMatches('', 8).length).toBe(Math.min(8, SLASH_COMMANDS.length));
  });

  test('prefix match, prefix-first ordering', () => {
    const got = rankCommandMatches('c').map((c) => c.command);
    expect(got).toEqual(expect.arrayContaining(['/clear', '/context']));
    // both start with "c"; shorter command sorts first
    expect(got.indexOf('/clear')).toBeLessThan(got.indexOf('/context'));
  });

  test('exact name matches only that command', () => {
    expect(rankCommandMatches('diff').map((c) => c.command)).toEqual(['/diff']);
  });

  test('no match → empty', () => {
    expect(rankCommandMatches('zzz')).toEqual([]);
  });
});

describe('applySlashCompletion', () => {
  test('fills the command + trailing space and moves the cursor to the end', () => {
    expect(applySlashCompletion('/c', 2, '/clear')).toEqual({ text: '/clear ', cursor: 7 });
  });

  test('preserves any text after the cursor', () => {
    expect(applySlashCompletion('/co', 3, '/context')).toEqual({ text: '/context ', cursor: 9 });
  });

  test('no-op when there is no active slash partial', () => {
    expect(applySlashCompletion('hello', 5, '/clear')).toEqual({ text: 'hello', cursor: 5 });
  });
});

describe('catalog ↔ handler drift guard', () => {
  // Every command offered by the palette must actually be handled by
  // interactiveShell.handleSlashCommand, or the palette would complete to a
  // dead command. Source-string assertion so it runs on CI.
  const shellSrc = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/headless/interactiveShell.ts'),
    'utf8',
  );
  test.each(SLASH_COMMANDS.map((c) => [c.command] as const))(
    '%s is handled in interactiveShell',
    (command) => {
      expect(shellSrc.includes(`'${command}'`) || shellSrc.includes(`'${command} '`)).toBe(true);
    },
  );
});
