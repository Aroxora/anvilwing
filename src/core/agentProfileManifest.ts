import type {
  AgentProfileEntry,
  AgentProfileManifest,
  AgentPromptConfig,
  AgentRulebookReference,
  LiteralPromptConfig,
  RulebookPromptConfig,
} from '../contracts/v1/agentProfileManifest.js';
import type { ProviderId } from './types.js';
import { getAgentSchemas } from './agentSchemaLoader.js';

type RawProfileManifest = AgentProfileManifest & { $schema?: string };

// Load from centralized schema
const manifest = (() => {
  const schemas = getAgentSchemas();
  const rawManifest: Partial<RawProfileManifest> = {
    contractVersion: schemas.contractVersion,
    version: schemas.version,
    label: schemas.label,
    description: schemas.description,
    profiles: schemas.profiles,
    metadata: schemas.metadata,
  };
  return normalizeManifest(rawManifest);
})();

export function getAgentProfileManifest(): AgentProfileManifest {
  return manifest;
}

function normalizeManifest(raw: Partial<RawProfileManifest>): AgentProfileManifest {
  if (!isRecord(raw)) {
    throw new Error('Agent profile manifest is malformed: expected an object.');
  }

  const profiles = Array.isArray(raw.profiles) ? raw.profiles.map(normalizeProfileEntry) : null;
  if (!profiles?.length) {
    throw new Error('Agent profile manifest must include at least one profile entry.');
  }

  const seen = new Set<string>();
  for (const entry of profiles) {
    if (seen.has(entry.name)) {
      throw new Error(`Agent profile manifest contains duplicate profile id "${entry.name}".`);
    }
    seen.add(entry.name);
  }

  const manifest: AgentProfileManifest = {
    contractVersion: requireString(raw.contractVersion, 'contractVersion'),
    version: requireString(raw.version, 'version'),
    profiles,
  };

  const label = optionalString(raw.label);
  if (label) {
    manifest.label = label;
  }
  const description = optionalString(raw.description);
  if (description) {
    manifest.description = description;
  }
  const metadata = normalizeRecord(raw.metadata);
  if (metadata) {
    manifest.metadata = metadata;
  }

  return manifest;
}

function normalizeProfileEntry(raw: AgentProfileEntry): AgentProfileEntry {
  const name = requireString(raw.name, 'profile.name');
  const profile: AgentProfileEntry = {
    name,
    label: requireString(raw.label, `profiles["${name}"].label`),
    defaultProvider: requireProvider(raw.defaultProvider, name),
    defaultModel: requireString(raw.defaultModel, `profiles["${name}"].defaultModel`),
    systemPrompt: normalizePrompt(raw.systemPrompt, name),
    rulebook: normalizeRulebook(raw.rulebook, name),
  };

  const description = optionalString(raw.description);
  if (description) {
    profile.description = description;
  }
  const temperature = optionalNumber(raw.temperature, `profiles["${name}"].temperature`);
  if (typeof temperature === 'number') {
    profile.temperature = temperature;
  }
  const maxTokens = optionalInteger(raw.maxTokens, `profiles["${name}"].maxTokens`);
  if (typeof maxTokens === 'number') {
    profile.maxTokens = maxTokens;
  }
  const metadata = normalizeRecord(raw.metadata);
  if (metadata) {
    profile.metadata = metadata;
  }

  return profile;
}

function normalizePrompt(raw: AgentPromptConfig | undefined, profile: string): AgentPromptConfig {
  if (!isRecord(raw)) {
    throw new Error(`Profile "${profile}" is missing a valid systemPrompt definition.`);
  }

  if (raw.type === 'literal') {
    return normalizeLiteralPrompt(raw, profile);
  }

  if (raw.type === 'rulebook') {
    return normalizeRulebookPrompt(raw, profile);
  }

  throw new Error(`Profile "${profile}" has an unsupported systemPrompt type.`);
}

function normalizeLiteralPrompt(raw: LiteralPromptConfig, profile: string): LiteralPromptConfig {
  const prompt: LiteralPromptConfig = {
    type: 'literal',
    content: requireString(raw.content, `profiles["${profile}"].systemPrompt.content`),
  };
  const metadata = normalizeRecord(raw.metadata);
  if (metadata) {
    prompt.metadata = metadata;
  }
  return prompt;
}

function normalizeRulebookPrompt(raw: RulebookPromptConfig, _profile: string): RulebookPromptConfig {
  const prompt: RulebookPromptConfig = { type: 'rulebook' };
  const template = optionalString(raw.template);
  if (template) {
    prompt.template = template;
  }
  const metadata = normalizeRecord(raw.metadata);
  if (metadata) {
    prompt.metadata = metadata;
  }
  return prompt;
}

function normalizeRulebook(raw: AgentRulebookReference | undefined, profile: string): AgentRulebookReference {
  if (!isRecord(raw)) {
    throw new Error(`Profile "${profile}" is missing a valid rulebook reference.`);
  }
  const reference: AgentRulebookReference = {
    file: requireString(raw.file, `profiles["${profile}"].rulebook.file`),
  };
  const version = optionalString(raw.version);
  if (version) {
    reference.version = version;
  }
  const contractVersion = optionalString(raw.contractVersion);
  if (contractVersion) {
    reference.contractVersion = contractVersion;
  }
  const description = optionalString(raw.description);
  if (description) {
    reference.description = description;
  }
  const metadata = normalizeRecord(raw.metadata);
  if (metadata) {
    reference.metadata = metadata;
  }
  return reference;
}

function requireProvider(value: unknown, profile: string): ProviderId {
  const resolved = requireString(value, `profiles["${profile}"].defaultProvider`);
  return resolved as ProviderId;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Agent profile manifest is missing required field "${field}".`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Agent profile manifest field "${field}" cannot be blank.`);
  }
  return trimmed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Agent profile manifest field "${field}" must be a finite number when provided.`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Agent profile manifest field "${field}" must be a positive integer when provided.`);
  }
  return value;
}

function normalizeRecord(record: unknown): Record<string, unknown> | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  return { ...record };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
