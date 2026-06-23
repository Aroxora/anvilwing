/**
 * Real coverage for the ToolRuntime result cache (src/core/toolRuntime.ts).
 * Three confirmed defects: (1) read results (incl. "Error: ..." strings) were
 * cached for 5 minutes with no write-invalidation, so the agent re-read stale
 * content / a stale ENOENT after its own edits; (2) failures were cached;
 * (3) the cache was an unbounded Map (full file contents) that never evicted.
 *
 * Drives the REAL ToolRuntime with registered tools whose handlers return
 * controlled values — no mock stands in for the cache.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolRuntime, type ToolDefinition } from '../../src/core/toolRuntime.js';
import type { ToolCallRequest } from '../../src/core/types.js';

const src = readFileSync(resolve(__dirname, '..', '..', 'src', 'core', 'toolRuntime.ts'), 'utf8');

const call = (name: string, args: Record<string, unknown> = {}): ToolCallRequest =>
  ({ id: 'x', name, arguments: args } as ToolCallRequest);

const loose = { type: 'object' as const, properties: { path: { type: 'string' } }, additionalProperties: true };

function readTool(handler: () => string): ToolDefinition {
  return { name: 'Read', description: 'read', parameters: loose, cacheable: true, handler };
}
function editTool(handler: () => string): ToolDefinition {
  return { name: 'Edit', description: 'edit', parameters: loose, cacheable: false, handler };
}

function makeRuntime(tools: ToolDefinition[]): ToolRuntime {
  return new ToolRuntime(tools, { enableCache: true, cacheTTLMs: 60_000, workingDir: process.cwd() });
}

describe('ToolRuntime cache — freshness, no-error-caching, bounded size', () => {
  test('cache is genuinely active (identical reads are served from cache)', async () => {
    let content = 'ORIGINAL';
    const rt = makeRuntime([readTool(() => content)]);
    const a = await rt.execute(call('Read', { path: 'b.ts' }));
    content = 'CHANGED-EXTERNALLY';
    const b = await rt.execute(call('Read', { path: 'b.ts' }));
    expect(a).toContain('ORIGINAL');
    expect(b).toBe('ORIGINAL'); // served from cache, not re-run
  });

  test('a successful edit invalidates the read cache (no stale re-read)', async () => {
    let content = 'OLD';
    const rt = makeRuntime([
      readTool(() => content),
      editTool(() => {
        content = 'NEW';
        return 'Updated a.ts';
      }),
    ]);
    const before = await rt.execute(call('Read', { path: 'a.ts' })); // OLD, cached
    await rt.execute(call('Edit', { path: 'a.ts' })); // mutates + clears cache
    const after = await rt.execute(call('Read', { path: 'a.ts' })); // re-executes
    expect(before).toContain('OLD');
    expect(after).toContain('NEW');
  });

  test('an error output is never cached (re-read sees the file once it exists)', async () => {
    let attempt = 0;
    const rt = makeRuntime([
      readTool(() => (attempt++ === 0 ? 'Error: File not found' : 'real contents')),
    ]);
    const first = await rt.execute(call('Read', { path: 'c.ts' }));
    const second = await rt.execute(call('Read', { path: 'c.ts' }));
    expect(first).toContain('Error: File not found');
    expect(second).toContain('real contents');
  });

  test('the cache is bounded (cannot grow without limit)', async () => {
    const rt = makeRuntime([readTool(() => 'x')]);
    for (let i = 0; i < 260; i++) {
      await rt.execute(call('Read', { path: `f${i}.ts` }));
    }
    expect(rt.getCacheStats().entries).toBeLessThanOrEqual(200);
  });

  test('source: failure guard, size bound, and mutation invalidation are present', () => {
    expect(src).toMatch(/MAX_CACHE_ENTRIES\s*=\s*\d+/);
    expect(src).toMatch(/canUseCache && !outputIsError/);
    // Invalidate on ANY side-effecting (non-cacheable) tool — even one whose
    // output looked like an error, since it may still have mutated state.
    expect(src).toMatch(/if \(!isCacheable\)\s*\{\s*this\.cache\.clear\(\)/);
  });
});
