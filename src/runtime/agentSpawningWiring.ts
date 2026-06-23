/**
 * Wires the parallel-sub-agent capability into a live AgentController.
 *
 * The AgentSpawningModule was previously orphaned — it required an
 * LLMProvider instance at construction time, but providers are
 * created per-send in AgentSession, so there was no clean way to
 * register it during runtime construction. This wiring closes the
 * gap: a tool suite is registered AFTER the controller exists, and
 * the tool handler builds a fresh provider matching the controller's
 * current model selection per invocation.
 *
 * Use it from createAgentController:
 *   wireAgentSpawning(controller);
 */

import type { ToolDefinition, ToolSuite } from '../core/toolRuntime.js';
import { LeanAgent } from '../leanAgent.js';
import { createProvider } from '../providers/providerFactory.js';
import { selectionToProviderConfig } from './agentSession.js';
import type { AgentSession, ModelSelection } from './agentSession.js';

const MAX_CONCURRENCY = 5;

interface TaskSpec {
  id: string;
  description: string;
  prompt: string;
}

export interface SubAgentLifecycle {
  phase: 'start' | 'complete';
  id: string;
  description: string;
  success?: boolean;
  elapsedMs?: number;
}

export interface SpawningWiringDeps {
  session: AgentSession;
  workingDir: string;
  /** Returns the controller's current model selection (live reference). */
  getSelection: () => ModelSelection;
  /** Optional: surface each sub-agent's start/finish to the UI (Task notes). */
  notifySubAgent?: (event: SubAgentLifecycle) => void;
}

export function wireAgentSpawning(deps: SpawningWiringDeps): void {
  const tools: ToolDefinition[] = [
    {
      name: 'parallel_agents',
      description:
        'Run several INDEPENDENT sub-tasks in parallel. Each task gets its own sub-agent with the full default toolset. ' +
        `Cap: ${MAX_CONCURRENCY} parallel tasks. Use ONLY when tasks don\'t depend on each other (e.g., reading three unrelated files, ` +
        'creating multiple unrelated files, running unrelated greps). For sequential work or single tasks, just use the regular tools. ' +
        '\n\nParameter `tasks` is a JSON-encoded array: [{ "id": "string", "description": "3-5 word label", "prompt": "full instructions for sub-agent" }, ...]',
      parameters: {
        type: 'object' as const,
        properties: {
          tasks: {
            type: 'string' as const,
            description: 'JSON array of task objects: [{"id":"…","description":"…","prompt":"…"}, …]',
          },
        },
        required: ['tasks'],
      },
      handler: async (args: Record<string, unknown>) => {
        const raw = args['tasks'];
        if (typeof raw !== 'string' || !raw.trim()) {
          return 'Error: tasks must be a JSON-encoded array string.';
        }
        let specs: TaskSpec[];
        try {
          specs = JSON.parse(raw);
        } catch (err) {
          return `Error: tasks JSON parse failed (${(err as Error).message}). Send a JSON array of {id, description, prompt}.`;
        }
        if (!Array.isArray(specs) || specs.length === 0) {
          return 'Error: tasks must be a non-empty JSON array.';
        }
        if (specs.length > MAX_CONCURRENCY) {
          return `Error: max ${MAX_CONCURRENCY} parallel tasks. Got ${specs.length}.`;
        }
        for (const t of specs) {
          if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id.trim() || typeof t.prompt !== 'string' || !t.prompt.trim()) {
            return `Error: each task needs non-empty id + prompt. Bad: ${JSON.stringify(t).slice(0, 200)}`;
          }
        }

        // Build a fresh provider for this batch using the controller's
        // CURRENT selection — sub-agents inherit the user's choice of
        // model without us caching a stale instance.
        const selection = deps.getSelection();
        const providerConfig = selectionToProviderConfig(selection);

        const startedAt = Date.now();
        const results = await Promise.all(
          specs.map(async (task) => {
            const label = task.description || task.id;
            const taskStart = Date.now();
            deps.notifySubAgent?.({ phase: 'start', id: task.id, description: label });
            try {
              // Each sub-agent gets its own provider instance to avoid
              // any concurrent-state issues in providers that aren't
              // hardened for parallel use.
              const provider = createProvider(providerConfig);
              const subAgent = new LeanAgent({
                provider,
                workingDir: deps.workingDir,
                providerId: selection.provider,
                modelId: selection.model,
                systemPrompt:
                  'You are a focused sub-agent. Complete ONE specific task and return a concise report. ' +
                  `Working directory: ${deps.workingDir}.`,
              });
              const response = await subAgent.chat(task.prompt, false);
              deps.notifySubAgent?.({ phase: 'complete', id: task.id, description: label, success: true, elapsedMs: Date.now() - taskStart });
              return { id: task.id, description: label, success: true, output: response.content };
            } catch (err) {
              deps.notifySubAgent?.({ phase: 'complete', id: task.id, description: label, success: false, elapsedMs: Date.now() - taskStart });
              return { id: task.id, description: label, success: false, output: `Error: ${(err as Error).message}` };
            }
          }),
        );

        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const lines: string[] = [
          `Parallel run finished: ${results.length} task(s) in ${elapsed}s.`,
          '',
        ];
        for (const r of results) {
          const tag = r.success ? '✓' : '✗';
          lines.push(`--- [${tag}] ${r.id}: ${r.description} ---`);
          lines.push(r.output);
          lines.push('');
        }
        return lines.join('\n').trimEnd();
      },
    },
  ];

  const suite: ToolSuite = {
    id: 'agent-spawning.tools',
    description: 'Parallel sub-agent execution',
    tools,
  };
  deps.session.toolRuntime.registerSuite(suite);
}
