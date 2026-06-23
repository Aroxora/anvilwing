/**
 * TodoWrite / TodoRead tools — Claude-Code-parity task list.
 *
 * The agent uses TodoWrite to track multi-step work. Each call
 * REPLACES the entire list (not append) so the agent owns the full
 * state each turn. TodoRead returns the current list without modifying
 * it, useful at the start of a new turn to check plan state.
 *
 * State is kept per-process (CLI = single process), so a session-long
 * todo list persists across turns until the agent rewrites it.
 */

import type { ToolDefinition } from '../core/toolRuntime.js';
import { formatPlan, type PlanStatus } from '../utils/planFormatter.js';

interface Todo {
  content: string;
  status: PlanStatus;
  activeForm?: string;
}

/**
 * Module-scoped state. CLI runs one process per session; the list
 * stays in memory until the process exits or the agent rewrites it.
 */
let CURRENT_TODOS: Todo[] = [];

export function getCurrentTodos(): readonly Todo[] {
  return CURRENT_TODOS;
}
export function clearCurrentTodos(): void {
  CURRENT_TODOS = [];
}

/**
 * The live plan as a transient <system-reminder> for re-injection into each
 * request (Claude Code parity). Returns null when there's nothing actionable
 * (empty plan, or every item completed) so a finished/absent plan adds no
 * noise. The agent injects this fresh each turn — NOT persisted in history —
 * so the model never loses its checklist when older turns are compacted away.
 */
export function buildTodoReminder(): string | null {
  const todos = CURRENT_TODOS;
  if (!todos.length) return null;
  if (!todos.some((t) => t.status === 'pending' || t.status === 'in_progress')) return null;
  const lines = todos.map((t) => {
    const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
    const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    return `${box} ${label}`;
  });
  return [
    '<system-reminder>',
    'Your current task plan (from TodoWrite). Keep going until EVERY item is [x] completed — do not stop while items remain open.',
    'As you complete each item, call TodoWrite to mark it completed and set the next one in_progress.',
    ...lines,
    '</system-reminder>',
  ].join('\n');
}

function normalize(input: unknown): Todo[] {
  if (!Array.isArray(input)) return [];
  const out: Todo[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const content = typeof rec['content'] === 'string' ? rec['content'].trim() : '';
    if (!content) continue;
    const rawStatus = typeof rec['status'] === 'string' ? rec['status'].toLowerCase() : 'pending';
    const status: PlanStatus =
      rawStatus === 'completed' ? 'completed'
      : rawStatus === 'in_progress' || rawStatus === 'in-progress' ? 'in_progress'
      : 'pending';
    const activeForm = typeof rec['activeForm'] === 'string' ? rec['activeForm'].trim() : undefined;
    out.push({ content, status, ...(activeForm ? { activeForm } : {}) });
  }
  return out;
}

export function createTodoTools(): ToolDefinition[] {
  return [
    {
      name: 'TodoRead',
      description: [
        'Read the current task list without modifying it.',
        'Call this at the start of a new turn to check plan state before deciding',
        'what to do next. Returns the todos as a JSON array.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async () => {
        if (CURRENT_TODOS.length === 0) {
          return 'No todos. Use TodoWrite to create a plan.';
        }
        return JSON.stringify(CURRENT_TODOS, null, 2);
      },
    },
    {
      name: 'TodoWrite',
      description: [
        'Create or replace the agent\'s working task list. Use proactively for any',
        'multi-step task (3+ distinct steps). Pass the COMPLETE list every time —',
        'each call replaces the previous list. Mark a task `in_progress` BEFORE',
        'starting it and `completed` IMMEDIATELY after, before moving to the next.',
        'The list shows the user what the agent is planning vs. what\'s done.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full task list. Replaces the previous one entirely.',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Imperative task title (e.g. "Fix the auth bug").' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current state. Exactly one task should be in_progress at a time.',
                },
                activeForm: {
                  type: 'string',
                  description: 'Present-continuous form shown while in_progress (e.g. "Fixing the auth bug"). Optional.',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const todos = normalize((args as Record<string, unknown>)['todos']);
        CURRENT_TODOS = todos;
        // Soft validation: at most one in_progress at a time.
        const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
        const validationNote = inProgressCount > 1
          ? `\n  Warning: ${inProgressCount} tasks are in_progress — only one should be active at a time.`
          : '';
        const planItems = todos.map((t) => ({
          step: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content,
          status: t.status,
        }));
        const formatted = formatPlan(planItems, { heading: 'Updated Plan' });
        return `${formatted}${validationNote}`;
      },
    },
  ];
}
