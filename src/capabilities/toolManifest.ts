import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ToolAvailabilityOption,
  ToolSelectionManifest,
  ToolSelectionPreset,
  ToolSelectionTarget,
} from '../contracts/v1/toolAccess.js';

type RawToolManifest = ToolSelectionManifest & { $schema?: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const manifest = normalizeManifest(
  JSON.parse(readFileSync(join(__dirname, '../contracts/tools.schema.json'), 'utf-8')) as Partial<RawToolManifest>
);

export function getToolManifest(): ToolSelectionManifest {
  return manifest;
}

function normalizeManifest(raw: Partial<RawToolManifest>): ToolSelectionManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Tool manifest is malformed: expected an object.');
  }

  const options = Array.isArray(raw.options) ? raw.options.map(normalizeOption) : null;
  if (!options?.length) {
    throw new Error('Tool manifest must include at least one tool option.');
  }

  const manifest: ToolSelectionManifest = {
    contractVersion: requireString(raw.contractVersion, 'contractVersion'),
    profile: requireString(raw.profile, 'profile'),
    version: requireString(raw.version, 'version'),
    options,
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
  const presets = normalizePresets(raw.presets);
  if (presets) {
    manifest.presets = presets;
  }

  return manifest;
}

function normalizeOption(raw: ToolAvailabilityOption): ToolAvailabilityOption {
  const id = requireString(raw.id, 'option.id');
  const label = requireString(raw.label, `option("${id}").label`);
  const description = requireString(raw.description, `option("${id}").description`);

  const pluginIds = dedupeStrings(raw.pluginIds);
  if (!pluginIds.length) {
    throw new Error(`Tool option "${id}" must declare at least one plugin id.`);
  }

  const option: ToolAvailabilityOption = {
    id,
    label,
    description,
    defaultEnabled: Boolean(raw.defaultEnabled),
    pluginIds,
  };

  const category = optionalString(raw.category);
  if (category) {
    option.category = category;
  }
  const requiresSecret = optionalString(raw.requiresSecret);
  if (requiresSecret) {
    option.requiresSecret = requiresSecret;
  }
  const scopes = raw.scopes?.length ? dedupeStrings(raw.scopes) : undefined;
  if (scopes?.length) {
    option.scopes = scopes;
  }
  const metadata = normalizeRecord(raw.metadata);
  if (metadata) {
    option.metadata = metadata;
  }

  return option;
}

function normalizePresets(entries: ToolSelectionPreset[] | undefined): ToolSelectionPreset[] | undefined {
  if (!entries?.length) {
    return undefined;
  }
  return entries.map((preset) => {
    const id = requireString(preset.id, 'preset.id');
    const normalized: ToolSelectionPreset = {
      id,
      label: requireString(preset.label, `preset("${id}").label`),
      enabled: dedupeStrings(preset.enabled),
      disabled: dedupeStrings(preset.disabled),
      locked: dedupeStrings(preset.locked),
    };

    const description = optionalString(preset.description);
    if (description) {
      normalized.description = description;
    }
    const appliesTo = normalizeTargets(preset.appliesTo);
    if (appliesTo) {
      normalized.appliesTo = appliesTo;
    }
    const metadata = normalizeRecord(preset.metadata);
    if (metadata) {
      normalized.metadata = metadata;
    }
    const notes = optionalString(preset.notes);
    if (notes) {
      normalized.notes = notes;
    }

    return normalized;
  });
}

function normalizeTargets(targets: ToolSelectionTarget[] | undefined): ToolSelectionTarget[] | undefined {
  if (!targets?.length) {
    return undefined;
  }
  const seen = new Set<ToolSelectionTarget>();
  const result: ToolSelectionTarget[] = [];
  for (const target of targets) {
    if (target && !seen.has(target)) {
      seen.add(target);
      result.push(target);
    }
  }
  return result.length ? result : undefined;
}

function dedupeStrings<T extends string>(values: T[] | undefined): T[] {
  if (!values?.length) {
    return [];
  }
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed as T);
  }
  return result;
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Tool manifest is missing required field "${field}".`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Tool manifest field "${field}" cannot be blank.`);
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
