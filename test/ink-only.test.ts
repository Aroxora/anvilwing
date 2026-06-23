/**
 * Ink-only guard. Asserts that the anvilwing binary's UI surface is
 * served entirely by Ink, with no path back to a legacy custom
 * renderer. The reachability walk mirrors a tsc-like static import
 * trace inline (helpers are not exported from the runtime, so the test
 * is self-contained per the repo's hardening discipline). Source-string
 * assertions catch a refactor that drops the behavioural fix.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const REPO = resolve(__dirname, '..');

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const cands: string[] = [];
  if (/\.(js|jsx)$/.test(base)) {
    const stem = base.replace(/\.(js|jsx)$/, '');
    cands.push(stem + '.ts', stem + '.tsx', base);
  } else {
    cands.push(base + '.ts', base + '.tsx', base);
  }
  cands.push(join(base, 'index.ts'), join(base, 'index.tsx'));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function reachableFrom(entry: string): Set<string> {
  const reachable = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    let src: string;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      const target = resolveSpec(spec, file);
      if (target && !reachable.has(target)) queue.push(target);
    }
  }
  return reachable;
}

describe('renderer: anvilwing uses only Ink', () => {
  const entry = join(REPO, 'src', 'bin', 'anvilwing.ts');
  const srcUi = join(REPO, 'src', 'ui');

  test('every reachable src/ui file is either theme.ts or under ink/', () => {
    const reachable = reachableFrom(entry);
    const uiReached = [...reachable].filter(f => f.startsWith(srcUi + '/'));
    const violators = uiReached
      .map(f => f.slice(srcUi.length + 1))
      .filter(rel => rel !== 'theme.ts' && !rel.startsWith('ink/'))
      .sort();
    expect(violators).toEqual([]);
  });

  test('interactiveShell carries no legacy-renderer wiring', () => {
    const src = readFileSync(join(REPO, 'src', 'headless', 'interactiveShell.ts'), 'utf8');
    expect(src).not.toMatch(/\bANVILWING_INK\b/);
    expect(src).not.toMatch(/legacy renderer|legacy PromptController/i);
  });

  test('createPromptController unconditionally returns InkPromptController', () => {
    const src = readFileSync(join(REPO, 'src', 'ui', 'ink', 'InkPromptController.ts'), 'utf8');
    expect(src).toMatch(/export async function createPromptController/);
    expect(src).toMatch(/return new InkPromptController\(/);
    expect(src).not.toMatch(/\bANVILWING_INK\b/);
  });
});
