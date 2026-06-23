import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderId, ConversationMessage, ProviderToolDefinition } from '../src/core/types.js';
import type { ProviderResponse } from '../src/core/types.js';
import type { LLMProvider } from '../src/core/types.js';
import { registerProvider, createProvider } from '../src/providers/providerFactory.js';

function createStubProvider(id: ProviderId, model: string): LLMProvider {
  return {
    id,
    model,
    async generate(_messages: ConversationMessage[], _tools: ProviderToolDefinition[]): Promise<ProviderResponse> {
      return { type: 'message', content: `${id}:${model}`, usage: null };
    },
  };
}

describe('test/providerFactory.test.ts', () => {
  it('createProvider returns the registered provider implementation', () => {
    const providerId = 'test-provider-create' as ProviderId;
    registerProvider(providerId, (config) => createStubProvider(providerId, config.model));
    const provider = createProvider({ provider: providerId, model: 'demo-model' });
    assert.equal(provider.id, providerId);
    assert.equal(provider.model, 'demo-model');
  });

  it('registerProvider rejects duplicate registrations without override', () => {
    const providerId = 'test-provider-duplicate' as ProviderId;
    registerProvider(providerId, (config) => createStubProvider(providerId, config.model));
    assert.throws(() => {
      registerProvider(providerId, (config) => createStubProvider(providerId, config.model));
    }, /already registered/);
  });
});