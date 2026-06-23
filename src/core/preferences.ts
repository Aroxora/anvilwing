import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, ReasoningEffortLevel } from './types.js';
import type { ProfileName } from '../config.js';

const CONFIG_DIR = join(homedir(), '.anvilwing');
const SETTINGS_PATH = join(CONFIG_DIR, 'settings.json');
const CURRENT_VERSION = 2;

export interface PersistedModelPreference {
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffortLevel;
}

interface ToolSettingsSection {
  enabledTools?: string[];
}

interface SettingsFile {
  version: number;
  profiles: Partial<Record<ProfileName, PersistedModelPreference>>;
  tools?: ToolSettingsSection;
  activeProfile?: ProfileName;
  session?: SessionPreferenceSection;
  features?: FeatureFlagsSection;
}

interface SessionPreferenceSection {
  autosave?: boolean;
  autoResume?: boolean;
  autoContinue?: boolean;
  autoUpdate?: boolean;
  lastSessionId?: string;
}

/**
 * Feature flags for optional experimental features
 */
export interface FeatureFlags {
  verification?: boolean;       // Response verification
  autoCompact?: boolean;        // Auto-compact context when full
  mcpEnabled?: boolean;         // MCP server support
  metrics?: boolean;            // Performance metrics tracking
  codingTools?: boolean;        // Enhanced coding tools
  securityTools?: boolean;      // Security research tools
  adversarial?: boolean;        // Adversarial verification of answers + risky tool calls
  allPlugins?: boolean;         // Enable all optional plugins
}

interface FeatureFlagsSection {
  flags?: FeatureFlags;
}

export interface ToolSettings {
  enabledTools: string[];
}

export interface SessionPreferences {
  autosave: boolean;
  autoResume: boolean;
  autoContinue: boolean;
  autoUpdate: boolean | null;  // null = prompt user, true = auto-update, false = skip
  lastSessionId: string | null;
}

export function loadActiveProfilePreference(): ProfileName | null {
  const payload = readSettingsFile();
  if (!payload?.activeProfile) {
    return null;
  }
  return normalizeProfileNameValue(payload.activeProfile);
}

export function saveActiveProfilePreference(profile: ProfileName): void {
  const normalized = normalizeProfileNameValue(profile);
  if (!normalized) {
    return;
  }
  const payload = readSettingsFile() ?? { version: CURRENT_VERSION, profiles: {} };
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  payload.activeProfile = normalized;
  writeSettingsFile(payload);
}

export function clearActiveProfilePreference(): void {
  const payload = readSettingsFile();
  if (!payload?.activeProfile) {
    return;
  }
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  delete payload.activeProfile;
  writeSettingsFile(payload);
}

export function loadModelPreference(profile: ProfileName): PersistedModelPreference | null {
  const payload = readSettingsFile();
  if (!payload) {
    return null;
  }
  const entry = payload.profiles?.[profile];
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') {
    return null;
  }
  return { ...entry };
}

export function saveModelPreference(
  profile: ProfileName,
  preference: PersistedModelPreference
): void {
  const payload = readSettingsFile() ?? { version: CURRENT_VERSION, profiles: {} };
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  payload.profiles[profile] = { ...preference };
  writeSettingsFile(payload);
}

export function loadToolSettings(): ToolSettings | null {
  const payload = readSettingsFile();
  if (!payload?.tools) {
    return null;
  }
  const enabledTools = normalizeToolIds(payload.tools.enabledTools);
  return { enabledTools };
}

export function saveToolSettings(settings: ToolSettings): void {
  const payload = readSettingsFile() ?? { version: CURRENT_VERSION, profiles: {} };
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  payload.tools = {
    enabledTools: normalizeToolIds(settings.enabledTools),
  };
  writeSettingsFile(payload);
}

export function clearToolSettings(): void {
  const payload = readSettingsFile();
  if (!payload) {
    return;
  }
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  if (payload.tools) {
    delete payload.tools;
  }
  writeSettingsFile(payload);
}

export function loadSessionPreferences(): SessionPreferences {
  const payload = readSettingsFile();
  const section = payload?.session;
  return {
    // autoContinue defaults to false - manual control avoids unintended follow-ups
    autosave: typeof section?.autosave === 'boolean' ? section.autosave : false,
    autoResume: typeof section?.autoResume === 'boolean' ? section.autoResume : false,
    autoContinue: typeof section?.autoContinue === 'boolean' ? section.autoContinue : false,
    autoUpdate: typeof section?.autoUpdate === 'boolean' ? section.autoUpdate : null,
    lastSessionId:
      typeof section?.lastSessionId === 'string' && section.lastSessionId.trim()
        ? section.lastSessionId.trim()
        : null,
  };
}

export function saveSessionPreferences(preferences: Partial<SessionPreferences>): void {
  const payload = readSettingsFile() ?? { version: CURRENT_VERSION, profiles: {} };
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  const section = payload.session ?? {};

  if (typeof preferences.autosave === 'boolean') {
    section.autosave = preferences.autosave;
  }
  if (typeof preferences.autoResume === 'boolean') {
    section.autoResume = preferences.autoResume;
  }
  if (typeof preferences.autoContinue === 'boolean') {
    section.autoContinue = preferences.autoContinue;
  }
  if ('autoUpdate' in preferences) {
    section.autoUpdate = preferences.autoUpdate ?? undefined;
  }
  if ('lastSessionId' in preferences) {
    section.lastSessionId = preferences.lastSessionId ?? undefined;
  }

  payload.session = section;
  writeSettingsFile(payload);
}

function readSettingsFile(): SettingsFile | null {
  try {
    if (!existsSync(SETTINGS_PATH)) {
      return null;
    }
    const raw = readFileSync(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const profiles =
      typeof parsed.profiles === 'object' && parsed.profiles !== null ? parsed.profiles : {};
    const payload: SettingsFile = {
      version: typeof parsed.version === 'number' ? parsed.version : CURRENT_VERSION,
      profiles,
    };
    const tools = parseToolSettings(parsed.tools);
    if (tools) {
      payload.tools = tools;
    }
    const session = parseSessionPreferences(parsed.session);
    if (session) {
      payload.session = session;
    }
    const rawProfile =
      typeof parsed.activeProfile === 'string' && parsed.activeProfile.trim()
        ? (parsed.activeProfile.trim() as ProfileName)
        : undefined;
    if (rawProfile) {
      payload.activeProfile = rawProfile;
    }
    return payload;
  } catch {
    return null;
  }
}

function writeSettingsFile(payload: SettingsFile): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify(payload, null, 2));
  } catch {
    // Persisting settings should not block runtime; ignore write failures.
  }
}

function parseToolSettings(value: unknown): ToolSettingsSection | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as ToolSettingsSection;
  if (!Array.isArray(record.enabledTools)) {
    return { enabledTools: [] };
  }
  return { enabledTools: normalizeToolIds(record.enabledTools) };
}

function parseSessionPreferences(value: unknown): SessionPreferenceSection | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as SessionPreferenceSection;
  const section: SessionPreferenceSection = {};
  if (typeof record.autosave === 'boolean') {
    section.autosave = record.autosave;
  }
  if (typeof record.autoResume === 'boolean') {
    section.autoResume = record.autoResume;
  }
  if (typeof record.autoContinue === 'boolean') {
    section.autoContinue = record.autoContinue;
  }
  if (typeof record.autoUpdate === 'boolean') {
    section.autoUpdate = record.autoUpdate;
  }
  if (typeof record.lastSessionId === 'string' && record.lastSessionId.trim()) {
    section.lastSessionId = record.lastSessionId.trim();
  }
  return section;
}

function normalizeToolIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of ids) {
    if (typeof entry !== 'string') {
      continue;
    }
    const id = entry.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeProfileNameValue(value: unknown): ProfileName | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed as ProfileName;
}

/**
 * Default feature flags.
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  verification: false,
  autoCompact: true,  // Enable by default to prevent context overflow
  mcpEnabled: false,
  metrics: false,
  codingTools: true,   // Enable coding tools by default
  securityTools: false,
  adversarial: true,   // Verify answers + critique risky tool calls by default
  allPlugins: false,
};

/**
 * Load feature flags from settings
 */
export function loadFeatureFlags(): FeatureFlags {
  const payload = readSettingsFile();
  const stored = payload?.features?.flags;
  // Merge with defaults - stored values override defaults
  return {
    ...DEFAULT_FEATURE_FLAGS,
    ...(stored ?? {}),
  };
}

/**
 * Save feature flags to settings
 */
export function saveFeatureFlags(flags: FeatureFlags): void {
  const payload = readSettingsFile() ?? { version: CURRENT_VERSION, profiles: {} };
  payload.version = CURRENT_VERSION;
  payload.profiles = payload.profiles ?? {};
  payload.features = { flags: { ...flags } };
  writeSettingsFile(payload);
}

/**
 * Toggle a single feature flag
 */
export function toggleFeatureFlag(key: keyof FeatureFlags, value?: boolean): FeatureFlags {
  const current = loadFeatureFlags();
  const newValue = value !== undefined ? value : !current[key];
  const updated = { ...current, [key]: newValue };
  saveFeatureFlags(updated);
  return updated;
}

/**
 * Feature flag descriptions for help/display
 */
export const FEATURE_FLAG_INFO: Record<keyof FeatureFlags, { label: string; description: string }> = {
  verification: {
    label: 'Verification',
    description: 'Automatic response verification and validation',
  },
  autoCompact: {
    label: 'Auto Compact',
    description: 'Automatically compact context when approaching limit',
  },
  mcpEnabled: {
    label: 'MCP',
    description: 'Model Context Protocol server support',
  },
  metrics: {
    label: 'Metrics',
    description: 'Performance tracking and analytics',
  },
  codingTools: {
    label: 'Coding Tools',
    description: 'Enhanced code analysis and refactoring',
  },
  securityTools: {
    label: 'Security Tools',
    description: 'Security research and analysis tools',
  },
  adversarial: {
    label: 'Adversarial',
    description: 'Adversarially verify final answers and critique risky tool calls',
  },
  allPlugins: {
    label: 'All Plugins',
    description: 'Enable all optional feature plugins',
  },
};
