import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

function runResolveProfile(envOverrides: Record<string, string | undefined>): SpawnSyncReturns<string> {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return spawnSync(
    'node',
    [
      '--loader',
      'ts-node/esm',
      '-e',
      `
        import { resolveProfileConfig } from './src/config.js';
        const cfg = resolveProfileConfig('anvilwing-code', null);
        console.log(JSON.stringify({ provider: cfg.provider, model: cfg.model, providerLocked: cfg.providerLocked }));
      `,
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    }
  );
}

describe('resolveProfileConfig model/provider alignment (ts-node)', () => {
  it('defaults to anvilwing when no env overrides', () => {
    const result = runResolveProfile({
      ANVILWING_CODE_MODEL: undefined,
      ANVILWING_CODE_PROVIDER: undefined,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { provider: string; model: string; providerLocked: boolean };
    expect(payload.model).toBe('anvilwing');
    expect(payload.provider).toBe('anvilwing');
  });

  it('IGNORES a _MODEL env override — the model is hard-locked to anvilwing', () => {
    // Fail-before: this returned anvilwing-chat (the override was honored).
    // The product supports anvilwing ONLY; the override is now ignored.
    const result = runResolveProfile({
      ANVILWING_CODE_MODEL: 'anvilwing-chat',
      ANVILWING_CODE_PROVIDER: undefined,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { provider: string; model: string; providerLocked: boolean };
    expect(payload.model).toBe('anvilwing');
    expect(payload.provider).toBe('anvilwing');
    expect(payload.providerLocked).toBe(true);
  });

  it('IGNORES a _PROVIDER env override — the provider is hard-locked to anvilwing', () => {
    const result = runResolveProfile({
      ANVILWING_CODE_MODEL: 'gpt-4o',
      ANVILWING_CODE_PROVIDER: 'openai',
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { provider: string; model: string };
    expect(payload.model).toBe('anvilwing');
    expect(payload.provider).toBe('anvilwing');
  });
});
