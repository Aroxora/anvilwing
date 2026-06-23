/**
 * formatErrorForDisplay — provider/runtime errors render as ONE compact block,
 * never a multi-KB wall of red. Provider SDK errors embed the entire HTTP
 * response body in .message (a Cloudflare 502 HTML page is ~5KB; a 400
 * context-length JSON ~3KB); before this formatter the transcript got that
 * verbatim — twice (once from the 'error' event, once from the sink
 * rejection). The shell also dedupes via lastShownTurnError (source-asserted).
 */

import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatErrorForDisplay } from '../../src/core/errorDisplay.js';

describe('formatErrorForDisplay', () => {
  test('a 5KB Cloudflare-style HTML 502 collapses to status + title', () => {
    const body = `502 <!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>${'x'.repeat(5000)}</body></html>`;
    const out = formatErrorForDisplay(body);
    expect(out.length).toBeLessThan(120);
    expect(out).toContain('502');
    expect(out).toContain('Bad Gateway');
    expect(out).toContain('[full body omitted]');
    expect(out).not.toContain('<body>');
  });

  test('a long JSON error is capped with head and tail kept', () => {
    const msg = `400 This model's maximum context length is exceeded. ${JSON.stringify({ error: { message: 'y'.repeat(3000), type: 'invalid_request_error' } })}`;
    const out = formatErrorForDisplay(msg);
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('maximum context length');
    expect(out).toMatch(/chars omitted/);
  });

  test('short ordinary errors pass through unchanged', () => {
    expect(formatErrorForDisplay('ECONNRESET: socket hang up')).toBe('ECONNRESET: socket hang up');
  });

  test('ANSI escapes are stripped (defense in depth)', () => {
    expect(formatErrorForDisplay('\x1b[31mred\x1b[0m failure \x1b[2Jclear')).toBe('red failure clear');
  });

  test('empty/nullish input never renders blank', () => {
    expect(formatErrorForDisplay('')).toBe('Unknown error');
    expect(formatErrorForDisplay('   ')).toBe('Unknown error');
  });
});

describe('shell wiring (source guards)', () => {
  const shell = readFileSync(resolve(__dirname, '..', '..', 'src', 'headless', 'interactiveShell.ts'), 'utf8');

  test('both render sites route through the formatter and dedupe via lastShownTurnError', () => {
    expect(shell).toMatch(/const shown = formatErrorForDisplay\(event\.error\)/);
    expect(shell).toMatch(/const shown = formatErrorForDisplay\(message\)/);
    expect(shell).toMatch(/shown !== this\.lastShownTurnError/);
    expect(shell).toMatch(/this\.lastShownTurnError = null;/); // per-turn reset
  });

  test('the post-turn pipeline is guarded and the fire-and-forget submit has a catch', () => {
    expect(shell).toMatch(/} catch \(postTurnError\) \{/);
    expect(shell).toMatch(/void this\.processPrompt\(trimmed\)\.catch/);
  });

  test('iterateWithTimeout clears its race timer (no 10-min timer per event)', () => {
    expect(shell).toMatch(/clearTimeout\(timeoutId\)/);
  });
});
