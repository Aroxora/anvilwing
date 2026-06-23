/**
 * Agent Rules Contract v1.0
 *
 * Describes the structured rule set that governs how the agent moves through
 * phases, steps, and sub-steps during a task. Each step enumerates explicit
 * rules so downstream runtimes can render or validate the workflow without
 * relying on bespoke prompt text.
 */

export const AGENT_RULES_CONTRACT_VERSION = '1.0.0';

export type AgentRuleSeverity = 'critical' | 'required' | 'recommended';

export interface AgentRuleReference {
  label: string;
  url?: string;
  file?: string;
  line?: number;
}

export interface AgentRuleDefinition {
  id: string;
  summary: string;
  detail?: string;
  severity: AgentRuleSeverity;
  appliesDuring?: string[];
  evidenceRequired?: string;
  references?: AgentRuleReference[];
  toolHints?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentStepRule {
  id: string;
  title: string;
  description?: string;
  intent?: string;
  entryCriteria?: string[];
  exitCriteria?: string[];
  allowedTools?: string[];
  blockedTools?: string[];
  notes?: string[];
  rules: AgentRuleDefinition[];
  subSteps?: AgentStepRule[];
  metadata?: Record<string, unknown>;
}

export interface AgentRulePhase {
  id: string;
  label: string;
  description?: string;
  trigger?: string;
  steps: AgentStepRule[];
  metadata?: Record<string, unknown>;
}

export interface AgentRulesetManifest {
  contractVersion: string;
  profile: string;
  version: string;
  label?: string;
  description?: string;
  globalPrinciples?: AgentRuleDefinition[];
  phases: AgentRulePhase[];
  metadata?: Record<string, unknown>;
}
