import type {
  LLMProvider,
  ProviderId,
  ReasoningEffortLevel,
  TextVerbosityLevel,
  ThinkingBudgetConfig,
  ThinkingLevel,
} from '../core/types.js';

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffortLevel;
  textVerbosity?: TextVerbosityLevel;
  /** Extended thinking configuration for supported models (Anthropic Claude 4/3.7, Gemini 2.5+) */
  thinking?: ThinkingBudgetConfig;
  /** Thinking level for models that support discrete intensities (Gemini 3 Pro) */
  thinkingLevel?: ThinkingLevel;
}

export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

export interface RegisterProviderOptions {
  override?: boolean;
}

const registry = new Map<ProviderId, ProviderFactory>();

export function registerProvider(id: ProviderId, factory: ProviderFactory, options: RegisterProviderOptions = {}): void {
  if (!id?.trim()) {
    throw new Error('Provider id cannot be blank.');
  }
  if (registry.has(id) && !options.override) {
    throw new Error(`Provider "${id}" is already registered.`);
  }
  registry.set(id, factory);
}

export function createProvider(config: ProviderConfig): LLMProvider {
  const factory = registry.get(config.provider);
  if (!factory) {
    const known = Array.from(registry.keys()).sort().join(', ');
    throw new Error(`Provider "${config.provider}" is not registered. Registered providers: ${known || 'none'}.`);
  }
  return factory(config);
}

export function listRegisteredProviders(): ProviderId[] {
  return Array.from(registry.keys());
}

export function hasProvider(id: ProviderId): boolean {
  return registry.has(id);
}
