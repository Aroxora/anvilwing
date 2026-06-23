/**
 * agentSchemaLoader drives the REAL loader against the REAL
 * src/contracts/agent-schemas.json. The previous version of this test
 * jest.mock()'d the entire module and asserted only on hand-written literals —
 * it never executed a line of the loader (which uses import.meta.url and so
 * can't be imported by jest's CJS transform). Per CLAUDE.md "tests run real",
 * we instead run the loader in a real ESM node child against the built dist —
 * the repo's established pattern for import.meta SUTs (see test/esm-runtime.test.ts
 * and test/sessionStore.test.ts) — and assert its output equals the real
 * manifest on disk. Corrupting the manifest or breaking the parse now turns this
 * red; the old mock stayed green regardless.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

interface LoaderOutput {
  schemas: { contractVersion: string; version: string };
  providers: Array<{ id: string; label: string }>;
  provider_anvilwing: { id: string; label: string } | null;
  provider_unknown: unknown | null;
  models: Array<{ id: string; provider: string }>;
  model_v4: { id: string; provider: string } | null;
  model_unknown: unknown | null;
  models_by_anvilwing: Array<{ provider: string }>;
  profiles: Array<{ name: string }>;
  slashCommands: unknown[];
  capabilities: unknown[];
  isValidProvider_anvilwing: boolean;
  isValidProvider_nope: boolean;
  isValidModel_v4: boolean;
  isValidModel_nope: boolean;
  isValidProfile_code: boolean;
  isValidProfile_nope: boolean;
}

function runRealLoader(): LoaderOutput {
  const dist = join(repoRoot, 'dist', 'core', 'agentSchemaLoader.js');
  expect(existsSync(dist)).toBe(true); // pretest builds dist
  const script = `
    import * as L from './dist/core/agentSchemaLoader.js';
    const out = {
      schemas: L.getAgentSchemas(),
      providers: L.getProviders(),
      provider_anvilwing: L.getProvider('anvilwing') ?? null,
      provider_unknown: L.getProvider('nope') ?? null,
      models: await L.getModels(),
      model_v4: (await L.getModel('anvilwing')) ?? null,
      model_unknown: (await L.getModel('nope')) ?? null,
      models_by_anvilwing: await L.getModelsByProvider('anvilwing'),
      profiles: L.getProfiles(),
      slashCommands: L.getSlashCommands(),
      capabilities: L.getCapabilities(),
      isValidProvider_anvilwing: L.isValidProvider('anvilwing'),
      isValidProvider_nope: L.isValidProvider('nope'),
      isValidModel_v4: await L.isValidModel('anvilwing'),
      isValidModel_nope: await L.isValidModel('nope'),
      isValidProfile_code: L.isValidProfile('anvilwing-code'),
      isValidProfile_nope: L.isValidProfile('nope'),
    };
    process.stdout.write('JSON_START' + JSON.stringify(out) + 'JSON_END');
  `;
  const raw = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 25000,
  });
  const m = raw.match(/JSON_START([\s\S]*)JSON_END/);
  if (!m) throw new Error('real loader produced no JSON. output:\n' + raw.slice(0, 800));
  return JSON.parse(m[1]) as LoaderOutput;
}

describe('agentSchemaLoader — real loader vs real agent-schemas.json', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const truth: any = JSON.parse(readFileSync(join(repoRoot, 'src/contracts/agent-schemas.json'), 'utf8'));
  let L: LoaderOutput;
  beforeAll(() => { L = runRealLoader(); }, 30000);

  test('getAgentSchemas returns the manifest actually on disk', () => {
    expect(L.schemas.contractVersion).toBe(truth.contractVersion);
    expect(L.schemas.version).toBe(truth.version);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.providers.map((p) => p.id)).toEqual(truth.providers.map((p: any) => p.id));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.models.map((m) => m.id)).toEqual(truth.models.map((m: any) => m.id));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(L.profiles.map((p) => p.name)).toEqual(truth.profiles.map((p: any) => p.name));
    expect(Array.isArray(L.slashCommands)).toBe(true);
    expect(Array.isArray(L.capabilities)).toBe(true);
  });

  test('provider lookups resolve real entries; unknown → undefined', () => {
    expect(L.provider_anvilwing?.id).toBe('anvilwing');
    expect(L.provider_anvilwing?.label).toBe('Anvilwing');
    expect(L.provider_unknown).toBeNull();
    expect(L.isValidProvider_anvilwing).toBe(true);
    expect(L.isValidProvider_nope).toBe(false);
  });

  test('model lookups resolve real entries; unknown → undefined', () => {
    expect(L.model_v4?.id).toBe('anvilwing');
    expect(L.model_v4?.provider).toBe('anvilwing');
    expect(L.model_unknown).toBeNull();
    expect(L.models_by_anvilwing.length).toBeGreaterThan(0);
    expect(L.models_by_anvilwing.every((m) => m.provider === 'anvilwing')).toBe(true);
    expect(L.isValidModel_v4).toBe(true);
    expect(L.isValidModel_nope).toBe(false);
  });

  test('profile lookups resolve real entries', () => {
    expect(L.profiles.some((p) => p.name === 'anvilwing-code')).toBe(true);
    expect(L.isValidProfile_code).toBe(true);
    expect(L.isValidProfile_nope).toBe(false);
  });
});
