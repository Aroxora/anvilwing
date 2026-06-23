/**
 * Permission mode — Claude Code's Shift+Tab interaction model, adapted to
 * Anvilwing Coder. Session-only state (never persisted; resets to `default`
 * on each launch, exactly like Claude Code) cycled default → acceptEdits →
 * plan → default.
 *
 * Three modes, each load-bearing:
 *   - default     : the repo's guardrail-free auto-run (unchanged). The
 *                   adversarial pre-flight still critiques high-impact calls.
 *   - acceptEdits : trusts file edits — they skip the adversarial pre-flight
 *                   critique so iteration on code is faster/quieter.
 *   - plan        : read-only. Any tool that mutates the filesystem, runs a
 *                   shell command, or commits is blocked at the runtime
 *                   chokepoint. The agent must investigate read-only and
 *                   present a plan; the user approves before changes run.
 *
 * State lives module-level (mirrors isAdversarialEnabled / ultracode) so the
 * single tool chokepoint (ToolRuntime.execute) and the Ink UI read the same
 * source of truth without threading it through every constructor.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

let current: PermissionMode = 'default';

export function getPermissionMode(): PermissionMode {
  return current;
}

export function setPermissionMode(mode: PermissionMode): void {
  if (MODES.includes(mode)) current = mode;
}

/** Advance to the next mode in the cycle and return it (the Shift+Tab action). */
export function cyclePermissionMode(): PermissionMode {
  current = MODES[(MODES.indexOf(current) + 1) % MODES.length]!;
  return current;
}

// Tools that change state outside the conversation: filesystem writes, shell
// commands, notebook edits, and git mutations. Names are matched
// case-insensitively against every alias the tool registry exposes.
const MUTATING_TOOLS = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'multiedit', 'multi_edit',
  'delete_file', 'delete', 'notebookedit', 'notebook_edit',
  'git_commit', 'git_push',
  'bash', 'execute_bash', 'execute_command', 'run_command', 'shell',
]);

const EDIT_TOOLS = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'multiedit', 'multi_edit',
  'delete_file', 'notebookedit', 'notebook_edit',
]);

// Plan mode is DENY-BY-DEFAULT: only tools that cannot change the filesystem,
// the repo, processes, or spawn something that could are allowed; everything
// else is blocked. This is the safe-by-default inverse of an allowlist of
// mutators — a tool added later is blocked in plan mode until it's explicitly
// vetted here as read-only, so plan mode can't silently leak (the old allowlist
// missed search_replace, the `git` tool, git_smart_commit, git_create_pr,
// GitRestore, Skill, Agent — all of which could mutate despite "read-only").
// bash is NOT here: its args can do anything. TodoWrite IS, because writing the
// plan is the whole point of plan mode. HITL prompts ask the user; they don't
// touch the workspace.
const PLAN_MODE_READONLY = new Set([
  // file / code reads
  'read', 'read_file', 'list_files', 'file_exists', 'glob', 'grep', 'search',
  // web reads
  'web_fetch', 'webfetch', 'web_search', 'websearch', 'webextract',
  // planning artifacts
  'todoread', 'todowrite',
  // background / subagent + git reads
  'bashoutput', 'agent_status', 'agent_output', 'agent_list', 'githistory',
  // memory reads
  'memory_load', 'memory_list',
  // misc reads / user interaction
  'list_skills', 'hitl_status', 'hitl_decision', 'hitl_select', 'hitl_yesno', 'hitl_approval',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has((name || '').toLowerCase());
}

/** True when a tool is safe to run in plan mode (cannot mutate the workspace). */
export function isPlanModeReadOnly(name: string): boolean {
  return PLAN_MODE_READONLY.has((name || '').toLowerCase());
}

export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has((name || '').toLowerCase());
}

/**
 * The error string a tool returns when plan mode forbids it, or null when the
 * call is allowed. Returned (not thrown) so it flows back to the model as a
 * normal tool result it can react to.
 */
export function planModeBlock(toolName: string): string | null {
  if (current !== 'plan') return null;
  // Deny-by-default: allow only vetted read-only tools, block everything else.
  if (isPlanModeReadOnly(toolName)) return null;
  return `Error: ${toolName} is disabled in plan mode (read-only). Investigate without changing anything, then present a concrete plan; the user approves it before any edits or commands run. Press Shift+Tab to leave plan mode.`;
}

/**
 * Whether the post-turn auto-continue loop may relaunch in the current mode.
 * Plan mode is a single planning pass — the model investigates (read-only) and
 * proposes a plan; the user approves it by leaving plan mode (Shift+Tab).
 * Auto-continuing in plan mode only re-drives the mutating-tool attempts that
 * planModeBlock denies, looping uselessly until the governor stall — so the run
 * ends on "Paused: no progress" instead of yielding the plan for approval.
 * Auto-continue is therefore allowed in every mode EXCEPT plan.
 */
export function autoContinueAllowed(autoMode: string, mode: PermissionMode = current): boolean {
  return autoMode !== 'off' && mode !== 'plan';
}

/** acceptEdits trusts file edits — skip the adversarial pre-flight critique for them. */
export function shouldSkipPreflight(toolName: string): boolean {
  return current === 'acceptEdits' && isEditTool(toolName);
}

export interface PermissionModeSegment {
  label: string;
  active: boolean;
}

/**
 * The persistent toggle-modes strip under the input box: all three modes,
 * exactly one active. The renderer highlights the active segment (ember)
 * and dims the rest.
 */
export function permissionModeStrip(mode: PermissionMode = current): PermissionModeSegment[] {
  return [
    { label: '⏵ default', active: mode === 'default' },
    { label: '⏵⏵ accept edits', active: mode === 'acceptEdits' },
    { label: '⏸ plan', active: mode === 'plan' },
  ];
}

/** The dim trailing hint at the end of the toggle-modes strip. */
export function permissionHint(mode: PermissionMode = current): string {
  return mode === 'default' ? 'shift+tab — ? for shortcuts' : 'shift+tab to cycle';
}

/**
 * Short chip for the below-box meta line (InkPromptController.formatModeChips),
 * or null in default mode (keep chrome quiet). The PTY e2e runner
 * (scripts/e2e-ink-cli-runner.mjs) uses it as the only plain-text witness of
 * the active mode — the strip highlight is color-only.
 */
export function permissionStatusChip(mode: PermissionMode = current): string | null {
  switch (mode) {
    case 'acceptEdits': return 'accept-edits';
    case 'plan': return 'plan';
    default: return null;
  }
}
