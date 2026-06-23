import type { ProviderToolDefinition } from '../core/types.js';

/**
 * Builds a lean, effective system prompt for the interactive shell.
 *
 * Design principles:
 * - Use native API system prompt (not user message) for better model compliance
 * - Keep instructions minimal - trust tool descriptions for specifics
 * - Focus on critical behavioral constraints only
 * - Avoid redundancy with tool-level guidance
 */
export function buildInteractiveSystemPrompt(
  basePrompt: string,
  profileLabel: string,
  _tools: ProviderToolDefinition[],
  workspaceDir?: string
): string {
  const name = profileLabel || 'Agent';
  const workspace = workspaceDir || process.cwd();

  const header = `You are ${name}, a coding agent in ${workspace}.`;
  return [basePrompt.trim(), header].filter(Boolean).join('\n\n').trim();
}
