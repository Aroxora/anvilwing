import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProfileEntry, AgentProfileManifest } from './contracts/v1/agentProfileManifest.js';
import type { ProviderId } from './core/types.js';
import {
  registerAgentProfile,
  hasAgentProfile,
  getAgentProfile,
  type AgentProfileBlueprint,
  type ProfileName,
} from './core/agentProfiles.js';
import { buildAgentRulebookPrompt, loadAgentRulebook } from './core/agentRulebook.js';
import { getAgentProfileManifest } from './core/agentProfileManifest.js';
import { logDebug } from './utils/debugLogger.js';

export type { ProfileName } from './core/agentProfiles.js';

// The product is locked to a single model on a single provider. This is the
// ONE source of truth for that lock — runtime model/provider resolution
// coerces to these, and nothing (env var, profile blueprint, model-inference)
// can route to anything else. Transparency over secrecy: the lock
// is a plain, inspectable constant, not a hidden override.
export const LOCKED_MODEL = 'anvilwing';
export const LOCKED_PROVIDER: ProviderId = 'anvilwing';

// Ultracode operating-mode directive. ALWAYS appended to the system prompt
// (baked in, no toggle) — Anvilwing runs Anvilwing v4 Pro on max thinking
// budget and this directive tunes it for long-horizon, multi-file work as
// the permanent default. Scoped so trivial turns stay direct (no
// orchestration spree on a greeting).
const ULTRACODE_DIRECTIVE = `## Operating mode: ultracode (always on)

You run on max thinking budget and are tuned for long-horizon, multi-file work. For substantial, multi-step work, optimize for the most complete and correct result — not the fastest. Work in explicit phases and don't skip them:

1. Research — read the relevant code/files first; answer "does this already exist?" from the source, not memory.
2. Verify load-bearing facts — before relying on a date, an API contract, a version, or any external claim, confirm it (run a probe, read the doc, test it). Label anything still unverified instead of asserting it.
3. Design — state the approach and trade-offs before writing significant new code; prefer mature libraries over custom infrastructure.
4. Build the complete, genuinely useful thing — not a stub, mock, or demo. Match the surrounding code's conventions and avoid unrequested bloat.
5. Verify the result — run the build and tests against the real artifact, and adversarially try to refute your own output before reporting it done.

Long-horizon tasks (large refactors, migrations, multi-file changes, long sessions):
- Keep a living TODO plan via TodoWrite/TodoRead: enumerate every unit of work up front, mark each in-progress/done as you go, and call TodoRead at the start of a new turn to check plan state before deciding what to do next.
- For a multi-file change, FIND every affected site first (grep/glob across the whole repo) before editing any one — then change each site and re-search to confirm none were missed.
- Don't stop early. The task is done only when every TODO item is complete and the build + tests pass against the real artifact. If you hit a wall, replan in the TODO list and keep going.
- Carry context forward: fold progress into the plan so a long session stays coherent even after earlier turns are compacted.

Use parallel sub-agents to cover breadth (independent searches, multi-file audits, or N independent attempts judged against each other) when the task is wider than a single pass.

Scope: this applies to substantial tasks. For a greeting, a quick question, or a trivial one-line edit, answer directly — do not orchestrate, spawn agents, or over-engineer trivial turns.`;

export interface ResolvedProfileConfig {
  profile: ProfileName;
  label: string;
  provider: ProviderId;
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  modelLocked: boolean;
  providerLocked: boolean;
  rulebook: ProfileRulebookMetadata | null;
}

export interface ProfileRulebookMetadata {
  profile: ProfileName;
  label: string;
  version: string;
  contractVersion: string;
  description?: string;
  file: string;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROFILE_MANIFEST = getAgentProfileManifest();

const DEFAULT_PROFILES: AgentProfileBlueprint[] = PROFILE_MANIFEST.profiles.map((entry) =>
  normalizeProfileFromManifest(entry, PROFILE_MANIFEST, PACKAGE_ROOT)
);

for (const profile of DEFAULT_PROFILES) {
  if (!hasAgentProfile(profile.name)) {
    registerAgentProfile(profile);
  }
}

export function resolveProfileConfig(profile: ProfileName, workspaceContext: string | null): ResolvedProfileConfig {
  const blueprint = getAgentProfile(profile);

  const envPrefix = toEnvPrefix(blueprint.name);

  // Model + provider are HARD-LOCKED (see LOCKED_MODEL/LOCKED_PROVIDER). The
  // product supports anvilwing only — there is no model switching. A
  // _MODEL / _PROVIDER env var that points elsewhere is ignored (warned once
  // in debug) rather than silently honored, so the lock can't be bypassed.
  const modelEnv = process.env[`${envPrefix}_MODEL`];
  if (typeof modelEnv === 'string' && modelEnv.trim() && modelEnv.trim() !== LOCKED_MODEL) {
    logDebug(`[config] ignoring ${envPrefix}_MODEL=${modelEnv.trim()} — locked to ${LOCKED_MODEL}`);
  }
  const providerEnv = process.env[`${envPrefix}_PROVIDER`];
  if (typeof providerEnv === 'string' && providerEnv.trim() && providerEnv.trim() !== LOCKED_PROVIDER) {
    logDebug(`[config] ignoring ${envPrefix}_PROVIDER=${providerEnv.trim()} — locked to ${LOCKED_PROVIDER}`);
  }
  const model = LOCKED_MODEL;
  const provider = LOCKED_PROVIDER;
  // Retained on the resolved config for the chrome that reads them; both are
  // now structurally always true (the lock).
  const modelLocked = true;
  const providerLocked = true;

  const systemPrompt = process.env[`${envPrefix}_SYSTEM_PROMPT`] ?? blueprint.defaultSystemPrompt;

  const rulebook = loadRulebookMetadata(blueprint);

  const contextBlock = workspaceContext?.trim()
    ? `\n\nWorkspace context (auto-detected):\n${workspaceContext.trim()}`
    : '';

  // Ultracode is baked in — always applied, no feature-flag gate, no toggle.
  const ultracodeBlock = `\n\n${ULTRACODE_DIRECTIVE}`;

  const resolved: ResolvedProfileConfig = {
    profile,
    label: blueprint.label,
    provider,
    model,
    systemPrompt: `${systemPrompt.trim()}${ultracodeBlock}${contextBlock}`,
    modelLocked,
    providerLocked,
    rulebook,
  };

  if (typeof blueprint.temperature === 'number') {
    resolved.temperature = blueprint.temperature;
  }
  if (typeof blueprint.maxTokens === 'number') {
    resolved.maxTokens = blueprint.maxTokens;
  }

  return resolved;
}

function toEnvPrefix(profile: ProfileName): string {
  return profile
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');
}

function loadRulebookMetadata(profile: AgentProfileBlueprint): ProfileRulebookMetadata | null {
  try {
    // Check if rulebook is inline
    const rulebookRef = profile.rulebook as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const manifest = rulebookRef.inline
      ? loadAgentRulebook(profile.name, { inline: rulebookRef.inline })
      : loadAgentRulebook(profile.name, {
          root: PACKAGE_ROOT,
          file: rulebookRef.file,
        });

    return {
      profile: manifest.profile,
      label: manifest.label ?? manifest.profile,
      version: manifest.version,
      contractVersion: manifest.contractVersion,
      description: manifest.description ?? profile.rulebook.description,
      file: rulebookRef.file ?? '[inline]',
    };
  } catch {
    if (!profile.rulebook) {
      return null;
    }

    const rulebookRef = profile.rulebook as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fallback: ProfileRulebookMetadata = {
      profile: profile.name,
      label: profile.label,
      version: rulebookRef.version ?? 'unknown',
      contractVersion: rulebookRef.contractVersion ?? 'unknown',
      description: rulebookRef.description,
      file: rulebookRef.file ?? '[inline]',
    };

    return fallback;
  }
}

function normalizeProfileFromManifest(
  entry: AgentProfileEntry,
  manifest: AgentProfileManifest,
  root: string
): AgentProfileBlueprint {
  const defaultSystemPrompt = buildDefaultSystemPrompt(entry, root);

  return {
    name: entry.name,
    label: entry.label,
    description: entry.description,
    defaultProvider: entry.defaultProvider,
    defaultModel: entry.defaultModel,
    systemPromptConfig: entry.systemPrompt,
    defaultSystemPrompt,
    temperature: entry.temperature,
    maxTokens: entry.maxTokens,
    rulebook: entry.rulebook,
    manifestVersion: manifest.version,
    manifestContractVersion: manifest.contractVersion,
  };
}

function buildDefaultSystemPrompt(entry: AgentProfileEntry, root: string): string {
  try {
    const promptConfig = entry.systemPrompt;
    if (promptConfig.type === 'literal') {
      return promptConfig.content.trim();
    }

    const template = promptConfig.template?.trim() || '{{rulebook}}';
    // Check if rulebook is inline
    const rulebookRef = entry.rulebook as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rulebookPrompt = rulebookRef.inline
      ? buildAgentRulebookPrompt(entry.name, { inline: rulebookRef.inline }).trim()
      : buildAgentRulebookPrompt(entry.name, { root, file: rulebookRef.file }).trim();
    const replacements: Record<string, string> = {
      rulebook: rulebookPrompt,
      profile: entry.label || entry.name,
      profile_name: entry.name,
    };

    const rendered = template.replace(
      /\{\{\s*(rulebook|profile|profile_name)\s*\}\}/gi,
      (_match, token: string) => {
        const key = token.toLowerCase() as keyof typeof replacements;
        return replacements[key] ?? '';
      }
    );

    if (/\{\{\s*rulebook\s*\}\}/i.test(template)) {
      return rendered.trim();
    }

    const merged = rendered.trim();
    const suffix = merged ? `\n\n${rulebookPrompt}` : rulebookPrompt;
    return `${merged}${suffix}`.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to build system prompt for profile "${entry.name}": ${message}`);
  }
}
