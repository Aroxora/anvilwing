/**
 * Tool Selection Contract v1.0
 *
 * Enumerates the toggleable tool suites that can be surfaced to the agent at
 * runtime plus optional presets that frontends can expose as one-click
 * configurations.
 */

export const TOOL_SELECTION_CONTRACT_VERSION = '1.0.0';

export type ToolPermissionScope =
  | 'filesystem:read'
  | 'filesystem:write'
  | 'process:exec'
  | 'network:web'
  | 'network:api'
  | 'web:fetch'
  | 'web:search'
  | 'analysis:code'
  | 'analysis:quality'
  | 'analysis:dependency'
  | 'analysis:testing'
  | 'analysis:security'
  | 'analysis:notebook'
  | 'planning:refactor'
  | 'integrations:mcp'
  | 'external:web-search';

export type ToolSelectionTarget = 'cli' | 'browser' | 'http' | 'worker' | 'service';

export interface ToolAvailabilityOption {
  id: string;
  label: string;
  description: string;
  category?: string;
  defaultEnabled: boolean;
  pluginIds: string[];
  requiresSecret?: string;
  scopes?: ToolPermissionScope[];
  metadata?: Record<string, unknown>;
}

export interface ToolSelectionPreset {
  id: string;
  label: string;
  description?: string;
  enabled?: string[];
  disabled?: string[];
  locked?: string[];
  appliesTo?: ToolSelectionTarget[];
  metadata?: Record<string, unknown>;
  notes?: string;
}

export interface ToolSelectionManifest {
  contractVersion: string;
  profile: string;
  version: string;
  label?: string;
  description?: string;
  options: ToolAvailabilityOption[];
  presets?: ToolSelectionPreset[];
  metadata?: Record<string, unknown>;
}
