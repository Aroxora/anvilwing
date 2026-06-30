/**
 * Model discovery system for auto-detecting new models from providers.
 *
 * This module queries provider APIs to discover available models and caches
 * them for use alongside the static model schema. It never modifies the
 * static schema - discoveries are stored separately and merged at runtime.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderId } from './types.js';
import type { ModelConfig } from './agentSchemaLoader.js';
import { safeErrorMessage } from './secretStore.js';
import { logDebug } from '../utils/debugLogger.js';

/**
 * Discovered model cache file location
 */
const CACHE_DIR = join(homedir(), '.anvilwing');
const CACHE_FILE = join(CACHE_DIR, 'discovered-models.json');

/**
 * Cache expiration time (24 hours)
 */
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Discovered models cache structure
 */
interface DiscoveredModelsCache {
  version: string;
  lastUpdated: string;
  models: ModelConfig[];
}

const MODEL_PROVIDER_HINTS: Array<{ provider: ProviderId; patterns: RegExp[] }> = [
  { provider: 'anvilwing', patterns: [/^deepseek/i] },
];

/**
 * Infer provider from a model identifier.
 */
export function inferProviderFromModelId(modelId: string | null | undefined): ProviderId | null {
  if (!modelId) return null;
  const normalized = modelId.trim().toLowerCase();
  for (const hint of MODEL_PROVIDER_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(normalized))) {
      return hint.provider;
    }
  }
  return null;
}

/**
 * Model discovery result for a single provider
 */
export interface ProviderDiscoveryResult {
  provider: ProviderId;
  success: boolean;
  models: ModelConfig[];
  error?: string;
}

/**
 * Complete discovery result
 */
export interface DiscoveryResult {
  success: boolean;
  timestamp: string;
  results: ProviderDiscoveryResult[];
  totalModelsDiscovered: number;
  errors: string[];
}

/**
 * Get cached discovered models
 */
export function getCachedDiscoveredModels(): ModelConfig[] {
  try {
    if (!existsSync(CACHE_FILE)) {
      return [];
    }

    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const cache: DiscoveredModelsCache = JSON.parse(raw);

    // Check if cache is expired
    const lastUpdated = new Date(cache.lastUpdated).getTime();
    const now = Date.now();
    if (now - lastUpdated > CACHE_EXPIRATION_MS) {
      return [];
    }

    return cache.models;
  } catch (error) {
    logDebug('Failed to read discovered models cache:', safeErrorMessage(error));
    return [];
  }
}

/**
 * Save discovered models to cache
 */
async function saveDiscoveredModels(models: ModelConfig[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });

    const cache: DiscoveredModelsCache = {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
      models,
    };

    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (error) {
    logDebug('Failed to save discovered models cache:', safeErrorMessage(error));
  }
}

/**
 * Discover models from Anvilwing (OpenAI-compatible)
 */
async function discoverAnvilwingModels(apiKey: string): Promise<ProviderDiscoveryResult> {
  const provider: ProviderId = 'anvilwing';

  try {
    const response = await fetch('https://api.deepseek.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ id: string }> };

    const models: ModelConfig[] = data.data.map(model => ({
      id: model.id,
      label: model.id,
      provider,
      description: `Anvilwing ${model.id} (auto-discovered)`,
      capabilities: ['chat', 'reasoning', 'tools', 'streaming'],
    }));

    return {
      provider,
      success: true,
      models,
    };
  } catch (error) {
    return {
      provider,
      success: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Discover models from all configured providers
 */
export async function discoverAllModels(): Promise<DiscoveryResult> {
  const errors: string[] = [];
  let totalModelsDiscovered = 0;

  // Discover from each provider if API key is available
  const providers: Array<{
    id: ProviderId;
    envVar: string;
    discover: (apiKey: string) => Promise<ProviderDiscoveryResult>;
  }> = [
      { id: 'anvilwing', envVar: 'ANVILWING_API_KEY', discover: discoverAnvilwingModels },
    ];

  // PERF: Build discovery promises in parallel
  const discoveryPromises: Promise<ProviderDiscoveryResult>[] = providers.map(async (provider) => {
    const apiKey = process.env[provider.envVar];

    if (!apiKey) {
      return {
        provider: provider.id,
        success: false,
        models: [],
        error: `API key not configured (${provider.envVar})`,
      };
    }

    try {
      return await provider.discover(apiKey);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        provider: provider.id,
        success: false,
        models: [] as ModelConfig[],
        error: errorMessage,
      };
    }
  });

  // PERF: Execute ALL provider discoveries in parallel using Promise.allSettled
  // This ensures one slow/failed provider doesn't block others
  const settledResults = await Promise.allSettled(discoveryPromises);

  // Process results
  const results: ProviderDiscoveryResult[] = settledResults.map((settled, index) => {
    if (settled.status === 'fulfilled') {
      return settled.value;
    }
    // Promise rejected (shouldn't happen with our error handling, but be safe)
    const providerId = index < providers.length
      ? providers[index]!.id
      : 'ollama';
    return {
      provider: providerId,
      success: false,
      models: [],
      error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
    };
  });

  // Collect errors and count models
  for (const result of results) {
    if (result.success) {
      totalModelsDiscovered += result.models.length;
    } else if (result.error) {
      errors.push(`${result.provider}: ${result.error}`);
    }
  }

  // Collect all discovered models
  const allModels = results
    .filter(r => r.success)
    .flatMap(r => r.models);

  // Save to cache
  if (allModels.length > 0) {
    await saveDiscoveredModels(allModels);
  }

  return {
    success: errors.length === 0,
    timestamp: new Date().toISOString(),
    results,
    totalModelsDiscovered,
    errors,
  };
}

/**
 * Clear the discovered models cache
 */
export function clearDiscoveredModelsCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      writeFileSync(CACHE_FILE, JSON.stringify({ version: '1.0.0', lastUpdated: new Date().toISOString(), models: [] }, null, 2), 'utf-8');
    }
  } catch (error) {
    logDebug('Failed to clear discovered models cache:', safeErrorMessage(error));
  }
}

// ============================================================================
// Provider Status Detection
// ============================================================================

/**
 * Provider configuration info
 */
export interface ProviderInfo {
  id: ProviderId;
  name: string;
  envVar: string;
  configured: boolean;
  latestModel: string;
  models?: string[];
}

/**
 * Supported providers with their environment variable requirements
 */
const PROVIDER_CONFIGS: Array<{
  id: ProviderId;
  name: string;
  envVar: string;
  altEnvVars?: string[];
  defaultLatestModel: string;
  fallbackModels?: string[];
}> = [
    {
      id: 'anvilwing',
      name: 'Anvilwing',
      envVar: 'ANVILWING_API_KEY',
      defaultLatestModel: 'deepseek-v4-pro',
      // Single locked model — no alternate to fall back to.
      fallbackModels: [],
    },
  ];

/**
 * Model priority rankings for selecting the "best" model
 */
const MODEL_PRIORITIES: Record<string, Record<string, number>> = {
  anvilwing: {
    'deepseek-v4-pro': 100,
  },
};

/**
 * Get model priority for sorting
 */
function getModelPriority(provider: ProviderId, modelId: string): number {
  const priorities = MODEL_PRIORITIES[provider];
  if (!priorities) return 0;

  // Check for exact match first
  if (priorities[modelId] !== undefined) {
    return priorities[modelId];
  }

  // Check for prefix match
  for (const [prefix, priority] of Object.entries(priorities)) {
    if (modelId.startsWith(prefix)) {
      return priority;
    }
  }

  return 0;
}

/**
 * Sort models by priority (best first)
 */
export function sortModelsByPriority(provider: ProviderId, models: string[]): string[] {
  return [...models].sort((a, b) => {
    const priorityA = getModelPriority(provider, a);
    const priorityB = getModelPriority(provider, b);
    return priorityB - priorityA;
  });
}

/**
 * Get the best/latest model for a provider
 */
export function getBestModel(provider: ProviderId, models: string[]): string {
  if (models.length === 0) {
    const config = PROVIDER_CONFIGS.find(p => p.id === provider);
    return config?.defaultLatestModel || '';
  }

  const sorted = sortModelsByPriority(provider, models);
  return sorted[0] ?? models[0] ?? '';
}

/**
 * Check if a provider is configured (has API key or is accessible)
 */
export function isProviderConfigured(providerId: ProviderId): boolean {
  const config = PROVIDER_CONFIGS.find(p => p.id === providerId);
  if (!config) return false;

  if (process.env[config.envVar]) {
    return true;
  }

  if (config.altEnvVars) {
    for (const altVar of config.altEnvVars) {
      if (process.env[altVar]) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get all providers with their configuration status
 */
export function getProvidersStatus(): ProviderInfo[] {
  return PROVIDER_CONFIGS.map(config => {
    let configured = false;

    configured = !!process.env[config.envVar];
    if (!configured && config.altEnvVars) {
      configured = config.altEnvVars.some(v => !!process.env[v]);
    }

    return {
      id: config.id,
      name: config.name,
      envVar: config.envVar,
      configured,
      latestModel: config.defaultLatestModel,
    };
  });
}

/**
 * Get list of configured providers (with valid API keys)
 */
export function getConfiguredProviders(): ProviderInfo[] {
  return getProvidersStatus().filter(p => p.configured);
}

/**
 * Get list of unconfigured providers
 */
export function getUnconfiguredProviders(): ProviderInfo[] {
  return getProvidersStatus().filter(p => !p.configured);
}

/**
 * Get the first available provider (for auto-selection)
 */
export function getFirstAvailableProvider(): ProviderInfo | null {
  const configured = getConfiguredProviders();

  // Anvilwing is the only supported provider
  const preferenceOrder = ['anvilwing'];

  for (const providerId of preferenceOrder) {
    const provider = configured.find(p => p.id === providerId);
    if (provider) {
      return provider;
    }
  }

  return null;
}

/**
 * Get latest model for a provider from cache or defaults
 */
export function getLatestModelForProvider(providerId: ProviderId): string {
  // Check cache first
  const cached = getCachedDiscoveredModels();
  const providerModels = cached.filter(m => m.provider === providerId);

  if (providerModels.length > 0) {
    const modelIds = providerModels.map(m => m.id);
    return getBestModel(providerId, modelIds);
  }

  // Fall back to default
  const config = PROVIDER_CONFIGS.find(p => p.id === providerId);
  return config?.defaultLatestModel || '';
}

/**
 * Quick provider availability check result
 */
export interface QuickProviderStatus {
  provider: ProviderId;
  available: boolean;
  latestModel: string;
  error?: string;
}

/**
 * Quick API check for a single provider - returns best model or null
 */
async function quickFetchProviderModels(
  providerId: ProviderId,
  apiKey: string,
  timeoutMs: number = 24 * 60 * 60 * 1000
): Promise<string[]> {
  try {
    if (providerId === 'anvilwing') {
      const response = await fetch('https://api.deepseek.com/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return [];
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data.map(m => m.id);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Quickly check if providers are available by querying their APIs
 * Returns actual latest models from each provider
 */
export async function quickCheckProviders(): Promise<QuickProviderStatus[]> {
  const checks: Promise<QuickProviderStatus>[] = [];

  for (const config of PROVIDER_CONFIGS) {
    let apiKey = process.env[config.envVar];
    if (!apiKey && config.altEnvVars) {
      for (const altVar of config.altEnvVars) {
        if (process.env[altVar]) {
          apiKey = process.env[altVar];
          break;
        }
      }
    }

    if (!apiKey) {
      checks.push(Promise.resolve({
        provider: config.id,
        available: false,
        latestModel: config.defaultLatestModel,
        error: `${config.envVar} not set`,
      }));
      continue;
    }

    checks.push((async (): Promise<QuickProviderStatus> => {
      const models = await quickFetchProviderModels(config.id, apiKey, 3000);
      if (models.length > 0) {
        const bestModel = getBestModel(config.id, models);
        return {
          provider: config.id,
          available: true,
          latestModel: bestModel,
        };
      }
      return {
        provider: config.id,
        available: true,
        latestModel: config.defaultLatestModel,
        error: 'Could not fetch models',
      };
    })());
  }

  return Promise.all(checks);
}
