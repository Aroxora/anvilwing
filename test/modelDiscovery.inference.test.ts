import type { ProviderId } from '../src/core/types.js';
import * as modelDiscovery from '../src/core/modelDiscovery.js';

const { inferProviderFromModelId, getLatestModelForProvider } = modelDiscovery;

describe('modelDiscovery provider inference', () => {
  it('infers Anvilwing provider from model IDs', () => {
    expect(inferProviderFromModelId('anvilwing')).toBe('anvilwing');
    expect(inferProviderFromModelId('anvilwing-chat')).toBe('anvilwing');
    expect(inferProviderFromModelId('anvilwing-reasoner')).toBe('anvilwing');
  });

  it('returns null for non-Anvilwing model IDs', () => {
    expect(inferProviderFromModelId('gpt-4o')).toBeNull();
    expect(inferProviderFromModelId('claude-3-5-sonnet')).toBeNull();
  });

  it('falls back to safe defaults when no discovered models exist', () => {
    const spy = jest.spyOn(modelDiscovery, 'getCachedDiscoveredModels').mockReturnValue([]);

    expect(getLatestModelForProvider('anvilwing' as ProviderId)).toBe('anvilwing');

    spy.mockRestore();
  });
});
