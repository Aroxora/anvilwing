/**
 * Local usage meter — counts THIS install's Anvilwing tokens + Tavily searches,
 * persisted across sessions, against the shared free-pool quota constants
 * (Tavily 1,000/mo + 5,000 one-time bonus). The per-install half the ero.solar
 * portal aggregates. Deterministic + source guards → runs on CI.
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  recordAnvilwingUsage, recordTavilySearch, getUsage,
  TAVILY_MONTHLY_FREE, TAVILY_ONE_TIME_BONUS,
} from '../src/core/usage';

const SAVED = process.env['ANVILWING_HOME'];
let home = '';
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ero-usage-')); process.env['ANVILWING_HOME'] = home; });
afterEach(() => {
  if (SAVED === undefined) delete process.env['ANVILWING_HOME']; else process.env['ANVILWING_HOME'] = SAVED;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('usage meter', () => {
  test('the shared free-pool quota constants are correct', () => {
    expect(TAVILY_MONTHLY_FREE).toBe(1000);
    expect(TAVILY_ONE_TIME_BONUS).toBe(5000);
  });

  test('Anvilwing tokens accumulate into the persisted cumulative total', () => {
    recordAnvilwingUsage(100, 50);
    recordAnvilwingUsage(10, 5);
    const c = getUsage().cumulative;
    expect(c.anvilwingInputTokens).toBe(110);
    expect(c.anvilwingOutputTokens).toBe(55);
  });

  test('Tavily searches accumulate', () => {
    recordTavilySearch();
    recordTavilySearch();
    expect(getUsage().cumulative.tavilySearches).toBe(2);
  });

  test('session counters rise by exactly the recorded amount', () => {
    const before = getUsage().session;
    recordAnvilwingUsage(7, 3);
    const after = getUsage().session;
    expect(after.anvilwingInputTokens - before.anvilwingInputTokens).toBe(7);
    expect(after.anvilwingOutputTokens - before.anvilwingOutputTokens).toBe(3);
  });

  test('invalid / negative counts are ignored (no write)', () => {
    recordAnvilwingUsage(-5, NaN);
    recordAnvilwingUsage(undefined, 'x');
    const c = getUsage().cumulative;
    expect(c.anvilwingInputTokens).toBe(0);
    expect(c.anvilwingOutputTokens).toBe(0);
  });

  test('cumulative persists to disk (survives a fresh read)', () => {
    recordTavilySearch();
    recordAnvilwingUsage(42, 0);
    const onDisk = JSON.parse(readFileSync(join(home, 'usage.json'), 'utf8'));
    expect(onDisk.tavilySearches).toBe(1);
    expect(onDisk.anvilwingInputTokens).toBe(42);
  });
});

describe('the meter is actually wired into the agent + search paths', () => {
  test('WebSearch records a Tavily search', () => {
    const web = readFileSync(resolve(__dirname, '..', 'src/tools/webTools.ts'), 'utf8');
    expect(web).toMatch(/recordTavilySearch\(\)/);
  });
  test('the usage event records Anvilwing tokens', () => {
    const shell = readFileSync(resolve(__dirname, '..', 'src/headless/interactiveShell.ts'), 'utf8');
    expect(shell).toMatch(/recordAnvilwingUsage\(event\.inputTokens, event\.outputTokens\)/);
  });
});
