/**
 * Adversarial verifier — the shared critic used across the agent. One
 * model-backed "try to refute this" pass, reused by:
 *   (a) the agent loop's always-on review of a finished answer
 *       (reviewDraft), and
 *   (b) the pre-flight critique of high-impact tool calls
 *       (isHighImpactTool + critiqueToolCall).
 *
 * Gated by the `adversarial` feature flag (default on; /adversarial
 * toggles it). Fail-open everywhere: a critic error or unparseable reply
 * never blocks real work — it just lets the action through unannotated.
 */

import type { ConversationMessage, LLMProvider } from './types.js';
import { loadFeatureFlags } from './preferences.js';

/**
 * Whether the adversarial verifier is enabled (feature flag, default on).
 * Forced off under NODE_ENV=test so it never adds a critic model call to a
 * deterministic agent/tool test turn; on by default everywhere else.
 */
export function isAdversarialEnabled(): boolean {
  if (process.env['NODE_ENV'] === 'test') return false;
  try {
    return loadFeatureFlags().adversarial !== false;
  } catch {
    return false;
  }
}

/** One non-streaming, tool-less completion. Returns trimmed text ('' on a non-message reply). */
async function ask(provider: LLMProvider, system: string, user: string): Promise<string> {
  const messages: ConversationMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const res = await provider.generate(messages, []);
  if (res.type !== 'message') return '';
  return (res.content || '').trim();
}

// Standalone provider for callers that don't already hold one (the tool
// pre-flight). Built once and reused; deterministic (temperature 0). The
// provider/profile/config modules are imported lazily so this file's static
// graph stays free of `import.meta` (config.ts) — that keeps it loadable
// under the jest/babel CJS transform for unit tests.
let cachedProvider: LLMProvider | null = null;
export async function getDefaultCriticProvider(): Promise<LLMProvider> {
  if (cachedProvider) return cachedProvider;
  const [factory, plugins, config, profiles] = await Promise.all([
    import('../providers/providerFactory.js'),
    import('../plugins/providers/index.js'),
    import('../config.js'),
    import('./agentProfiles.js'),
  ]);
  plugins.registerDefaultProviderPlugins();
  const profile = profiles.listAgentProfiles()[0];
  const cfg = config.resolveProfileConfig(profile ? profile.name : 'anvilwing-code', null);
  cachedProvider = factory.createProvider({ provider: cfg.provider, model: cfg.model, temperature: 0, maxTokens: 600 });
  return cachedProvider;
}

// ── (a) review a finished answer ──────────────────────────────────────

export interface DraftReview {
  ok: boolean;
  findings: string;
}

const REVIEW_SYSTEM =
  'You are a terse adversarial reviewer of an AI coding agent. Given the user request, the actions the agent took, and its draft final answer, find concrete defects: claims the answer makes that the actions do not support, work it says it did but did not, untested or risky changes, and direct mismatches between the actions and the answer. If the answer is sound and fully supported, reply with exactly "LGTM" and nothing else. Otherwise reply with a short bullet list of the concrete defects only — no preamble.';

export async function reviewDraft(
  provider: LLMProvider,
  input: { request: string; actions: string; draft: string },
): Promise<DraftReview> {
  try {
    const user =
      `# User request\n${input.request}\n\n` +
      `# Actions the agent took\n${input.actions || '(none)'}\n\n` +
      `# Draft final answer\n${input.draft}`;
    const out = await ask(provider, REVIEW_SYSTEM, user);
    const ok = out.length === 0 || /^lgtm\b/i.test(out);
    return { ok, findings: ok ? '' : out };
  } catch {
    return { ok: true, findings: '' };
  }
}

// ── (b) pre-flight critique of a high-impact tool call ────────────────

const HIGH_IMPACT = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'multiedit', 'multi_edit',
  'bash', 'execute_bash', 'run_command', 'shell',
]);

/** High-impact = mutates the filesystem or runs a shell command. Read-only tools skip the critic. */
export function isHighImpactTool(name: string): boolean {
  return HIGH_IMPACT.has((name || '').toLowerCase());
}

export interface ToolVerdict {
  decision: 'allow' | 'block';
  reason: string;
  riskLevel: 'low' | 'medium' | 'high';
}

const TOOL_SYSTEM =
  'You are an adversarial safety/correctness reviewer for a coding agent about to run a high-impact action (a file write/edit or a shell command). Block ONLY clearly destructive, dangerous, or obviously wrong actions — e.g. rm -rf of unrelated paths, truncating a file to garbage, leaking secrets, irreversible data loss outside the working set. Respond with ONLY a compact JSON object: {"decision":"allow"|"block","reason":string,"riskLevel":"low"|"medium"|"high"}. Default to allow; do not block ordinary edits or normal commands.';

export async function critiqueToolCall(
  provider: LLMProvider,
  toolName: string,
  args: unknown,
): Promise<ToolVerdict> {
  try {
    const user = `Tool: ${toolName}\nArguments:\n${JSON.stringify(args, null, 2).slice(0, 4000)}`;
    const out = await ask(provider, TOOL_SYSTEM, user);
    const match = out.match(/\{[\s\S]*\}/);
    if (!match) return { decision: 'allow', reason: '', riskLevel: 'low' };
    const parsed = JSON.parse(match[0]) as Partial<ToolVerdict>;
    if (parsed.decision === 'block') {
      return {
        decision: 'block',
        reason: parsed.reason || 'flagged by adversarial pre-flight',
        riskLevel: parsed.riskLevel || 'high',
      };
    }
    return { decision: 'allow', reason: parsed.reason || '', riskLevel: parsed.riskLevel || 'low' };
  } catch {
    return { decision: 'allow', reason: '', riskLevel: 'low' };
  }
}
