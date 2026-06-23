/**
 * The src/plugins/tools/** ToolPlugin registry (entry: registerDefaultNodeToolPlugins)
 * and src/tools/localExplore.ts were dead: zero production importers. Live tools
 * come from src/capabilities/** → src/tools/* (e.g. fileTools), and live provider
 * plugins from src/plugins/providers/**. This guards that the island stays
 * removed and that the live pieces stay. Runs against the REAL source tree.
 *
 * Fail-before/pass-after: with the island present this test fails (the files
 * exist and the registry symbol is referenced); after deletion it passes.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('dead ToolPlugin registry island stays removed', () => {
  test('the dead files are gone', () => {
    expect(existsSync(resolve(ROOT, 'src/plugins/tools'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'src/plugins/index.ts'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'src/tools/localExplore.ts'))).toBe(false);
  });

  test('no production source references the removed registry or explorer', () => {
    const offenders = tsFiles(resolve(ROOT, 'src')).filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /registerDefaultNodeToolPlugins|localExplore|from ['"][^'"]*plugins\/(index|tools)/.test(s);
    });
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  test('the live provider plugins and tools are kept', () => {
    expect(existsSync(resolve(ROOT, 'src/plugins/providers/index.ts'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/plugins/providers/anvilwing/index.ts'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/providers/baseProvider.ts'))).toBe(true); // audit: keep
    expect(existsSync(resolve(ROOT, 'src/tools/fileTools.ts'))).toBe(true);
  });
});

describe('dead modules from the discovery sweep stay removed (zero importers)', () => {
  // agentWorkerPool (worker-pool spawn path superseded by agentSpawningWiring),
  // commandRegistry (interactiveShell uses its own handleSlashCommand), the
  // vim/autoExecutor/composableMessage shell cluster, and the orphaned env-var
  // providerKeys (contradicts the keychain-only secretStore design) — ~2.5k LOC,
  // each verified to have zero production + test importers before deletion.
  const REMOVED = [
    'src/runtime/agentWorkerPool.ts',
    'src/shell/commandRegistry.ts',
    'src/shell/vimMode.ts',
    'src/shell/autoExecutor.ts',
    'src/shell/composableMessage.ts',
    'src/core/providerKeys.ts',
  ];
  test.each(REMOVED)('%s is gone', (rel) => {
    expect(existsSync(resolve(ROOT, rel))).toBe(false);
  });

  test('no source imports any of the removed modules', () => {
    const re = /from ['"][^'"]*\/(agentWorkerPool|commandRegistry|vimMode|autoExecutor|composableMessage|providerKeys)['"]/;
    const offenders = tsFiles(resolve(ROOT, 'src')).filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  test('the live shell modules are kept', () => {
    expect(existsSync(resolve(ROOT, 'src/shell/toolPresentation.ts'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/shell/liveStatus.ts'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/shell/systemPrompt.ts'))).toBe(true);
  });
});
