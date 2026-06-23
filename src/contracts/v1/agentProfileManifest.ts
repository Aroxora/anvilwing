/**
 * Agent Profile Manifest Contract v1.0
 *
 * Canonical description of agent profiles, their default model/provider
 * configuration, and how system prompts are sourced. The manifest is meant
 * to be JSON schema backed so other runtimes can load the same defaults.
 */

import type { ProviderId } from '../../core/types.js';

export const AGENT_PROFILE_MANIFEST_VERSION = '1.0.0';

export interface AgentProfileManifest {
  contractVersion: string;
  version: string;
  label?: string;
  description?: string;
  profiles: AgentProfileEntry[];
  metadata?: Record<string, unknown>;
}

export interface AgentProfileEntry {
  name: string;
  label: string;
  description?: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt: AgentPromptConfig;
  rulebook: AgentRulebookReference;
  metadata?: Record<string, unknown>;
}

export type AgentPromptConfig = RulebookPromptConfig | LiteralPromptConfig;

export interface RulebookPromptConfig {
  type: 'rulebook';
  /**
   * Optional template supporting {{rulebook}}, {{profile}}, and {{profile_name}}
   * placeholders. Defaults to "{{rulebook}}" when omitted.
   */
  template?: string;
  metadata?: Record<string, unknown>;
}

export interface LiteralPromptConfig {
  type: 'literal';
  content: string;
  metadata?: Record<string, unknown>;
}

export type AgentRulebookReference =
  | AgentRulebookFileReference
  | AgentRulebookInlineReference;

export interface AgentRulebookFileReference {
  file: string;
  version?: string;
  contractVersion?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRulebookInlineReference {
  inline: import('../v1/agentRules.js').AgentRulesetManifest;
  version?: string;
  contractVersion?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}
