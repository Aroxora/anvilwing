/**
 * Centralized agent schema loader.
 *
 * This module provides type-safe loading and validation of the centralized
 * agent configuration schema from src/contracts/agent-schemas.json.
 * All agent-related configuration should be loaded through this module
 * to ensure consistency across the application.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract types
import type { ProviderId } from './types.js';
import type { AgentProfileEntry } from '../contracts/v1/agentProfileManifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Provider configuration from centralized schema
 */
export interface ProviderConfig {
  id: ProviderId;
  label: string;
  description?: string;
  envVars?: {
    apiKey?: string;
  };
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Model configuration from centralized schema
 */
export interface ModelConfig {
  id: string;
  label: string;
  provider: ProviderId;
  description?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  maxTokens?: number;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Slash command configuration
 */
export interface SlashCommandConfig {
  command: string;
  description: string;
  category?: 'configuration' | 'diagnostics' | 'workspace' | 'other';
  metadata?: Record<string, unknown>;
}

/**
 * Capability definition
 */
export interface CapabilityConfig {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The complete centralized agent schema
 */
export interface AgentSchemasManifest {
  contractVersion: string;
  version: string;
  label?: string;
  description?: string;
  providers: ProviderConfig[];
  models: ModelConfig[];
  profiles: AgentProfileEntry[];
  slashCommands?: SlashCommandConfig[];
  capabilities?: CapabilityConfig[];
  metadata?: Record<string, unknown>;
}

/**
 * Cached schema instance
 */
let cachedSchema: AgentSchemasManifest | null = null;

/**
 * Load the centralized agent schemas manifest.
 * Results are cached for performance.
 *
 * @returns The complete agent schemas manifest
 * @throws Error if the schema file cannot be read or parsed
 */
export function getAgentSchemas(): AgentSchemasManifest {
  if (cachedSchema) {
    return cachedSchema;
  }

  try {
    const schemaPath = join(__dirname, '..', 'contracts', 'agent-schemas.json');
    const raw = readFileSync(schemaPath, 'utf-8');
    const parsed = JSON.parse(raw) as AgentSchemasManifest;

    // Basic validation
    validateAgentSchemas(parsed);

    cachedSchema = parsed;
    return cachedSchema;
  } catch (error) {
    throw new Error(
      `Failed to load agent schemas: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get all provider configurations
 */
export function getProviders(): ProviderConfig[] {
  const schemas = getAgentSchemas();
  return schemas.providers;
}

/**
 * Get a specific provider by ID
 */
export function getProvider(providerId: ProviderId): ProviderConfig | undefined {
  const providers = getProviders();
  return providers.find((p) => p.id === providerId);
}

/**
 * Get all model configurations (includes both static and discovered models)
 */
export async function getModels(): Promise<ModelConfig[]> {
  const schemas = getAgentSchemas();
  const staticModels = schemas.models;

  // Try to load discovered models
  try {
    // Use dynamic import for ESM compatibility
    const modelDiscoveryModule = await import('./modelDiscovery.js');
    const discoveredModels = modelDiscoveryModule.getCachedDiscoveredModels();

    // Merge models, preferring static definitions over discovered ones
    const staticIds = new Set(staticModels.map((m: ModelConfig) => m.id));
    const uniqueDiscovered = discoveredModels.filter((m: ModelConfig) => !staticIds.has(m.id));

    return [...staticModels, ...uniqueDiscovered];
  } catch (error) {
    // If discovery module fails, just return static models
    return staticModels;
  }
}

/**
 * Get models for a specific provider
 */
export async function getModelsByProvider(providerId: ProviderId): Promise<ModelConfig[]> {
  const models = await getModels();
  return models.filter((m) => m.provider === providerId);
}

/**
 * Get a specific model by ID
 */
export async function getModel(modelId: string): Promise<ModelConfig | undefined> {
  const models = await getModels();
  return models.find((m) => m.id === modelId);
}

/**
 * Get all agent profiles
 */
export function getProfiles(): AgentProfileEntry[] {
  const schemas = getAgentSchemas();
  return schemas.profiles;
}

/**
 * Get a specific profile by name
 */
export function getProfile(profileName: string): AgentProfileEntry | undefined {
  const profiles = getProfiles();
  return profiles.find((p) => p.name === profileName);
}

/**
 * Get all slash commands
 */
export function getSlashCommands(): SlashCommandConfig[] {
  const schemas = getAgentSchemas();
  return schemas.slashCommands ?? [];
}

/**
 * Get all capabilities
 */
export function getCapabilities(): CapabilityConfig[] {
  const schemas = getAgentSchemas();
  return schemas.capabilities ?? [];
}

/**
 * Validate the agent schemas manifest structure
 */
function validateAgentSchemas(manifest: AgentSchemasManifest): void {
  // Check required fields
  if (!manifest.contractVersion) {
    throw new Error('Missing required field: contractVersion');
  }
  if (!manifest.version) {
    throw new Error('Missing required field: version');
  }
  if (!Array.isArray(manifest.providers) || manifest.providers.length === 0) {
    throw new Error('Missing or empty required field: providers');
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    throw new Error('Missing or empty required field: models');
  }
  if (!Array.isArray(manifest.profiles) || manifest.profiles.length === 0) {
    throw new Error('Missing or empty required field: profiles');
  }

  // Validate provider uniqueness
  const providerIds = new Set<string>();
  for (const provider of manifest.providers) {
    if (!provider.id || !provider.label) {
      throw new Error('Provider missing required fields: id, label');
    }
    if (providerIds.has(provider.id)) {
      throw new Error(`Duplicate provider ID: ${provider.id}`);
    }
    providerIds.add(provider.id);
  }

  // Validate model uniqueness and provider references
  const modelIds = new Set<string>();
  for (const model of manifest.models) {
    if (!model.id || !model.label || !model.provider) {
      throw new Error('Model missing required fields: id, label, provider');
    }
    if (modelIds.has(model.id)) {
      throw new Error(`Duplicate model ID: ${model.id}`);
    }
    if (!providerIds.has(model.provider)) {
      throw new Error(`Model "${model.id}" references unknown provider: ${model.provider}`);
    }
    modelIds.add(model.id);
  }

  // Validate profile uniqueness and references
  const profileNames = new Set<string>();
  for (const profile of manifest.profiles) {
    if (!profile.name || !profile.label || !profile.defaultProvider || !profile.defaultModel) {
      throw new Error('Profile missing required fields: name, label, defaultProvider, defaultModel');
    }
    if (profileNames.has(profile.name)) {
      throw new Error(`Duplicate profile name: ${profile.name}`);
    }
    if (!providerIds.has(profile.defaultProvider)) {
      throw new Error(`Profile "${profile.name}" references unknown provider: ${profile.defaultProvider}`);
    }
    if (!modelIds.has(profile.defaultModel)) {
      throw new Error(`Profile "${profile.name}" references unknown model: ${profile.defaultModel}`);
    }
    profileNames.add(profile.name);
  }

  // Validate slash commands uniqueness
  if (manifest.slashCommands) {
    const commands = new Set<string>();
    for (const cmd of manifest.slashCommands) {
      if (!cmd.command || !cmd.description) {
        throw new Error('Slash command missing required fields: command, description');
      }
      if (commands.has(cmd.command)) {
        throw new Error(`Duplicate slash command: ${cmd.command}`);
      }
      commands.add(cmd.command);
    }
  }

  // Validate capabilities uniqueness
  if (manifest.capabilities) {
    const capabilities = new Set<string>();
    for (const cap of manifest.capabilities) {
      if (!cap.id || !cap.label) {
        throw new Error('Capability missing required fields: id, label');
      }
      if (capabilities.has(cap.id)) {
        throw new Error(`Duplicate capability ID: ${cap.id}`);
      }
      capabilities.add(cap.id);
    }
  }
}

/**
 * Clear the cached schema (useful for testing)
 */
export function clearSchemaCache(): void {
  cachedSchema = null;
}

/**
 * Validate that a provider ID exists in the schema
 */
export function isValidProvider(providerId: string): providerId is ProviderId {
  const provider = getProvider(providerId as ProviderId);
  return provider !== undefined;
}

/**
 * Validate that a model ID exists in the schema
 */
export async function isValidModel(modelId: string): Promise<boolean> {
  const model = await getModel(modelId);
  return model !== undefined;
}

/**
 * Validate that a profile name exists in the schema
 */
export function isValidProfile(profileName: string): boolean {
  const profile = getProfile(profileName);
  return profile !== undefined;
}
