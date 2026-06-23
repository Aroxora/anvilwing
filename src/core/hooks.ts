/**
 * Hooks — Claude-Code-style shell-command hooks that fire around
 * tool execution. Lets users customize agent behavior without
 * editing source: run a linter after every Edit, log Bash commands,
 * block dangerous tools, etc.
 *
 * Settings file (per Claude Code convention):
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/path/to/script.sh" }] }
 *       ],
 *       "PostToolUse": [ ... ]
 *     }
 *   }
 *
 * Loaded from (in priority order):
 *   1. <workingDir>/.anvilwing/settings.json    (project-local)
 *   2. ~/.anvilwing/settings.json               (user-global)
 *
 * Both load — project-local extends user-global; matchers from both
 * files fire if applicable.
 *
 * Hook contract: the command receives a JSON envelope on stdin,
 * shape:
 *   { event: 'PreToolUse'|'PostToolUse', toolName, toolArgs, toolResult? }
 * The command exits 0 + writes a JSON response on stdout to either
 * pass through or shape the result:
 *   {}                            — pass through
 *   { "decision": "block",
 *     "reason": "string" }        — PreToolUse: block the tool call
 *   { "appendToResult": "..." }   — PostToolUse: append text to the
 *                                     model-visible tool result
 *
 * Hooks are best-effort: a hook that times out, errors, or returns
 * malformed JSON is logged and skipped — never crashes the agent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';

export interface HookCommand {
  /** Always 'command' for now; reserved for future inline-JS hooks. */
  type: 'command';
  /** Shell command to invoke. Run via the user's default shell. */
  command: string;
  /** Per-hook timeout in ms. Default: 5000. Cap: 30000. */
  timeoutMs?: number;
}

export interface HookMatcher {
  /**
   * For PreToolUse / PostToolUse: a tool-name regex (anchored). Use
   * "*" or omit to match every tool. For other events: ignored.
   */
  matcher?: string;
  hooks: HookCommand[];
}

export interface HooksConfig {
  hooks?: Partial<Record<HookEvent, HookMatcher[]>>;
}

export interface PreToolUseInput {
  event: 'PreToolUse';
  toolName: string;
  toolArgs: unknown;
}

export interface PostToolUseInput {
  event: 'PostToolUse';
  toolName: string;
  toolArgs: unknown;
  toolResult: unknown;
}

export interface PreToolUseDecision {
  decision?: 'block';
  reason?: string;
}

export interface PostToolUseDecision {
  appendToResult?: string;
}

/**
 * Read + merge settings from project-local + user-global locations.
 * Returns an empty config if neither file exists. Malformed JSON is
 * silently skipped (with a console.warn).
 */
export function loadHooksConfig(workingDir: string): HooksConfig {
  const candidates = [
    join(workingDir, '.anvilwing', 'settings.json'),
    join(homedir(), '.anvilwing', 'settings.json'),
  ];
  const merged: Required<HooksConfig> = { hooks: {} };
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let parsed: HooksConfig | null = null;
    try {
      const raw = readFileSync(path, 'utf-8');
      parsed = JSON.parse(raw) as HooksConfig;
    } catch (err) {
      console.warn(`[hooks] Skipping malformed settings: ${path}: ${(err as Error).message}`);
      continue;
    }
    if (!parsed?.hooks) continue;
    for (const ev of Object.keys(parsed.hooks) as HookEvent[]) {
      const list = parsed.hooks[ev];
      if (!Array.isArray(list)) continue;
      const existing = merged.hooks[ev] ?? [];
      // Shallow-validate each entry before merging so the executor
      // never has to re-check shape.
      const safe = list.filter(
        (m): m is HookMatcher =>
          m && typeof m === 'object' && Array.isArray((m as HookMatcher).hooks),
      );
      merged.hooks[ev] = [...existing, ...safe];
    }
  }
  return merged;
}

function matchesMatcher(matcher: string | undefined, toolName: string): boolean {
  if (!matcher || matcher === '*' || matcher === '.*') return true;
  try {
    return new RegExp(`^${matcher}$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/**
 * Run a single hook command with structured input. Returns the
 * parsed JSON response, or null if the hook errored / timed out /
 * returned malformed output. Never throws — non-fatal on purpose.
 */
async function runHookCommand(
  cmd: HookCommand,
  input: PreToolUseInput | PostToolUseInput,
): Promise<Record<string, unknown> | null> {
  const timeoutMs = Math.min(30_000, Math.max(500, cmd.timeoutMs ?? 5000));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    // Run via the platform shell (shell: true) so the command string keeps its
    // native quoting (the reason exec was originally used). `detached` on POSIX
    // makes the shell a process-group LEADER (setsid) so the timeout handler can
    // kill the WHOLE group with a negative pid — grandchildren (e.g. a `node
    // server.js` the hook spawned) included. `exec` is deliberately NOT used: it
    // ignores `detached`, so its children survive a group-kill (verified). We
    // own the timeout below rather than passing one to the child.
    const MAX_OUTPUT = 1024 * 1024;
    const child = spawn(cmd.command, {
      shell: true,
      detached: process.platform !== 'win32',
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (d: Buffer) => {
      if (stdoutBuf.length < MAX_OUTPUT) stdoutBuf += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderrBuf.length < MAX_OUTPUT) stderrBuf += d.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (settled) return;
      if (code) {
        if (stderrBuf.trim()) {
          console.warn(`[hooks] ${cmd.command} exit ${code}: ${stderrBuf.slice(0, 400)}`);
        }
        return finish(null);
      }
      const out = stdoutBuf.trim();
      if (!out) return finish({});
      try {
        const parsed = JSON.parse(out);
        if (parsed && typeof parsed === 'object') return finish(parsed as Record<string, unknown>);
        return finish({});
      } catch {
        // A hook that prints non-JSON is treated as pass-through.
        return finish({});
      }
    });

    // Owned timeout — kill the process tree on expiry. On Windows
    // we use taskkill /T /F to clean up children of the shell wrapper;
    // on POSIX, killing the negative pid of the process group does it.
    const timeout = setTimeout(() => {
      if (settled) return;
      console.warn(`[hooks] ${cmd.command}: timed out after ${timeoutMs}ms`);
      try {
        if (process.platform === 'win32' && child.pid) {
          // /T = terminate child tree, /F = force. Use execFile with an
          // arg array so the PID can never be interpreted as taskkill
          // flags (defense-in-depth — child.pid is a number from Node so
          // injection isn't reachable today, but the safer pattern is
          // free here).
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        } else if (child.pid) {
          // Kill the whole process GROUP (negative pid) so grandchildren die
          // too — the shell is a group leader thanks to detached. Fall back to
          // the bare child if the group signal fails (already-exited / no group).
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }
        }
      } catch (_) { /* best effort */ }
      finish(null);
    }, timeoutMs);
    timeout.unref?.();
    child.on('exit', () => clearTimeout(timeout));

    // A hook that errors/exits fast closes its stdin before we finish
    // writing, which surfaces as an ASYNC 'error' (EPIPE) on the stream —
    // not catchable by the try/catch below. Swallow it so a dead hook is
    // silently skipped instead of crashing the runner with an unhandled
    // stream error.
    child.stdin?.on('error', () => { /* ignore EPIPE from an exited hook */ });
    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch (err) {
      console.warn(`[hooks] stdin write failed: ${(err as Error).message}`);
    }
  });
}

/**
 * Run all PreToolUse hooks matching `toolName`. Returns the FIRST
 * blocking decision encountered, or null if no hook blocks.
 */
export async function runPreToolUseHooks(
  config: HooksConfig,
  toolName: string,
  toolArgs: unknown,
): Promise<PreToolUseDecision | null> {
  const matchers = config.hooks?.PreToolUse ?? [];
  for (const m of matchers) {
    if (!matchesMatcher(m.matcher, toolName)) continue;
    for (const cmd of m.hooks) {
      const result = await runHookCommand(cmd, {
        event: 'PreToolUse',
        toolName,
        toolArgs,
      });
      if (!result) continue;
      if (result['decision'] === 'block') {
        return {
          decision: 'block',
          reason: typeof result['reason'] === 'string' ? result['reason'] : 'Blocked by hook',
        };
      }
    }
  }
  return null;
}

/**
 * Run all PostToolUse hooks matching `toolName`. Concatenates any
 * appendToResult strings (in matcher order) so multiple hooks can
 * each contribute a note.
 */
export async function runPostToolUseHooks(
  config: HooksConfig,
  toolName: string,
  toolArgs: unknown,
  toolResult: unknown,
): Promise<{ appendToResult: string } | null> {
  const matchers = config.hooks?.PostToolUse ?? [];
  const appended: string[] = [];
  for (const m of matchers) {
    if (!matchesMatcher(m.matcher, toolName)) continue;
    for (const cmd of m.hooks) {
      const result = await runHookCommand(cmd, {
        event: 'PostToolUse',
        toolName,
        toolArgs,
        toolResult,
      });
      if (!result) continue;
      const append = result['appendToResult'];
      if (typeof append === 'string' && append.trim()) {
        appended.push(append.trim());
      }
    }
  }
  if (appended.length === 0) return null;
  return { appendToResult: appended.join('\n\n') };
}
