/**
 * Edit used content-fuzzy (Levenshtein) matching: when old_string wasn't an
 * exact (or whitespace-flexible) match, matchWithFlexibleWhitespace fell back to
 * findBestFuzzyMatch and accepted any block at >=0.92 similarity. So an
 * old_string the model THOUGHT was in the file (a stale value, a transcription
 * slip) silently edited a DIFFERENT ~8%-off block — wrong-target corruption that
 * the model never sees. Claude Code's Edit is exact-string: a non-match FAILS so
 * the agent re-reads and retries. We removed the fuzzy fallback, keeping only
 * whitespace-flexibility (same non-whitespace content, any indent).
 *
 * Drives the REAL Edit tool (createEditTools) against REAL files.
 */

import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEditTools } from '../../src/tools/editTools.js';

let dir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let edit: any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-edit-fuzzy-'));
  edit = createEditTools(dir).find((t) => t.name === 'Edit');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('Edit rejects near-miss old_string instead of fuzzy-editing the wrong block', () => {
  test('single-line near-miss (capMs vs the file’s maxMs) fails, file untouched', async () => {
    const original = 'const t = computeBackoff(attempt, baseMs, maxMs);\n';
    const p = write('a.js', original);
    // old_string differs only in one token (maxMs -> capMs): ~96% similar, so the
    // old fuzzy path matched the maxMs line and silently edited it.
    const out: string = await edit.handler({
      file_path: p,
      old_string: 'const t = computeBackoff(attempt, baseMs, capMs);',
      new_string: 'const t = computeBackoff(attempt, baseMs, 99);',
    });
    expect(out).toMatch(/old_string not found/i);
    expect(fs.readFileSync(p, 'utf8')).toBe(original); // NOT corrupted
  });

  test('multi-line near-miss block (timeout 2000 vs the file’s 1000) fails, file untouched', async () => {
    const original = 'const opts = {\n  retries: 3,\n  timeout: 1000,\n};\n';
    const p = write('b.js', original);
    const out: string = await edit.handler({
      file_path: p,
      old_string: 'const opts = {\n  retries: 3,\n  timeout: 2000,\n};',
      new_string: 'const opts = {\n  retries: 5,\n  timeout: 2000,\n};',
    });
    expect(out).toMatch(/old_string not found/i);
    expect(fs.readFileSync(p, 'utf8')).toBe(original);
  });

  test('two similar blocks: a near-miss does not silently pick one', async () => {
    const original =
      'function getName(u) {\n  return u.profile.fullName;\n}\n\n' +
      'function getMail(u) {\n  return u.profile.mailAddr;\n}\n';
    const p = write('c.js', original);
    // ~93% similar to BOTH blocks; the old fuzzy matcher would edit whichever
    // scored highest. Now it must fail rather than guess.
    const out: string = await edit.handler({
      file_path: p,
      old_string: 'function getMail(u) {\n  return u.profile.mail;\n}',
      new_string: 'function getMail(u) {\n  return u.profile.email;\n}',
    });
    expect(out).toMatch(/old_string not found/i);
    expect(fs.readFileSync(p, 'utf8')).toBe(original);
  });

  // Regression: whitespace-flexibility is SAFE (same non-whitespace content) and
  // MUST be preserved — it's the legitimate "model guessed the indent wrong" case.
  test('whitespace-only difference (wrong indent) STILL matches and edits', async () => {
    const p = write('d.js', 'function f() {\n        return value * 2;\n}\n');
    const out: string = await edit.handler({
      file_path: p,
      old_string: 'return value * 2;', // no indentation
      new_string: 'return value * 3;',
    });
    expect(out).not.toMatch(/old_string not found/i);
    expect(fs.readFileSync(p, 'utf8')).toContain('return value * 3;');
  });

  test('exact match still edits normally', async () => {
    const p = write('e.js', 'let x = 1;\nlet y = 2;\n');
    const out: string = await edit.handler({
      file_path: p,
      old_string: 'let y = 2;',
      new_string: 'let y = 20;',
    });
    expect(out).not.toMatch(/old_string not found/i);
    expect(fs.readFileSync(p, 'utf8')).toBe('let x = 1;\nlet y = 20;\n');
  });

  test('source guard: the fuzzy matcher and its Levenshtein helpers are gone', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'tools', 'editTools.ts'), 'utf8');
    expect(src).not.toMatch(/findBestFuzzyMatch/);
    expect(src).not.toMatch(/levenshteinDistance/);
    expect(src).not.toMatch(/fuzzyMatch\.similarity >= 0\.92/);
    // whitespace-flexible matching is retained
    expect(src).toMatch(/buildWhitespaceFlexiblePattern/);
    expect(src).toMatch(/Whitespace-flexible match ONLY/);
  });
});
