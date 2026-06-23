import type { AgentPromptConfig, AgentRulebookReference } from '../contracts/v1/agentProfileManifest.js';
import type { ProviderId } from './types.js';

export type ProfileName = string;

export interface AgentProfileBlueprint {
  name: ProfileName;
  label: string;
  description?: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  systemPromptConfig: AgentPromptConfig;
  defaultSystemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  rulebook: AgentRulebookReference;
  manifestVersion: string;
  manifestContractVersion: string;
}

interface RegisteredProfile extends AgentProfileBlueprint {
  readonly frozen: true;
}

const registry = new Map<ProfileName, RegisteredProfile>();

export function registerAgentProfile(blueprint: AgentProfileBlueprint): void {
  if (!blueprint?.name) {
    throw new Error('Agent profile name is required.');
  }
  const trimmedName = blueprint.name.trim();
  if (!trimmedName) {
    throw new Error('Agent profile name cannot be blank.');
  }

  const payload: RegisteredProfile = Object.freeze({
    ...blueprint,
    name: trimmedName,
    label: blueprint.label.trim() || trimmedName,
    frozen: true,
  });

  registry.set(trimmedName, payload);
}

export function hasAgentProfile(name: ProfileName): boolean {
  return registry.has(name.trim());
}

export function getAgentProfile(name: ProfileName): AgentProfileBlueprint {
  const profile = registry.get(name.trim());
  if (!profile) {
    const known = listAgentProfiles()
      .map((entry) => entry.name)
      .sort()
      .join(', ');
    throw new Error(`Unknown profile "${name}". Registered profiles: ${known || 'none'}.`);
  }
  return profile;
}

export function listAgentProfiles(): AgentProfileBlueprint[] {
  return Array.from(registry.values());
}
