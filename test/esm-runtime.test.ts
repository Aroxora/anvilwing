/**
 * Regression guard for the ESM/CJS bug that shipped a broken binary:
 * `unifiedCodingCapability` used a bare `require()` inside the agent's
 * tool-suite build. The package is "type":"module", so `require` is
 * undefined at runtime — every real `chat()` threw
 * `ReferenceError: require is not defined` while the unit suite (stub
 * providers, NODE_ENV=test) stayed green because it never built the
 * real spawn-tools path.
 *
 * Two assertions per the repo's discipline:
 *  1. RUNTIME — build the real LeanAgent from the real dist; constructing
 *     it runs initializeCapability → buildToolSuite → createAgentSpawnTools,
 *     i.e. the formerly-broken code path. No network: the stub provider is
 *     stored, never called.
 *  2. SOURCE — no bare `require(` survives anywhere in src/ (createRequire
 *     is allowed). Catches a refactor that reintroduces the pattern.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

describe('ESM runtime — agent path has no bare require()', () => {
  test('the real LeanAgent builds its tool suite without "require is not defined"', () => {
    const dist = join(repoRoot, 'dist', 'leanAgent.js');
    expect(existsSync(dist)).toBe(true); // pretest builds dist

    const script = `
      import { createLeanAgent } from './dist/leanAgent.js';
      const stub = { generate: async () => ({ content: '' }), listModels: async () => [], countTokens: async () => 0 };
      const agent = createLeanAgent({ provider: stub, providerId: 'stub', modelId: 'stub-model', systemPrompt: 'test', workingDir: process.cwd() });
      if (typeof agent.chat !== 'function') { console.error('NO_CHAT'); process.exit(2); }
      console.log('AGENT_BUILT_OK');
    `;
    let out = '';
    expect(() => {
      out = execFileSync('node', ['--input-type=module', '-e', script], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 25000,
      });
    }).not.toThrow();
    expect(out).toContain('AGENT_BUILT_OK');
    expect(out).not.toMatch(/require is not defined/i);
  }, 30000); // spawns a child node + loads the real ESM dist; generous under parallel load

  test('no bare require( in src/ (createRequire excepted)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return; // comment/JSDoc
          const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''); // strip inline comments
          if (/\brequire\s*\(/.test(code) && !/createRequire/.test(code)) {
            offenders.push(`${p}:${i + 1}: ${trimmed}`);
          }
        });
      }
    };
    walk(join(repoRoot, 'src'));
    expect(offenders).toEqual([]);
  });
});
