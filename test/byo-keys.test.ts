/**
 * Bring-your-own-key entry: users supply their OWN Anvilwing (required) and
 * Tavily (optional, web search) keys via `/key`, routed by prefix. Locks the
 * routing logic + that the CLI surfaces both forms. Deterministic +
 * source-assertion only (no PTY/Ink) → runs on CI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyKeyEntry, getSecretDefinition } from '../src/core/secretStore';

const REPO = path.resolve(__dirname, '..');

describe('classifyKeyEntry — /key routes to the right secret', () => {
  test.each([
    ['sk-abc123', 'ANVILWING_API_KEY', 'sk-abc123'],
    ['tvly-abc123', 'TAVILY_API_KEY', 'tvly-abc123'],
    ['TVLY-UPPER', 'TAVILY_API_KEY', 'TVLY-UPPER'],          // prefix is case-insensitive
    ['tavily tvly-xyz', 'TAVILY_API_KEY', 'tvly-xyz'],       // explicit provider word
    ['anvilwing sk-xyz', 'ANVILWING_API_KEY', 'sk-xyz'],
    ['noprefixkey', 'ANVILWING_API_KEY', 'noprefixkey'],      // back-compat: default to Anvilwing
  ])('%j → %s', (raw, id, value) => {
    expect(classifyKeyEntry(raw as string)).toEqual({ id, value });
  });

  test.each(['', '   ', 'tavily', 'anvilwing'])('blank/word-only %j → null', (raw) => {
    expect(classifyKeyEntry(raw)).toBeNull();
  });

  test('both keys are real, labelled secrets in the store', () => {
    expect(getSecretDefinition('ANVILWING_API_KEY')?.label).toMatch(/Anvilwing/i);
    expect(getSecretDefinition('TAVILY_API_KEY')?.label).toMatch(/Tavily/i);
  });
});

describe('CLI surfaces both /key forms and routes through classifyKeyEntry', () => {
  const shell = fs.readFileSync(path.join(REPO, 'src/headless/interactiveShell.ts'), 'utf8');
  test('/key handler routes via classifyKeyEntry', () => {
    expect(shell).toMatch(/classifyKeyEntry\(/);
  });
  test('welcome + help offer the Anvilwing (sk-) and Tavily (tvly-) forms', () => {
    expect(shell).toMatch(/\/key sk-/);
    expect(shell).toMatch(/\/key tvly-/);
  });
});
