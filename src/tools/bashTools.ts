import { spawn, ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { reportToolProgress } from '../core/toolRuntime.js';
import { validateBashCommand, SmartFixer } from '../core/errors/safetyValidator.js';
import { toStructuredError } from '../core/errors/errorTypes.js';
import { analyzeBashFlow } from '../core/bashCommandGuidance.js';
import { buildError } from '../core/errors.js';
import {
  verifiedSuccess,
  verifiedFailure,
  analyzeOutput,
  OutputPatterns,
  createCommandCheck,
} from '../core/resultVerification.js';
import { createErrorFixer, type AIErrorFixer } from '../core/aiErrorFixer.js';
import { logDebug } from '../utils/debugLogger.js';
import { createTestMonitor, isTestCommand, type TestFailureMonitor } from '../core/testFailureMonitor.js';
import { getSudoPassword, invalidateSudoPassword } from '../core/sudoPasswordManager.js';
import { onShutdown } from '../core/shutdown.js';

// ANSI color codes for enhanced output
const ANSI_RESET = '\x1b[0m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BLUE = '\x1b[34m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED_BOLD = '\x1b[1;31m';
const ANSI_GREEN_BOLD = '\x1b[1;32m';
const ANSI_YELLOW_BOLD = '\x1b[1;33m';

// ============================================================================
// Background Shell Manager (consolidated from backgroundBashTools.ts)
// ============================================================================

export class BackgroundShell {
  private static readonly MAX_BUFFER = 1_000_000; // ~1MB retained per stream

  private process?: ChildProcess;
  // Rolling buffers capped at MAX_BUFFER. `*Dropped` counts bytes evicted from
  // the front (so absolute offsets survive eviction); `*Read` is the absolute
  // offset already returned by a poll. This bounds memory and makes each poll a
  // single bounded slice instead of an O(n) re-join of an ever-growing array.
  private stdoutBuf = '';
  private stderrBuf = '';
  private stdoutDropped = 0;
  private stderrDropped = 0;
  private stdoutRead = 0;
  private stderrRead = 0;
  private isRunning = false;
  private exitCode?: number;

  constructor(
    public readonly id: string,
    private command: string,
    private workingDir: string,
    private killEscalationMs = 5000
  ) {}

  start(): void {
    this.process = spawn('bash', ['-c', this.command], {
      cwd: this.workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.isRunning = true;

    this.process.stdout?.on('data', (data) => {
      [this.stdoutBuf, this.stdoutDropped] = this.appendCapped(this.stdoutBuf, this.stdoutDropped, data.toString());
    });

    this.process.stderr?.on('data', (data) => {
      [this.stderrBuf, this.stderrDropped] = this.appendCapped(this.stderrBuf, this.stderrDropped, data.toString());
    });

    this.process.on('exit', (code) => {
      this.exitCode = code ?? 0;
      this.isRunning = false;
    });
  }

  /** Append a chunk, evicting the oldest bytes past MAX_BUFFER. Returns the new
   *  [buffer, totalDroppedBytes]. */
  private appendCapped(buf: string, dropped: number, chunk: string): [string, number] {
    buf += chunk;
    if (buf.length > BackgroundShell.MAX_BUFFER) {
      let drop = buf.length - BackgroundShell.MAX_BUFFER;
      // Don't start the retained buffer on a lone low surrogate — that would
      // emit a replacement char. Drop one more code unit to land on a boundary.
      const lead = buf.charCodeAt(drop);
      if (lead >= 0xdc00 && lead <= 0xdfff) drop += 1;
      buf = buf.slice(drop);
      dropped += drop;
    }
    return [buf, dropped];
  }

  private takeNew(buf: string, dropped: number, read: number): { text: string; nextRead: number } {
    const endAbs = dropped + buf.length;
    const startAbs = Math.max(read, dropped);
    let text = buf.slice(startAbs - dropped);
    // No silent caps: if the cap evicted bytes the reader never saw, say so.
    if (dropped > read && text) {
      text = `[…${dropped - read} bytes dropped to bound the buffer…]\n${text}`;
    }
    return { text, nextRead: endAbs };
  }

  getNewOutput(filter?: RegExp): { stdout: string; stderr: string; status: string } {
    const out = this.takeNew(this.stdoutBuf, this.stdoutDropped, this.stdoutRead);
    this.stdoutRead = out.nextRead;
    const err = this.takeNew(this.stderrBuf, this.stderrDropped, this.stderrRead);
    this.stderrRead = err.nextRead;

    let stdout = out.text;
    let stderr = err.text;
    if (filter) {
      stdout = stdout.split('\n').filter(line => filter.test(line)).join('\n');
      stderr = stderr.split('\n').filter(line => filter.test(line)).join('\n');
    }

    return {
      stdout,
      stderr,
      status: this.isRunning ? 'running' : `exited with code ${this.exitCode}`,
    };
  }

  kill(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        // `.killed` only reflects that a signal was *sent*, not that the
        // process exited — so it is true immediately after the SIGTERM above
        // and SIGKILL would never fire. Escalate on real liveness instead (the
        // 'exit' handler clears isRunning), or a SIGTERM-trapping process
        // survives forever.
        if (this.isRunning && this.process) {
          this.process.kill('SIGKILL');
        }
      }, this.killEscalationMs);
    }
  }
}

class BackgroundShellManager {
  private shells = new Map<string, BackgroundShell>();
  private nextId = 1;

  createShell(command: string, workingDir: string): string {
    const shellId = `shell_${this.nextId++}`;
    const shell = new BackgroundShell(shellId, command, workingDir);
    this.shells.set(shellId, shell);
    shell.start();
    return shellId;
  }

  getShell(shellId: string): BackgroundShell | undefined {
    return this.shells.get(shellId);
  }

  killShell(shellId: string): boolean {
    const shell = this.shells.get(shellId);
    if (shell) {
      shell.kill();
      this.shells.delete(shellId);
      return true;
    }
    return false;
  }

  listShells(): string[] {
    return Array.from(this.shells.keys());
  }

  killAll(): void {
    for (const id of Array.from(this.shells.keys())) {
      this.killShell(id);
    }
  }
}

// Global shell manager instance
const shellManager = new BackgroundShellManager();

// Reap background shells when the CLI shuts down — otherwise a long-running
// background command (e.g. a dev server) outlives the process that spawned it.
onShutdown(() => shellManager.killAll());

/**
 * Number of currently running background shells. Used by the chat-box footer.
 */
export function getBackgroundShellCount(): number {
  return shellManager.listShells().length;
}

// ============================================================================
// Streaming Execution
// ============================================================================

interface StreamingExecOptions {
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  testMonitor?: TestFailureMonitor | null;
}

interface StreamingExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  earlyAbort?: boolean;
  abortReason?: string;
  abortMessage?: string;
}

async function execWithStreaming(
  command: string,
  options: StreamingExecOptions
): Promise<StreamingExecResult> {
  const MAX_BUFFER_BYTES = 1_000_000; // ~1MB per stream to prevent OOM on chatty commands
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lineCount = 0;
    let killed = false;
    let childExited = false;
    let earlyAbort = false;
    let abortReason: string | undefined;

    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, options.timeout);

    // Early abort function for test failures
    const triggerEarlyAbort = (reason: string) => {
      if (earlyAbort) return; // Already aborting
      earlyAbort = true;
      abortReason = reason;
      logDebug(`[Bash] Early abort triggered: ${reason}`);
      reportToolProgress({
        current: lineCount,
        message: `⚡ Early abort: ${reason}`,
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        // `.killed` only means a signal was *sent*, not that the process
        // exited — escalate based on real liveness, or a SIGTERM-trapping
        // process survives.
        if (!childExited) {
          child.kill('SIGKILL');
        }
      }, 2000);
    };

    const processLine = (line: string, isStderr: boolean) => {
      lineCount++;
      const trimmedLine = line.slice(0, 80);
      reportToolProgress({
        current: lineCount,
        message: isStderr ? `stderr: ${trimmedLine}` : trimmedLine,
      });

      // Feed line to test monitor for real-time failure detection
      if (options.testMonitor && !earlyAbort) {
        const shouldAbort = options.testMonitor.processLine(line);
        if (shouldAbort) {
          const state = options.testMonitor.getState();
          triggerEarlyAbort(state.abortReason || 'Test failures detected');
        }
      }
    };

    const appendChunk = (chunks: string[], data: Buffer, isStdout: boolean): void => {
      chunks.push(data.toString());
      let bytes = (isStdout ? stdoutBytes : stderrBytes) + data.length;
      // Keep the TAIL, not the head. A command's conclusion — the error, the
      // "N tests failed" summary, the final exit status — is at the END of its
      // output. The old code dropped the NEWEST bytes once 1MB was buffered, so
      // a verbose build/test that overflowed lost exactly the part the agent
      // needed to know what happened. Roll the oldest chunks off the front.
      let dropped = false;
      while (bytes > MAX_BUFFER_BYTES && chunks.length > 1) {
        bytes -= Buffer.byteLength(chunks.shift() as string);
        dropped = true;
      }
      if (isStdout) {
        stdoutBytes = bytes;
        if (dropped) stdoutTruncated = true;
      } else {
        stderrBytes = bytes;
        if (dropped) stderrTruncated = true;
      }
    };

    let stdoutBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendChunk(stdout, data, true);
      stdoutBuffer += text;
      if (stdoutBuffer.length > 4096) {
        stdoutBuffer = stdoutBuffer.slice(-2048);
      }
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) processLine(line, false);
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendChunk(stderr, data, false);
      stderrBuffer += text;
      if (stderrBuffer.length > 4096) {
        stderrBuffer = stderrBuffer.slice(-2048);
      }
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) processLine(line, true);
      }
    });

    const buildOutput = (chunks: string[], truncated: boolean): string => {
      const output = chunks.join('');
      if (!truncated) return output;
      const limitKb = Math.round(MAX_BUFFER_BYTES / 1024);
      // The head was dropped, so the notice goes ON TOP and says so — the kept
      // text below is the most recent ~limitKb, including the final result.
      const notice = `[earlier output truncated to protect memory; showing the LAST ~${limitKb}KB, which includes the command's final output]\n`;
      return output ? `${notice}${output}` : notice.trim();
    };

    child.on('close', (code) => {
      childExited = true;
      clearTimeout(timeoutId);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer, false);
      if (stderrBuffer.trim()) processLine(stderrBuffer, true);

      const stdoutText = buildOutput(stdout, stdoutTruncated);
      const stderrText = buildOutput(stderr, stderrTruncated);

      if (killed && !earlyAbort) {
        reject({ killed: true, stdout: stdoutText, stderr: stderrText, code });
      } else {
        const result: StreamingExecResult = {
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: earlyAbort ? 1 : (code ?? 0),
        };

        if (earlyAbort && options.testMonitor) {
          result.earlyAbort = true;
          result.abortReason = abortReason;
          result.abortMessage = options.testMonitor.formatAbortMessage();
        }

        resolve(result);
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// Deterministic, locale-proof sudo prompt. We detect THIS exact string on
// stderr to know precisely when sudo is asking for the password, instead of
// guessing from localized "[sudo] password" / "Password:" text. No spaces so it
// survives `bash -c` as a single token without quoting.
const SUDO_PROMPT_SENTINEL = 'anvilwing-sudo-auth-prompt:';

/**
 * Execute a sudo command with password authentication.
 * Uses `sudo -S -k -p`: -S reads the password from stdin, -k forces sudo to
 * re-authenticate (so it ALWAYS consumes our password line rather than letting
 * a cached-credential pass-through leak it into the command), and -p sets the
 * sentinel prompt we detect. Exported for the security regression test.
 */
export async function execSudoWithPassword(
  command: string,
  password: string,
  options: StreamingExecOptions
): Promise<StreamingExecResult> {
  const MAX_BUFFER_BYTES = 1_000_000;
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lineCount = 0;
    let killed = false;
    let passwordSent = false;

    // -S (stdin) + -k (ignore cached creds, always prompt) + -p (sentinel
    // prompt). -k is the security-critical flag: without it, cached credentials
    // make sudo skip stdin entirely and the password we write falls through to
    // the command's own stdin (a leak). With -k, sudo always consumes our
    // password line itself.
    const sudoCommand = command.replace(
      /^\s*sudo\s+/,
      `sudo -S -k -p ${SUDO_PROMPT_SENTINEL} `,
    );

    const child = spawn('bash', ['-c', sudoCommand], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'], // Connect stdin for password
    });

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, options.timeout);

    const processLine = (line: string, isStderr: boolean) => {
      // Filter out password prompt from output
      if (line.includes(SUDO_PROMPT_SENTINEL) || line.includes('[sudo] password') || line.includes('Password:')) {
        return;
      }
      lineCount++;
      const trimmedLine = line.slice(0, 80);
      reportToolProgress({
        current: lineCount,
        message: isStderr ? `stderr: ${trimmedLine}` : trimmedLine,
      });
    };

    const appendChunk = (chunks: string[], data: Buffer, isStdout: boolean): void => {
      // Tail-keep (see execWithStreaming): a command's conclusion is at the end.
      chunks.push(data.toString());
      let bytes = (isStdout ? stdoutBytes : stderrBytes) + data.length;
      let dropped = false;
      while (bytes > MAX_BUFFER_BYTES && chunks.length > 1) {
        bytes -= Buffer.byteLength(chunks.shift() as string);
        dropped = true;
      }
      if (isStdout) {
        stdoutBytes = bytes;
        if (dropped) stdoutTruncated = true;
      } else {
        stderrBytes = bytes;
        if (dropped) stderrTruncated = true;
      }
    };

    let stdoutBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendChunk(stdout, data, true);
      stdoutBuffer += text;
      if (stdoutBuffer.length > 4096) {
        stdoutBuffer = stdoutBuffer.slice(-2048);
      }
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) processLine(line, false);
      }
    });

    let stderrBuffer = '';
    let promptScan = ''; // bounded accumulator so a prompt split across chunks is still detected
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();

      // Send the password ONLY in response to sudo's actual prompt. This is the
      // single place the password is ever written — never on a blind timer — so
      // it can only reach sudo (which is asking for it), never the command. Scan
      // the ACCUMULATED tail (not just this chunk) so a prompt delivered across
      // two reads still matches instead of hanging until timeout.
      if (!passwordSent) {
        promptScan = (promptScan + text).slice(-256);
        if (promptScan.includes(SUDO_PROMPT_SENTINEL) || promptScan.includes('[sudo] password') || promptScan.includes('Password:')) {
          child.stdin?.write(password + '\n');
          child.stdin?.end();
          passwordSent = true;
          reportToolProgress({ current: 0, message: 'Authenticating with sudo…' });
          return; // Don't add password prompt to output
        }
      }

      // Filter password prompt lines from output
      const filteredText = text.split('\n')
        .filter(line => !line.includes(SUDO_PROMPT_SENTINEL) && !line.includes('[sudo] password') && !line.includes('Password:'))
        .join('\n');

      if (filteredText) {
        appendChunk(stderr, Buffer.from(filteredText), false);
        stderrBuffer += filteredText;
        if (stderrBuffer.length > 4096) {
          stderrBuffer = stderrBuffer.slice(-2048);
        }
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) processLine(line, true);
        }
      }
    });

    // Safety net: if sudo never prompts within the window (a NOPASSWD rule, or a
    // non-sudo command), close stdin so a command that reads it sees EOF instead
    // of hanging. CRITICAL: never write the password here — writing it blindly
    // when sudo didn't consume it is exactly how it leaks into the command's own
    // stdin. We only close, never write.
    const stdinCloseTimer = setTimeout(() => {
      if (!passwordSent && child.stdin?.writable) {
        child.stdin?.end();
      }
    }, 3000);

    const buildOutput = (chunks: string[], truncated: boolean): string => {
      const output = chunks.join('');
      // Filter out any remaining password-related lines (incl. our sentinel
      // prompt, in case a split chunk slipped one through before detection).
      const filtered = output.split('\n')
        .filter(line => !line.includes(SUDO_PROMPT_SENTINEL) && !line.includes('[sudo] password') && !line.includes('Password:') && !line.includes('Sorry, try again'))
        .join('\n');
      if (!truncated) return filtered;
      const limitKb = Math.round(MAX_BUFFER_BYTES / 1024);
      // Head was dropped (tail-keep) — notice goes on top.
      const notice = `[earlier output truncated to protect memory; showing the LAST ~${limitKb}KB, which includes the command's final output]\n`;
      return filtered ? `${notice}${filtered}` : notice.trim();
    };

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer, false);
      if (stderrBuffer.trim()) processLine(stderrBuffer, true);

      clearTimeout(stdinCloseTimer);
      const stdoutText = buildOutput(stdout, stdoutTruncated);
      const stderrText = buildOutput(stderr, stderrTruncated);

      // Check for authentication failure
      const combinedOutput = stdoutText + stderrText;
      if (combinedOutput.includes('Sorry, try again') ||
          combinedOutput.includes('incorrect password') ||
          combinedOutput.includes('Authentication failure') ||
          (code !== 0 && combinedOutput.includes('sudo:'))) {
        // Invalid password - invalidate cache
        invalidateSudoPassword();
      }

      if (killed) {
        reject({ killed: true, stdout: stdoutText, stderr: stderrText, code });
      } else {
        resolve({
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code ?? 0,
        });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

// Keep the shell responsive while long commands run
function findGuiLauncher(_command: string): string | null {
  return null;
}

const errorFixerCache = new Map<string, AIErrorFixer>();
function getErrorFixer(workingDir: string): AIErrorFixer {
  let fixer = errorFixerCache.get(workingDir);
  if (!fixer) {
    fixer = createErrorFixer({ workingDir });
    errorFixerCache.set(workingDir, fixer);
  }
  return fixer;
}

/**
 * Smart timeout detection based on command type
 */
function getSmartTimeout(command: string): number {
  const cmd = command.toLowerCase().trim();

  // Long-running commands that legitimately take time
  if (cmd.includes('npm install') || cmd.includes('yarn install') || cmd.includes('pnpm install')) {
    return 10 * 60 * 1000; // 10 minutes for package installs
  }
  if (cmd.includes('npm run build') || cmd.includes('yarn build') || cmd.includes('make')) {
    return 10 * 60 * 1000; // 10 minutes for builds
  }
  if (cmd.includes('docker build') || cmd.includes('docker-compose')) {
    return 15 * 60 * 1000; // 15 minutes for docker builds
  }
  if (cmd.includes('npm test') || cmd.includes('yarn test') || cmd.includes('pytest') || cmd.includes('jest')) {
    return 10 * 60 * 1000; // 10 minutes for tests
  }
  if (cmd.includes('git clone') || cmd.includes('git fetch') || cmd.includes('git pull')) {
    return 5 * 60 * 1000; // 5 minutes for git network ops
  }

  // Default timeout for most commands - prevents hung commands from blocking
  return 2 * 60 * 1000; // 2 minutes default
}

// ============================================================================
// Sandbox Environment
// ============================================================================

interface SandboxPaths {
  root: string;
  home: string;
  cache: string;
  config: string;
  data: string;
  tmp: string;
}

const sandboxCache = new Map<string, Promise<SandboxPaths>>();

async function ensureSandboxPaths(workingDir: string): Promise<SandboxPaths> {
  let pending = sandboxCache.get(workingDir);
  if (!pending) {
    pending = createSandboxPaths(workingDir);
    // Evict a FAILED attempt so a transient mkdir error (EACCES, disk full,
    // read-only mount at startup) doesn't permanently poison execute_bash for
    // this cwd — a cached rejected promise would replay forever. The next call
    // retries. Guard the delete against a newer attempt having replaced us.
    pending.catch(() => {
      if (sandboxCache.get(workingDir) === pending) {
        sandboxCache.delete(workingDir);
      }
    });
    sandboxCache.set(workingDir, pending);
  }
  return pending;
}

async function createSandboxPaths(workingDir: string): Promise<SandboxPaths> {
  const root = join(workingDir, '.anvilwing', 'shell-sandbox');
  const home = join(root, 'home');
  const cache = join(root, 'cache');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const tmp = join(root, 'tmp');
  await Promise.all([home, cache, config, data, tmp].map((dir) => mkdir(dir, { recursive: true })));
  return { root, home, cache, config, data, tmp };
}

/**
 * Detect if a command needs access to the real home directory for cloud CLI credentials.
 * Commands like firebase, gcloud, aws, az, kubectl require access to stored credentials.
 */
/**
 * True if `command` actually INVOKES one of `tools` — i.e. the tool name sits at
 * a command position (start of the line or a pipeline segment, possibly after
 * benign prefixes like sudo/env/npx), not merely anywhere in the text. A bare
 * `\btool\b` match misfired badly on short/common names: `echo "let's fly"` and
 * `cat az.txt` would "invoke" fly.io / Azure, and innocuous text was refused.
 */
function commandInvokes(command: string, tools: readonly string[]): boolean {
  const prefix = '(?:(?:sudo|env|time|command|nice|npx|exec)\\s+(?:[A-Za-z_][\\w]*=\\S+\\s+)*)*';
  const re = new RegExp(`(?:^|[\\n;&|(])\\s*${prefix}(?:${tools.map(escapeRegExp).join('|')})\\b`, 'i');
  return re.test(command);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function needsRealHome(command: string): boolean {
  return (
    commandInvokes(command, [
      'firebase', 'gcloud', 'gsutil', 'aws', 'az', 'kubectl', 'helm', 'docker',
      'gh', 'vercel', 'netlify', 'heroku', 'fly', 'supabase', 'wrangler',
    ]) ||
    // Package-manager publish (needs the registry auth in the real home).
    /(?:^|[\n;&|(])\s*(?:npm|yarn|pnpm)\s+publish\b/i.test(command)
  );
}

/**
 * The single source of truth for whether a command runs against the REAL home
 * (cloud-CLI credentials) or the sandbox. Honors ANVILWING_PRESERVE_HOME (1/0),
 * then an explicit option, then whether the command needs cloud-CLI creds. Both
 * buildSandboxEnv and the user-facing [sandboxed]/[real credentials] label use
 * this, so the label can't disagree with the actual environment.
 */
export function resolvesToRealHome(options?: { preserveHome?: boolean; command?: string }): boolean {
  const envPreference = process.env['ANVILWING_PRESERVE_HOME'];
  if (envPreference === '1') return true;
  if (envPreference === '0') return false;
  const commandNeedsHome = options?.command ? needsRealHome(options.command) : false;
  return Boolean(options?.preserveHome) || commandNeedsHome;
}

export async function buildSandboxEnv(
  workingDir: string,
  options?: { preserveHome?: boolean; command?: string }
): Promise<NodeJS.ProcessEnv> {
  const preserveHome = resolvesToRealHome(options);

  const paths = await ensureSandboxPaths(workingDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANVILWING_SANDBOX_ROOT: paths.root,
    ANVILWING_SANDBOX_HOME: paths.home,
    ANVILWING_SANDBOX_TMP: paths.tmp,
  };

  if (!preserveHome) {
    env['HOME'] = paths.home;
    env['XDG_CACHE_HOME'] = paths.cache;
    env['XDG_CONFIG_HOME'] = paths.config;
    env['XDG_DATA_HOME'] = paths.data;
  }
  // Always sandbox temp directories for safety
  env['TMPDIR'] = paths.tmp;
  env['TMP'] = paths.tmp;
  env['TEMP'] = paths.tmp;

  return env;
}

// ============================================================================
// Main Tool Factory
// ============================================================================

export function createBashTools(workingDir: string): ToolDefinition[] {
  return [
    // Main bash execution tool
    {
      name: 'execute_bash',
      description: 'Execute a bash command. Commands auto-timeout based on type. Use run_in_background: true for servers/watchers.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (smart defaults apply)' },
          run_in_background: { type: 'boolean', description: 'Run in background for long-running processes' },
        },
        required: ['command'],
      },
      handler: async (args) => {
        const command = args['command'] as string;
        const runInBackground = args['run_in_background'] === true;
        const userTimeout = args['timeout'] as number | undefined;
        const timeout = userTimeout ?? getSmartTimeout(command);

        // Check if this is a sudo command
        const isSudoCommand = /^\s*sudo\s+/i.test(command);

        // Block commands that typically require passwords or interactive input
        // (except sudo, which we handle). Match the tool at a COMMAND position —
        // a bare \b match refused innocuous lines like `cat login.txt` or
        // `grep ftp config` as "interactive".
        const interactiveInvoke = commandInvokes(command, ['passwd', 'su', 'login', 'sftp', 'ftp']);
        const interactiveArgs = /(?:^|[\n;&|(])\s*ssh\s(?!-o)/i.test(command)
          || /\bmysql\s+-p/i.test(command)
          || /\bpsql\s+-W\b/i.test(command);
        if (interactiveInvoke || interactiveArgs) {
          return 'Skipped: Command requires interactive authentication. Use non-interactive alternatives.';
        }

        // Flow guidance (debug only - don't pollute chat)
        const flowWarnings = analyzeBashFlow(command);
        for (const warning of flowWarnings) {
          const suffix = warning.suggestion ? ` — ${warning.suggestion}` : '';
          logDebug(`[Bash Flow] ${warning.message}${suffix}`);
        }

        // Safety validation (informational only)
        const validation = validateBashCommand(command);
        if (!validation.valid) {
          logDebug(`[Bash Safety] Command validation failed: ${validation.error?.message || 'Unknown error'}`);
        }

        // Safety warnings (debug only - don't pollute chat)
        if (validation.warnings.length > 0) {
          for (const warning of validation.warnings) {
            logDebug(`[Bash Safety] WARNING: ${warning}`);
          }
        }

        // GUI blocking check
        const guiBlocked = findGuiLauncher(command);
        if (guiBlocked) {
          logDebug(`[Bash Safety] GUI launcher detected: ${guiBlocked}`);
        }

        // Background execution
        if (runInBackground) {
          const shellId = shellManager.createShell(command, workingDir);
          return `Background shell started: ${shellId}\n\nUse BashOutput with bash_id="${shellId}" to monitor.\nUse KillShell with shell_id="${shellId}" to terminate.`;
        }

        // Foreground execution
        const startTime = Date.now();
        // Use the SAME decision buildSandboxEnv uses, so the [sandboxed] /
        // [real credentials] label always matches the actual environment
        // (it ignored ANVILWING_PRESERVE_HOME before and could lie).
        const usesRealHome = resolvesToRealHome({ command });

        // Create test monitor for test commands to enable early abort on failures
        const testMonitor = createTestMonitor(command);
        if (testMonitor) {
          logDebug(`[Bash] Test command detected, enabling failure monitoring with early abort`);
        }

        try {
          const env = await buildSandboxEnv(workingDir, { command });

          // Report sandbox status for visibility
          const sandboxStatus = usesRealHome
            ? `${ANSI_CYAN}🔓 Using real credentials (cloud CLI detected)${ANSI_RESET}`
            : `${ANSI_DIM}🔒 Sandboxed environment${ANSI_RESET}`;
          reportToolProgress({ current: 0, message: sandboxStatus });

          let result: StreamingExecResult;

          // Handle sudo commands with password authentication
          if (isSudoCommand) {
            logDebug('[Bash] Sudo command detected, requesting password');
            reportToolProgress({ current: 0, message: 'Sudo command detected, requesting password…' });

            const password = await getSudoPassword();
            if (!password) {
              return `${ANSI_YELLOW}Sudo command cancelled: No password provided.${ANSI_RESET}\n\nTo run this command, you need to provide your sudo password when prompted.`;
            }

            result = await execSudoWithPassword(command, password, { cwd: workingDir, timeout, env, testMonitor });
          } else {
            result = await execWithStreaming(command, { cwd: workingDir, timeout, env, testMonitor });
          }
          const { stdout, stderr, exitCode, earlyAbort, abortMessage } = result;
          const durationMs = Date.now() - startTime;
          const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');

          // Handle early abort from test monitor - encourage replanning
          if (earlyAbort && testMonitor) {
            const state = testMonitor.getState();
            const suggestions = [
              'REPLAN: Fix the identified issues before running tests again',
              ...state.suggestions,
            ];

            return verifiedFailure(
              `${ANSI_YELLOW_BOLD}Test run aborted early - replan recommended${ANSI_RESET}`,
              `Command: ${command}\n\n${ANSI_YELLOW}The test run was stopped early to save time.${ANSI_RESET}\n\n` +
              `${abortMessage || ''}\n\n` +
              `${ANSI_DIM}Partial output:${ANSI_RESET}\n${combinedOutput || '(none)'}`,
              suggestions,
              [
                { check: 'Early abort', passed: false, details: state.abortReason || 'Multiple test failures' },
                { check: 'Failed tests', passed: false, details: `${state.failedTests.length} test file(s) failed` },
              ],
              durationMs
            );
          }

          const commandLower = command.toLowerCase().trim();
          let patterns = OutputPatterns.command;
          if (commandLower.startsWith('git ') || commandLower === 'git') patterns = OutputPatterns.git;
          else if (commandLower.startsWith('npm ') || commandLower.startsWith('npx ')) patterns = OutputPatterns.npm;

          const analysis = analyzeOutput(combinedOutput, patterns, exitCode);
          const commandCheck = createCommandCheck('Command execution', exitCode, combinedOutput);

          if (exitCode !== 0) {
            const errorFixer = getErrorFixer(workingDir);
            const aiErrors = errorFixer.analyzeOutput(combinedOutput, command);
            const aiGuidance = aiErrors.length > 0 ? errorFixer.formatForAI(aiErrors) : '';
            const suggestions = ['Review the error message', 'Fix the issue and retry'];
            const firstError = aiErrors[0];
            if (firstError?.suggestedFixes[0]) {
              suggestions.unshift(`AI Suggestion: ${firstError.suggestedFixes[0].description}`);
            }

            // Add replan suggestion for test failures
            if (testMonitor && testMonitor.getState().failedTests.length > 0) {
              suggestions.unshift('REPLAN: Multiple test failures detected - consider fixing incrementally');
            }

            return verifiedFailure(
              `Command failed with exit code ${exitCode}`,
              `Command: ${command}\n\nOutput:\n${combinedOutput || '(none)'}${aiGuidance}`,
              suggestions,
              [commandCheck],
              durationMs
            );
          }

          // Exit code 0 means the command succeeded. Don't override that based on
          // loose output substrings ("failed", "ENOENT", "error:") — those appear
          // constantly in legitimate output (grep results, "0 tests failed", a
          // cat'd log, docs) and produced false VERIFIED_FAILUREs. The one genuine
          // exit-0-but-failed case — a test runner that swallows its exit code —
          // is caught explicitly via the test-failure monitor.
          const swallowedTestFailures = testMonitor?.getState().failedTests.length ?? 0;
          if (swallowedTestFailures > 0) {
            return verifiedFailure(
              `Command exited 0 but ${swallowedTestFailures} test file(s) reported failures`,
              `Command: ${command}\n\n${ANSI_RED_BOLD}Output:${ANSI_RESET}\n${combinedOutput || '(no output)'}`,
              ['Review the failing tests', 'Fix the underlying issue and retry'],
              [commandCheck, { check: 'Test failures', passed: false, details: `${swallowedTestFailures} test file(s) failed` }],
              durationMs
            );
          }

          const envLabel = usesRealHome ? `${ANSI_CYAN}[real credentials]${ANSI_RESET}` : `${ANSI_DIM}[sandboxed]${ANSI_RESET}`;
          return verifiedSuccess(
            combinedOutput.trim() ? `Command executed successfully ${envLabel}` : `Command executed successfully (no output) ${envLabel}`,
            `Command: ${command}${combinedOutput.trim() ? `\n\n${ANSI_GREEN_BOLD}Output:${ANSI_RESET}\n${combinedOutput}` : ''}`,
            [commandCheck, ...(analysis.isSuccess ? [{ check: 'Output analysis', passed: true, details: `Success pattern matched` }] : [])],
            durationMs
          );
        } catch (error: unknown) {
          const execError = error as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
          const durationMs = Date.now() - startTime;
          const exitCode = execError.code ?? 1;
          const combinedError = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n');

          if (execError.killed) {
            return verifiedFailure(
              `Command timed out after ${timeout}ms`,
              `Command: ${command}\n\nPartial output:\n${combinedError || '(none)'}`,
              ['Increase timeout if command legitimately needs more time', 'Check if command is hanging'],
              [{ check: 'Timeout', passed: false, details: `Exceeded ${timeout}ms` }],
              durationMs
            );
          }

          const errorFixer = getErrorFixer(workingDir);
          const aiErrors = errorFixer.analyzeOutput(combinedError, command);
          const aiGuidance = aiErrors.length > 0 ? errorFixer.formatForAI(aiErrors) : '';
          const suggestions = ['Review the error message', 'Fix the issue and retry'];
          const firstError = aiErrors[0];
          if (firstError?.suggestedFixes[0]) {
            suggestions.unshift(`AI Suggestion: ${firstError.suggestedFixes[0].description}`);
          }

          return verifiedFailure(
            `Command failed with exit code ${exitCode}`,
            `Command: ${command}\n\nError output:\n${combinedError || '(none)'}${aiGuidance}`,
            suggestions,
            [createCommandCheck('Command execution', exitCode, combinedError)],
            durationMs
          );
        }
      },
    },

    // Background shell output retrieval
    {
      name: 'BashOutput',
      description: 'Retrieve output from a running or completed background bash shell.',
      parameters: {
        type: 'object',
        properties: {
          bash_id: { type: 'string', description: 'The ID of the background shell' },
          filter: { type: 'string', description: 'Optional regex to filter output lines' },
        },
        required: ['bash_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const bashId = args['bash_id'];
        const filterStr = args['filter'];

        if (typeof bashId !== 'string' || !bashId.trim()) {
          return 'Error: bash_id must be a non-empty string.';
        }

        try {
          const shell = shellManager.getShell(bashId);
          if (!shell) {
            const available = shellManager.listShells();
            return `Error: Shell "${bashId}" not found.\n\nAvailable: ${available.length > 0 ? available.join(', ') : 'none'}`;
          }

          const filter = filterStr && typeof filterStr === 'string' ? new RegExp(filterStr) : undefined;
          const { stdout, stderr, status } = shell.getNewOutput(filter);

          const parts: string[] = [`Shell: ${bashId}`, `Status: ${status}`];
          if (stdout) { parts.push('\n=== New Output ==='); parts.push(stdout); }
          if (stderr) { parts.push('\n=== Errors ==='); parts.push(stderr); }
          if (!stdout && !stderr) parts.push('\n(No new output)');

          return parts.join('\n');
        } catch (error: unknown) {
          return buildError('retrieving shell output', error, { bash_id: bashId });
        }
      },
    },

    // Kill background shell
    {
      name: 'KillShell',
      description: 'Kill a running background bash shell by its ID.',
      parameters: {
        type: 'object',
        properties: {
          shell_id: { type: 'string', description: 'The ID of the background shell to kill' },
        },
        required: ['shell_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const shellId = args['shell_id'];

        if (typeof shellId !== 'string' || !shellId.trim()) {
          return 'Error: shell_id must be a non-empty string.';
        }

        try {
          const success = shellManager.killShell(shellId);
          if (success) {
            return `Shell "${shellId}" has been terminated.`;
          } else {
            const available = shellManager.listShells();
            return `Error: Shell "${shellId}" not found.\n\nAvailable: ${available.length > 0 ? available.join(', ') : 'none'}`;
          }
        } catch (error: unknown) {
          return buildError('killing shell', error, { shell_id: shellId });
        }
      },
    },
  ];
}
