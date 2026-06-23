/**
 * Interactive Shell - Full interactive CLI experience with rich UI.
 *
 * Usage:
 *   agi                    # Start interactive shell
 *   agi "initial prompt"   # Start with initial prompt
 *
 * Features:
 * - Rich terminal UI with status bar
 * - Command history
 * - Streaming responses
 * - Tool execution display
 * - Ctrl+C to interrupt
 */

import { stdin, stdout, exit } from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec as childExec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getHITL, hitlEvents, setDecisionPresenter, type DecisionRequest, type DecisionChoice } from '../core/hitl.js';
import { formatErrorForDisplay } from '../core/errorDisplay.js';
// Connector imports removed — CLI is local-only, no GitHub gate.

// Stub functions (antiTermination removed)
const initializeProtection = (_config?: unknown) => {};
const enterCriticalSection = (_name?: string) => {};
const exitCriticalSection = (_name?: string) => {};

// Import real shutdown handler for reliable Ctrl+C handling
import { authorizedShutdown, installSignalHandlers, onShutdown, isShutdownInProgress } from '../core/shutdown.js';

import type { ProfileName, ResolvedProfileConfig } from '../config.js';
import { resolveProfileConfig } from '../config.js';
import { createAgentController, type AgentController } from '../runtime/agentController.js';
import { expandFileMentions, listWorkspaceFiles } from '../core/fileMentions.js';
import { resolveWorkspaceCaptureOptions, buildWorkspaceContext } from '../workspace.js';
import { loadAllSecrets, listSecretDefinitions, setSecretValue, getSecretValue, getSecretDefinition, classifyKeyEntry, type SecretName } from '../core/secretStore.js';
import { resolveKeyMode, keyModeLine } from '../core/keyResolution.js';
import { appendMemoryNote } from '../tools/memoryTools.js';
import { recordAnvilwingUsage, getUsage, TAVILY_MONTHLY_FREE, TAVILY_ONE_TIME_BONUS } from '../core/usage.js';
import { TurnTokenMeter } from '../core/turnTokenMeter.js';
import { type MenuItem } from '../ui/ink/InkPromptController.js';
import { listSessions, loadSessionById, saveSessionSnapshot } from '../core/sessionStore.js';
import { relativeTime } from '../core/relativeTime.js';
import { getModelContextInfo } from '../core/contextWindow.js';
import { computeContextUsage, formatTokenCount } from '../core/contextUsage.js';
import { getChangedFiles, revertAllChanges, hasChangesToRevert } from '../tools/fileChangeTracker.js';
import { renderChangePanel, type ChangeItem } from '../core/diffPanel.js';
import { rewindPreviewLines, rewindResultLine, type RewindItem } from '../core/rewind.js';
import { formatCompactionNote } from '../core/compactionNote.js';
import { formatSubAgentStart, formatSubAgentComplete } from '../core/subAgentNote.js';
import { getConfiguredProviders, getProvidersStatus, quickCheckProviders, getCachedDiscoveredModels, sortModelsByPriority, type QuickProviderStatus, type ProviderInfo } from '../core/modelDiscovery.js';
import type { ModelConfig } from '../core/agentSchemaLoader.js';
import { saveModelPreference, loadFeatureFlags, toggleFeatureFlag } from '../core/preferences.js';
import { setDebugMode, debugSnippet, logDebug } from '../utils/debugLogger.js';
import type { AgentEventUnion } from '../contracts/v1/agent.js';
import type { ProviderId } from '../core/types.js';

const exec = promisify(childExec);
import { ensureNextSteps } from '../core/finalResponseFormatter.js';
import { getTaskCompletionDetector, detectFailingTestOrBuild } from '../core/taskCompletionDetector.js';
import { TurnGovernor, pendingTodos, nextTodoPrompt } from '../core/turnGovernor.js';
import { autoContinueAllowed } from '../core/permissionMode.js';
import { FailureRegistry } from '../core/failureRegistry.js';
import { buildAdversarialCorrectionPrompt, MAX_ADVERSARIAL_CORRECTIONS } from '../core/adversarialCorrection.js';
import { getCurrentTodos, clearCurrentTodos } from '../tools/todoTools.js';
import { checkForUpdates, formatUpdateNotification, hasPendingSession, loadSessionState, clearSessionState, performBackgroundUpdate, type UpdateInfo } from '../core/updateChecker.js';
import { theme } from '../ui/theme.js';
import { startNewRun } from '../tools/fileChangeTracker.js';
import { onSudoPasswordNeeded, offSudoPasswordNeeded, provideSudoPassword } from '../core/sudoPasswordManager.js';
import { reportStatus, setStatusSink } from '../utils/statusReporter.js';
import { isSafetyRefusal } from '../core/refusalDetection.js';
import { wasRepetitionStopped, detectRepetitionLoop } from '../core/repetitionGuard.js';
import { shouldSynthesizeFromReasoning } from '../core/reasoningFallback.js';
import { formatToolCall, toolActivityLabel, formatToolResult, formatToolError } from '../shell/toolPresentation.js';

// Tool-result display (ANSI stripping, summarisation, the `⎿` block) now lives
// in ../shell/toolPresentation.ts — the shell just emits the formatted strings.

// Timeout constants for regular prompt processing (reasoning models like Anvilwing)
const PROMPT_REASONING_TIMEOUT_MS = 60 * 1000; // 60 seconds max for reasoning-only without action
// Per-step timeout: how long we'll wait for the *next* event before
// declaring the stream stuck and bailing out. Set generously (10 min) so
// long-running tool calls (a build, a slow `npm install`, etc.) don't
// trip it, but short enough that a dead provider / network drop doesn't
// leave the user staring at a forever-spinner with Ctrl+C as their only
// escape. iterateWithTimeout resets this per-event, so it only fires on
// genuine inactivity. Override with ANVILWING_STEP_TIMEOUT_MS for tests.
const PROMPT_STEP_TIMEOUT_MS = (() => {
  const env = process.env['ANVILWING_STEP_TIMEOUT_MS'];
  const parsed = env ? Number(env) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 10 * 60 * 1000;
})();
const HITL_TOOL_PREFIX = 'HITL_';

const isHitlToolName = (toolName: string): boolean => toolName.startsWith(HITL_TOOL_PREFIX);

/**
 * Iterate over an async iterator with a timeout per iteration.
 * If no event is received within the timeout, yields a special timeout marker.
 * Emits timeout markers without aborting the underlying iterator.
 * Pass Infinity to disable timeouts entirely.
 */
async function* iterateWithTimeout<T>(
  iterator: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: () => void
): AsyncGenerator<T | { __timeout: true }> {
  const asyncIterator = iterator[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<T>> | null = null;
  let done = false;

  // If timeout is Infinity or not a positive finite number, disable timeout entirely
  const timeoutDisabled = !Number.isFinite(timeoutMs) || timeoutMs <= 0;

  try {
    while (true) {
      if (!pending) {
        pending = asyncIterator.next();
      }

      let result: IteratorResult<T> | { __timeout: true };

      if (timeoutDisabled) {
        // No timeout - just wait for the next value
        result = await pending;
      } else {
        // Race between pending result and timeout. The timer MUST be cleared
        // once the race settles: Promise.race does not cancel losers, so the
        // old discarded timer id left one live 10-minute timer PER CONSUMED
        // EVENT — tens of thousands of armed timers (and ~15MB of pinned
        // closures) per fast-streaming turn, holding the event loop open.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<{ __timeout: true }>((resolve) => {
          timeoutId = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
        });
        try {
          result = await Promise.race([pending, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId);
        }
      }

      if ('__timeout' in result) {
        onTimeout?.();
        yield result;
        continue;
      }

      pending = null;
      if (result.done) {
        done = true;
        return;
      }

      yield result.value;
    }
  } finally {
    if (!done && typeof asyncIterator.return === 'function') {
      try {
        await asyncIterator.return(undefined);
      } catch {
        // Ignore return errors
      }
    }
  }
}

let cachedVersion: string | null = null;

// Get version from package.json
function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = resolve(dirname(__filename), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    cachedVersion = pkg.version || '0.0.0';
    return cachedVersion!;
  } catch {
    return '0.0.0';
  }
}


export interface InteractiveShellOptions {
  argv: string[];
}

export interface WelcomeLineInput {
  hasApiKey: boolean;
  maskedKey: string;
  model: string;
  provider: string;
  updateLines?: string[];
  cwd?: string;
  /** Active key source. Defaults from hasApiKey. */
  keyMode?: 'own' | 'none';
  /** Dim status line for the active key source. */
  keyModeLine?: string | null;
  /** Display version (e.g. "v1.1.63"), shown in the welcome title. */
  version?: string;
}

/** Inner content of the welcome box (plain, no border/colour). */
function welcomeBodyLines(input: WelcomeLineInput): string[] {
  const title = input.version ? `✻ Welcome to Anvilwing Coder ${input.version}` : '✻ Welcome to Anvilwing Coder';
  const body: string[] = [title, ''];
  const mode = input.keyMode ?? (input.hasApiKey ? 'own' : 'none');
  if (mode === 'own') {
    // §7 shape: model + /help, then cwd. No provider chip (redundant with
    // the model name) and no key material in chrome — Claude Code never
    // surfaces credentials in the banner; /keys still shows the masked key.
    body.push(`${input.model} · /help for commands`);
  } else {
    body.push(
      '⚠ No Anvilwing API key configured',
      '',
      '  /key sk-…    Anvilwing (required)',
      '  /key tvly-…  Tavily web search (optional) · tavily.com',
    );
  }
  if (input.cwd) body.push(`cwd: ${input.cwd}`);
  return body;
}

/**
 * Wrap content lines in a Claude-Code-style rounded box (╭╮╰╯). `paint`
 * colours an already-padded content cell; `border` colours the frame. Both
 * default to identity so the pure version stays ANSI-free.
 */
function roundedBox(
  content: string[],
  paint: (cell: string) => string = (s) => s,
  border: (s: string) => string = (s) => s,
): string[] {
  const width = Math.min(content.reduce((m, c) => Math.max(m, c.length), 0), 72);
  const pad = (c: string) => c + ' '.repeat(Math.max(0, width - c.length));
  const rule = '─'.repeat(width + 2);
  return [
    border(`╭${rule}╮`),
    ...content.map((c) => `${border('│')} ${paint(pad(c))} ${border('│')}`),
    border(`╰${rule}╯`),
  ];
}

/**
 * Compose the lines shown when the interactive shell opens. Deliberately NOT a
 * marketing splash — bare `anvilwing` opens straight into the chat (like
 * `claude`); this is the load-bearing welcome: a sparkle, the name, and either
 * how to set a key or the active model + masked key, inside a rounded box that
 * mirrors Claude Code's. Pure (no chalk/ANSI, no I/O) so the "no marketing
 * splash, key guidance kept" contract is unit-testable without a PTY. The live
 * renderer colourises equivalent content; this is the source of truth for
 * WHICH lines appear.
 */
export function composeWelcomeLines(input: WelcomeLineInput): string[] {
  // No trailing blank: ChatStatic already adds the §1 one-line gap before the
  // next block — a built-in trailing blank made it a double gap.
  return ['', ...(input.updateLines ?? []), ...roundedBox(welcomeBodyLines(input))];
}

/**
 * Run the fully interactive shell with rich UI.
 */
export async function runInteractiveShell(options: InteractiveShellOptions): Promise<void> {
  // Install signal handlers FIRST for reliable Ctrl+C handling
  installSignalHandlers();

  // Initialize protection systems
  initializeProtection({
    interceptSignals: true,
    monitorResources: true,
    armorExceptions: true,
    enableWatchdog: true,
    verbose: process.env['ANVILWING_DEBUG'] === '1',
  });

  // The CLI is interactive-only. There is no piped / one-shot / headless
  // mode — every session runs through the Ink renderer against a live
  // terminal. If stdin or stdout isn't a TTY, fail fast with a clear
  // message rather than emitting unrenderable escape sequences into a
  // pipe.
  if (!stdin.isTTY || !stdout.isTTY) {
    reportStatus('anvilwing requires an interactive terminal. Run it directly in a TTY (no pipes, no shell redirection).');
    exit(1);
  }

  loadAllSecrets();

  // argv intentionally unused — the bin is shell-only. Any tokens after
  // `anvilwing` are ignored on purpose; configuration lives in /secrets,
  // /model, /auto, etc. The options.argv field stays only because tests
  // pass it; it does not affect runtime.
  void options;
  const profile = resolveProfile();
  const workingDir = process.cwd();

  const workspaceOptions = resolveWorkspaceCaptureOptions(process.env);
  const workspaceContext = buildWorkspaceContext(workingDir, workspaceOptions);

  // Resolve profile config for model info
  const profileConfig = resolveProfileConfig(profile, workspaceContext);

  // Create agent controller
  const controller = await createAgentController({
    profile,
    workingDir,
    workspaceContext,
    env: process.env,
  });

  // Create the interactive shell instance
  const shell = new InteractiveShell(controller, profile, profileConfig, workingDir);

  await shell.run();
}

class InteractiveShell {
  private controller: AgentController;
  private readonly profile: ProfileName;
  private profileConfig: ResolvedProfileConfig;
  private readonly workingDir: string;
  // The shell holds an `IPromptController`-shaped value. The CLI has a
  // single renderer — Ink, via InkPromptController. `any` here keeps
  // existing call signatures unchanged; the interface declares the
  // same surface but TS would otherwise insist we touch every call
  // site to declare nullability.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private promptController: any = null;
  private isProcessing = false;
  // Full result + tool of the last tool-result that was TRUNCATED for display,
  // so Ctrl+O can expand it (null when the last result fit, or none yet).
  private lastExpandableResult: { name: string; result: string; params?: Record<string, unknown> } | null = null;
  // Newer npm version detected at startup (null if up to date / unchecked).
  private pendingUpdate: UpdateInfo | null = null;
  private shouldExit = false;
  private pendingPrompts: string[] = [];
  private debugEnabled = false;
  // Stable id for THIS run's persisted session, so each autosave updates the
  // same snapshot in place. Assigned from the first saveSessionSnapshot; set
  // to a resumed session's id after /resume so the restored thread continues.
  private sessionId: string | null = null;
  // Real input-token count from the provider's last response (= tokens
  // currently occupying the context window). Drives the accurate "% context
  // left" chrome indicator and the /context view.
  private lastInputTokens: number | null = null;
  // Live `↑ N tokens` source: estimates from streamed chars, snaps to the
  // provider-exact count on each usage event; resets per user turn.
  private readonly turnTokenMeter = new TurnTokenMeter();
  private ctrlCCount = 0;
  private lastCtrlCTime = 0;
  // Set when the user Ctrl+C interrupts a run; suppresses the auto-continue
  // re-launch in the finally block of processPrompt so the agent doesn't
  // immediately resume the work the user just cancelled. Cleared when the
  // user submits a fresh prompt.
  private userInterruptedRun = false;
  private cachedProviders: QuickProviderStatus[] | null = null;
  private secretInputMode: { active: boolean; secretId: SecretName | null; queue: SecretName[] } = {
    active: false,
    secretId: null,
    queue: [],
  };
  private pendingModelSwitch: { provider: ProviderId; model: string | null } | null = null;
  private currentResponseBuffer = '';
  // What this turn already rendered as an 'error' — dedupes the event-vs-
  // rejection double print of the same provider failure.
  private lastShownTurnError: string | null = null;
  // One-time per session: real prompt_tokens exceeded the configured window.
  private warnedWindowDrift = false;
  // The turn's final assistant text, captured BEFORE currentResponseBuffer is
  // cleared on message.complete. The auto-continue refusal/completion/governor
  // reads run in the `finally`, AFTER that clear, so reading the buffer there saw
  // '' and blinded them (completion detection + safety-refusal both need the
  // text). This mirrors the buffer's content but is never cleared mid-turn.
  private finalResponseText = '';
  // Store original prompt for auto-continuation
  private originalPromptForAutoContinue: string | null = null;
  // (Pinned prompt removed per request — field intentionally absent.)
  // Bounds + stall-detects the auto-continue loop per user request, and drives
  // continuation from the live TODO plan (see src/core/turnGovernor.ts). Reset
  // when a fresh user prompt arrives.
  private autoGovernor = new TurnGovernor();
  // Remembers recurring error signatures across auto-continue turns so the
  // agent stops re-trying the same dead end (see src/core/failureRegistry.ts).
  private failureRegistry = new FailureRegistry();
  // Adversarial auto-correction: how many bounded re-fixes the reviewer has
  // triggered for the CURRENT user request (capped). Reset on a fresh prompt;
  // the findings themselves are a per-turn local in processPrompt.
  private adversarialCorrectionCount = 0;

  constructor(controller: AgentController, profile: ProfileName, profileConfig: ResolvedProfileConfig, workingDir: string) {
    this.controller = controller;
    this.profile = profile;
    this.profileConfig = profileConfig;
    this.workingDir = workingDir;

    // Pre-fetch provider status in background
    void this.fetchProviders();
  }

  private async fetchProviders(): Promise<void> {
    try {
      this.cachedProviders = await quickCheckProviders();
    } catch {
      this.cachedProviders = [];
    }
  }

  private validateRequiredApiKeys(): void {
    const missingKeys: SecretName[] = [];

    // Check Anvilwing API key (required)
    if (!getSecretValue('ANVILWING_API_KEY')) {
      missingKeys.push('ANVILWING_API_KEY');
    }

    // Prompt for missing keys directly without showing warning
    if (missingKeys.length > 0 && this.promptController) {
      // Queue all missing keys for input
      this.secretInputMode.queue = missingKeys.slice(1); // Rest of the keys
      const first = missingKeys[0];
      if (first) {
        // Set secret mode immediately to mask input
        this.secretInputMode.active = true;
        this.secretInputMode.secretId = first;
        this.promptController.setSecretMode(true);

        // Show the inline panel with instructions
        const secrets = listSecretDefinitions();
        const secret = secrets.find(s => s.id === first);
        if (secret && this.promptController.supportsInlinePanel()) {
          const lines = [
            chalk.bold.hex('#e8e9ed')(`Set ${secret.label}`),
            chalk.dim(secret.description),
            '',
            chalk.dim('Enter value (or press Enter to skip)'),
          ];
          this.promptController.setInlinePanel(lines);
          this.promptController.setStatusMessage(`Enter ${secret.label}...`);
        }
      }
    }
  }

  queuePrompt(prompt: string): void {
    this.pendingPrompts.push(prompt);
  }

  async run(): Promise<void> {
    // createPromptController returns the Ink-backed controller
    // (src/ui/ink/InkPromptController.ts) — the only renderer. The
    // dynamic import keeps React/Ink off the cold-start path until
    // the interactive shell actually starts.
    const { createPromptController } = await import('../ui/ink/InkPromptController.js');
    this.promptController = await createPromptController(
      stdin as NodeJS.ReadStream,
      stdout as NodeJS.WriteStream,
      {
        onSubmit: (text: string) => this.handleSubmit(text),
        onQueue: (text: string) => this.queuePrompt(text),
        onInterrupt: () => this.handleInterrupt(),
        onExit: () => this.handleExit(),
        onCtrlC: (info: { hadBuffer: boolean }) => this.handleCtrlC(info),
        onToggleAutoContinue: () => this.handleAutoContinueToggle(),
        onToggleHITL: () => this.handleHITLToggle(),
        onCyclePermissionMode: (mode: string) => this.handlePermissionModeChange(mode),
        onExpandToolResult: () => this.handleExpandToolResult(),
        // Esc interrupts a running turn (handleInterrupt no-ops when idle), so
        // the spinner's "esc to interrupt" is real. Ctrl+C still works too.
        onEscape: () => this.handleInterrupt(),
        onShowShortcuts: () => this.showKeyboardShortcuts(),
        onShowToggles: () => this.showTogglesMenu(),
        onDismissPanel: () => this.dismissInlinePanel(),
      }
    );

    // Register cleanup callback for graceful shutdown
    onShutdown(() => {
      this.shouldExit = true;
      this.promptController?.stop();
      setStatusSink(null);
    });

    setStatusSink((message) => this.promptController?.setStatusMessage(message));

    // Hand the terminal off to the HITL prompt while it's open: suspend
    // prompt rendering and detach our keypress handler so arrow keys aren't
    // double-consumed. Restore both when the prompt closes so the next turn's
    // input works correctly.
    const onHitlOpen = () => {
      const r = this.promptController?.getRenderer();
      if (!r) return;
      try { r.suspendPromptRendering(); } catch { /* ignore */ }
      try { r.suspendInputCapture(); } catch { /* ignore */ }
    };
    const onHitlClose = () => {
      const r = this.promptController?.getRenderer();
      if (!r) return;
      try { r.resumeInputCapture(); } catch { /* ignore */ }
      try { r.resumePromptRendering(true); } catch { /* ignore */ }
    };
    hitlEvents.on('prompt-open', onHitlOpen);
    hitlEvents.on('prompt-close', onHitlClose);
    onShutdown(() => {
      hitlEvents.removeListener('prompt-open', onHitlOpen);
      hitlEvents.removeListener('prompt-close', onHitlClose);
    });

    // Render HITL decisions through the in-app menu (below the prompt, same
    // arrow+Enter UX as the slash palette) instead of the screen-clearing
    // raw-mode fallback. The above suspend wiring is bypassed for this path —
    // Ink's own input routing owns the menu, so the terminal is never handed off.
    setDecisionPresenter((request) => this.presentHitlDecision(request));
    onShutdown(() => setDecisionPresenter(null));

    // Start the UI
    this.promptController.start();
    this.applyDebugState(this.debugEnabled);

    // Build the @-mention completion file list (bounded walk; new files appear
    // on the next launch). Best-effort — a scan failure must not block the UI.
    try {
      this.promptController.setCompletionFiles(listWorkspaceFiles(this.workingDir));
    } catch { /* ignore — completion is a convenience */ }

    // Set up sudo password prompt handler
    this.setupSudoPasswordHandler();

    // Set initial status
    this.promptController.setChromeMeta({
      directory: this.workingDir,
    });

    // Show welcome message
    await this.showWelcome();

    // Pinned prompt loading removed — feature stripped per request.

    // TEST SEAM (guarded; never active unless ANVILWING_TEST_FORCE_BUSY_MS + SKIP_AUTH):
    // Lets PTY E2E harness drive the exact live follow-up queue paths
    // (handleSubmit during isProcessing, transient queued UI, drain) with
    // real binary + real keystrokes, no LLM key or network required.
    const forceBusyMs = Number(process.env['ANVILWING_TEST_FORCE_BUSY_MS'] || '0');
    if (forceBusyMs > 0) {
      this.isProcessing = true;
      this.promptController?.setStreaming(true);
      this.promptController?.setActivityMessage('TEST BUSY (seam for queue E2E)');
      setTimeout(() => {
        this.isProcessing = false;
        this.promptController?.setStreaming(false);
        this.promptController?.setActivityMessage(null);
        this.promptController?.forceRender();
        // Explicitly drain here (exercises the real drain + processPrompt path
        // even though the fake "run" had no controller.send). Pending items
        // will hit the normal early guard + error path, but the queue/dequeue
        // logic itself runs for the test assertions.
        void this.drainNextQueuedPrompt().catch(() => {});
      }, forceBusyMs);
    }

    // Process any queued prompts
    if (this.pendingPrompts.length > 0) {
      const prompts = this.pendingPrompts.splice(0);
      for (const prompt of prompts) {
        await this.processPrompt(prompt);
      }
    }

    // Keep running until exit
    await this.waitForExit();
  }

  private async showWelcome(): Promise<void> {
    const renderer = this.promptController?.getRenderer();
    if (!renderer) return;

    const version = getVersion();

    // Append to existing terminal history — do not clear scrollback.

    // Check if Anvilwing API key is set
    const apiKey = process.env.ANVILWING_API_KEY?.trim() || '';
    const hasApiKey = apiKey.length > 0;

    // Mask API key: show first 4 and last 4 chars
    const maskApiKey = (key: string): string => {
      if (key.length <= 12) return key.slice(0, 3) + '...' + key.slice(-3);
      return key.slice(0, 6) + '...' + key.slice(-4);
    };

    // Update check: NEVER gates the banner. The old order awaited an
    // `npm view` subprocess (a full network round trip, up to the 2s cap, on
    // EVERY launch) before the welcome box — and before any queued startup
    // prompt — rendered. Now the banner renders immediately and the update
    // offer arrives as a follow-up system line when the check resolves.
    void checkForUpdates(version).then((updateInfo) => {
      if (!updateInfo?.updateAvailable || this.shouldExit) return;
      // Detect + OFFER (don't force) — the user applies it in-shell with
      // /update. Auto-installing on every startup ran `npm i -g` without
      // consent and could fail silently; making it user-initiated is clearer.
      this.pendingUpdate = updateInfo;
      this.promptController?.getRenderer()?.addEvent('system',
        chalk.cyan('⬆ ') +
        chalk.dim('Update available: ') +
        chalk.yellow(`v${updateInfo.current}`) +
        chalk.dim(' → ') +
        chalk.green(`v${updateInfo.latest}`) +
        chalk.dim(' · type ') + chalk.hex('#ffd666')('/update') + chalk.dim(' to upgrade'),
      );
    }).catch(() => { /* update check is best-effort */ });

    // Clean, minimal welcome — a sparkle + the essentials in a rounded box,
    // mirroring Claude Code. The pure composeWelcomeLines() is the contract for
    // WHICH lines appear; here we draw the same box with brand colour.
    const ember = chalk.hex('#ff9f43');
    const wire = chalk.hex('#30303a');
    const keyStatus = resolveKeyMode();
    const body = welcomeBodyLines({
      hasApiKey,
      maskedKey: hasApiKey ? maskApiKey(apiKey) : '',
      model: this.profileConfig.model,
      provider: this.profileConfig.provider,
      cwd: this.workingDir,
      keyMode: keyStatus.mode,
      keyModeLine: keyModeLine(keyStatus),
      version: `v${version}`,
    });
    const boxed = roundedBox(body, (cell) => cell.replace('✻', ember('✻')), (s) => wire(s));
    // No leading/trailing '' sentinels: the banner string used to embed its
    // own blank lines AND ChatStatic adds marginTop on the next block — a
    // double-blank gap (§1 violation) around every banner.
    const welcomeContent = boxed.join('\n');

    // Use renderer event system instead of direct stdout writes
    renderer.addEvent('banner', welcomeContent);

    // Update renderer meta with model info
    this.promptController?.setModelContext({
      model: this.profileConfig.model,
      provider: this.profileConfig.provider,
    });
  }

  /**
   * Kick off `npm install -g <pkg>@latest` in a background process. When it
   * completes, surface a renderer event so the user sees the result without
   * any blocking. The running CLI keeps the old code — the new version is
   * picked up on next launch.
   */
  /**
   * /update — re-check npm for a newer version (so it works on demand, not
   * just from the startup notice) and, if one exists, upgrade in-shell. The
   * install runs in the background and the new version takes effect on the
   * next launch (a running Node process can't hot-swap its own global pkg).
   */
  private async handleUpdateCommand(): Promise<void> {
    const renderer = this.promptController?.getRenderer();
    this.promptController?.setStatusMessage('Checking npm for updates…');
    const info = await checkForUpdates(getVersion(), true).catch(() => null); // force a fresh check
    this.promptController?.setStatusMessage(null);
    if (!info) {
      renderer?.addEvent('system', chalk.dim('Could not reach npm to check for updates. Try again, or run: npm i -g anvilwing@latest'));
      return;
    }
    if (!info.updateAvailable) {
      renderer?.addEvent('system', chalk.dim(`You're on the latest version (v${info.current}).`));
      this.pendingUpdate = null;
      return;
    }
    renderer?.addEvent('system',
      chalk.cyan('⬆ ') + chalk.dim('Updating ') + chalk.yellow(`v${info.current}`) +
      chalk.dim(' → ') + chalk.green(`v${info.latest}`) + chalk.dim('…'),
    );
    this.pendingUpdate = null;
    this.runBackgroundUpdate(info);
  }

  private runBackgroundUpdate(info: UpdateInfo): void {
    const renderer = this.promptController?.getRenderer();
    void performBackgroundUpdate(info, (msg) => {
      try { renderer?.addEvent('system', msg); } catch { /* ignore */ }
    }).then((res) => {
      if (!res.started) return;
      try {
        renderer?.addEvent('system',
          chalk.green(`✓ Update installer launched for v${info.latest}. `) +
          chalk.dim('Exit and reopen the CLI to use the new version.'),
        );
      } catch { /* ignore */ }
    }).catch(() => { /* best-effort */ });
  }

  /**
   * Set up handler for sudo password prompts from bash tool execution.
   * When a sudo command needs a password, this prompts the user securely.
   */
  private sudoPasswordHandler: (() => void) | null = null;

  private setupSudoPasswordHandler(): void {
    this.sudoPasswordHandler = async () => {
      const renderer = this.promptController?.getRenderer();
      if (!renderer) {
        provideSudoPassword(null);
        return;
      }

      try {
        // Show password prompt
        renderer.addEvent('system', chalk.yellow('Sudo password required'));
        renderer.setSecretMode(true);
        renderer.clearBuffer();

        // Capture password input
        const password = await renderer.captureInput({ allowEmpty: false, trim: true, resetBuffer: true });

        // Hide password mode
        renderer.setSecretMode(false);

        if (password) {
          provideSudoPassword(password);
          renderer.addEvent('system', chalk.green('✓ Password provided'));
        } else {
          provideSudoPassword(null);
          renderer.addEvent('system', chalk.yellow('Sudo cancelled'));
        }
      } catch (error) {
        renderer.setSecretMode(false);
        provideSudoPassword(null);
        reportStatus('Password prompt cancelled');
      }
    };

    onSudoPasswordNeeded(this.sudoPasswordHandler);
  }

  private cleanupSudoPasswordHandler(): void {
    if (this.sudoPasswordHandler) {
      offSudoPasswordNeeded(this.sudoPasswordHandler);
      this.sudoPasswordHandler = null;
    }
  }

  private applyDebugState(enabled: boolean, statusMessage?: string): void {
    this.debugEnabled = enabled;
    setDebugMode(enabled);
    this.promptController?.setDebugMode(enabled);
    // Show transient status message instead of chat banner
    if (statusMessage) {
      this.promptController?.setStatusMessage(statusMessage);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
    }
  }

  private describeEventForDebug(event: AgentEventUnion): string {
    switch (event.type) {
      case 'message.start':
        return 'message.start';
      case 'message.delta': {
        const snippet = debugSnippet(event.content);
        return snippet ? `message.delta → ${snippet}` : 'message.delta (empty)';
      }
      case 'message.complete': {
        const snippet = debugSnippet(event.content);
        return snippet
          ? `message.complete → ${snippet} (${event.elapsedMs}ms)`
          : `message.complete (${event.elapsedMs}ms)`;
      }
      case 'tool.start':
        return `tool.start ${event.toolName}`;
      case 'tool.complete': {
        const snippet = debugSnippet(event.result);
        return snippet
          ? `tool.complete ${event.toolName} → ${snippet}`
          : `tool.complete ${event.toolName}`;
      }
      case 'tool.error':
        return `tool.error ${event.toolName} → ${event.error}`;
      case 'edit.explanation': {
        const snippet = debugSnippet(event.content);
        return snippet ? `edit.explanation → ${snippet}` : 'edit.explanation';
      }
      case 'error':
        return `error → ${event.error}`;
      case 'usage': {
        const parts = [];
        if (event.inputTokens != null) parts.push(`in:${event.inputTokens}`);
        if (event.outputTokens != null) parts.push(`out:${event.outputTokens}`);
        if (event.totalTokens != null) parts.push(`total:${event.totalTokens}`);
        return `usage ${parts.length ? parts.join(', ') : '(no tokens)'}`;
      }
      default:
        return event.type;
    }
  }

  private handleDebugCommand(arg?: string): boolean {
    const normalized = arg?.toLowerCase();

    // /debug alone - toggle
    if (!normalized) {
      const targetState = !this.debugEnabled;
      this.applyDebugState(targetState, `Debug ${targetState ? 'on' : 'off'}`);
      return true;
    }

    // /debug status - show current state
    if (normalized === 'status') {
      this.promptController?.setStatusMessage(`Debug is ${this.debugEnabled ? 'on' : 'off'}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return true;
    }

    // /debug on|enable
    if (normalized === 'on' || normalized === 'enable') {
      if (this.debugEnabled) {
        this.promptController?.setStatusMessage('Debug already on');
        setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        return true;
      }
      this.applyDebugState(true, 'Debug on');
      return true;
    }

    // /debug off|disable
    if (normalized === 'off' || normalized === 'disable') {
      if (!this.debugEnabled) {
        this.promptController?.setStatusMessage('Debug already off');
        setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        return true;
      }
      this.applyDebugState(false, 'Debug off');
      return true;
    }

    // Invalid argument
    this.promptController?.setStatusMessage(`Invalid: /debug ${arg}. Use on|off|status`);
    setTimeout(() => this.promptController?.setStatusMessage(null), 2500);
    return true;
  }


  /**
   * Synthesize a user-facing response from reasoning content when the model
   * provides reasoning but no actual response (common with anvilwing).
   * Extracts key conclusions and formats them as a concise response.
   */
  private synthesizeFromReasoning(reasoning: string): string | null {
    if (!reasoning || reasoning.trim().length < 50) {
      return null;
    }

    // Filter out internal meta-reasoning patterns that shouldn't be shown to user
    const metaPatterns = [
      /according to the rules?:?/gi,
      /let me (?:use|search|look|check|find|think|analyze)/gi,
      /I (?:should|need to|will|can|must) (?:use|search|look|check|find)/gi,
      /⚡\s*Executing\.*/gi,
      /use web\s?search/gi,
      /for (?:non-)?coding (?:questions|tasks)/gi,
      /answer (?:directly )?from knowledge/gi,
      /this is a (?:general knowledge|coding|security)/gi,
      /the user (?:is asking|wants|might be)/gi,
      /however,? (?:the user|I|we)/gi,
      /(?:first|next),? (?:I should|let me|I need)/gi,
    ];

    let filtered = reasoning;
    for (const pattern of metaPatterns) {
      filtered = filtered.replace(pattern, '');
    }

    // Split into sentences
    const sentences = filtered
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 20 && !/^[•\-–—*]/.test(s)); // Skip bullets and short fragments

    if (sentences.length === 0) {
      return null;
    }

    // Look for actual content (not process descriptions)
    const contentPatterns = [
      /(?:refers? to|involves?|relates? to|is about|concerns?)/i,
      /(?:scandal|deal|agreement|proposal|plan|policy)/i,
      /(?:Trump|Biden|Ukraine|Russia|president|congress)/i,
      /(?:the (?:main|key|primary)|importantly)/i,
    ];

    const contentSentences: string[] = [];
    for (const sentence of sentences) {
      // Skip sentences that are clearly meta-reasoning
      if (/^(?:so|therefore|thus|hence|accordingly)/i.test(sentence)) continue;
      if (/(?:I should|let me|I will|I need|I can)/i.test(sentence)) continue;

      for (const pattern of contentPatterns) {
        if (pattern.test(sentence)) {
          contentSentences.push(sentence);
          break;
        }
      }
    }

    // Use content sentences if found, otherwise take last few sentences (often conclusions)
    const useSentences = contentSentences.length > 0
      ? contentSentences.slice(0, 3)
      : sentences.slice(-3);

    if (useSentences.length === 0) {
      return null;
    }

    const response = useSentences.join('. ').replace(/\.{2,}/g, '.').trim();

    // Don't prefix with "Based on my analysis" - just return clean content
    return response.endsWith('.') ? response : response + '.';
  }
  private async runLocalCommand(command: string): Promise<void> {
    const renderer = this.promptController?.getRenderer();
    if (!command) {
      this.promptController?.setStatusMessage('Usage: /bash <command>');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2500);
      return;
    }

    this.promptController?.setStatusMessage(`bash: ${command}`);
    try {
      const { stdout: out, stderr } = await exec(command, {
        cwd: this.workingDir,
        maxBuffer: 4 * 1024 * 1024,
      });
      const output = [out, stderr].filter(Boolean).join('').trim() || '(no output)';
      // §2/§3: header and result are separate blocks — one combined 'tool'
      // event rendered the whole output bold as if it were the tool name.
      renderer?.addEvent('tool', `$ ${command}`);
      renderer?.addEvent('tool-result', formatToolResult('bash', output, { command }));
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
      renderer?.addEvent('tool', `$ ${command}`);
      renderer?.addEvent('error', formatToolError(output || 'command failed'));
    } finally {
      this.promptController?.setStatusMessage(null);
    }
  }

  private handleSlashCommand(command: string): boolean {
    const trimmed = command.trim();
    const lower = trimmed.toLowerCase();

    // /model and /secrets were removed: Anvilwing is locked to anvilwing
    // on max thought (no model switching), and /key is the one key you set.

    // Handle /key — set your own Anvilwing OR Tavily API key. Routed by prefix:
    // `sk-…` → Anvilwing (the model), `tvly-…` → Tavily (web search). Explicit
    // `/key tavily <k>` / `/key anvilwing <k>` also work. Bring-your-own-key is
    // the model; both are stored in the OS-permission secret store.
    if (lower === '/key' || lower.startsWith('/key ')) {
      const renderer = this.promptController?.getRenderer();
      const arg = trimmed.slice('/key'.length).trim();
      const entry = classifyKeyEntry(arg);
      if (entry) {
        try {
          setSecretValue(entry.id, entry.value);
          const label = getSecretDefinition(entry.id)?.label ?? entry.id;
          renderer?.addEvent('system', chalk.green(`✓ ${label} saved`));
          // Re-render the welcome banner so it reflects the now-saved Anvilwing
          // key (masked key + model) instead of still showing "No Anvilwing API
          // key configured". Tavily-only saves don't appear in the banner.
          if (entry.id === 'ANVILWING_API_KEY') {
            void this.showWelcome();
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          renderer?.addEvent('system', chalk.red(`✗ Failed: ${msg}`));
        }
      } else {
        renderer?.addEvent('system', chalk.yellow('Usage: /key sk-… (Anvilwing) or /key tvly-… (Tavily web search)'));
      }
      return true;
    }

    // /update — check npm for a newer version and upgrade in-shell.
    if (lower === '/update' || lower === '/upgrade') {
      void this.handleUpdateCommand();
      return true;
    }

    if (lower === '/help' || lower === '/h' || lower === '/?') {
      this.showHelp();
      return true;
    }

    if (lower === '/clear' || lower === '/c') {
      this.pendingPrompts = [];
      const r = this.promptController?.getRenderer();
      r?.setFollowUpQueueMode(false);
      r?.setQueuedPrompts([]);
      // Start a genuinely FRESH conversation (Claude Code parity), not just a
      // screen wipe: drop the model's conversation history + per-session state.
      // /clear that leaves the model remembering everything is a cosmetic wipe.
      this.controller.clearHistory();
      this.sessionId = null;
      this.originalPromptForAutoContinue = null;
      this.autoGovernor.reset();
      this.failureRegistry.reset();
      getTaskCompletionDetector().reset();
      clearCurrentTodos();
      this.promptController?.clearScreen();
      void this.showWelcome();
      return true;
    }

    if (lower === '/compact') {
      // Manual compaction (Claude Code parity): reclaim context on demand on a
      // long task instead of waiting for the automatic trigger. Renders the
      // result note directly — when run idle (no active turn) the
      // context.compacted event stream isn't being consumed.
      this.promptController?.setStatusMessage('Compacting context…');
      void this.controller.compactNow().then((res) => {
        const renderer = this.promptController?.getRenderer();
        if (res.removed > 0) {
          renderer?.addEvent('system', chalk.dim(formatCompactionNote({
            removed: res.removed, summarized: res.summarized, freedTokens: res.freedTokens, percentage: 0,
          })));
          this.promptController?.setStatusMessage(null);
        } else {
          this.promptController?.setStatusMessage('Nothing to compact yet — not enough history.');
          setTimeout(() => this.promptController?.setStatusMessage(null), 2500);
        }
      }).catch(() => this.promptController?.setStatusMessage(null));
      return true;
    }

    if (lower.startsWith('/bash') || lower.startsWith('/sh ')) {
      const cmd = trimmed.replace(/^\/(bash|sh)\s*/i, '').trim();
      void this.runLocalCommand(cmd);
      return true;
    }


    if (lower === '/exit' || lower === '/quit' || lower === '/q') {
      this.handleExit();
      return true;
    }

    // Keyboard shortcuts help
    if (lower === '/keys' || lower === '/shortcuts' || lower === '/kb') {
      this.showKeyboardShortcuts();
      return true;
    }

    // /resume — pick a saved conversation and restore its full history into
    // context (the agent continues where it left off).
    if (lower === '/resume' || lower === '/sessions') {
      this.handleResume();
      return true;
    }

    // /context — show how much of the model's context window is in use.
    if (lower === '/context' || lower === '/usage') {
      this.showContext();
      return true;
    }

    // /cost — Anvilwing tokens + Tavily searches consumed (this session + all
    // time), and the Tavily shared-proxy free-pool reference.
    if (lower === '/cost' || lower === '/spend') {
      this.showUsage();
      return true;
    }

    // /diff — review the files the agent changed this run, as colored diffs.
    if (lower === '/diff' || lower === '/changes') {
      this.showDiff();
      return true;
    }

    // /rewind — restore the files changed this run to their prior state
    // (two-step: preview, then `/rewind confirm`).
    if (lower === '/rewind' || lower.startsWith('/rewind ') || lower === '/revert' || lower.startsWith('/revert ')) {
      this.handleRewind(trimmed.split(/\s+/).slice(1).join(' '));
      return true;
    }

    // Everything is on by default for max performance — there are no toggles.
    // Ultracode + max thought, the adversarial verifier, and auto-continue all
    // run under the hood. The /auto, /adversarial, /debug, /ultracode, /model,
    // /secrets, /pin, and /email commands were removed; /key is the one knob.

    return false;
  }

  /**
   * Switch model silently without writing to chat.
   * Accepts formats: "provider", "provider model", "provider/model", or "model"
   * Updates status bar to show new model.
   */
  private async switchModel(arg: string): Promise<void> {
    // Ensure we have provider info
    if (!this.cachedProviders) {
      await this.fetchProviders();
    }

    const providers = this.cachedProviders || [];
    const configuredProviders = getConfiguredProviders();
    let targetProvider: ProviderId | null = null;
    let targetModel: string | null = null;

    // Parse argument: could be "provider model", "provider/model", "provider", or just "model"
    // Check for space-separated format first: "openai o1-pro"
    const parts = arg.split(/[\s/]+/);
    if (parts.length >= 2) {
      // Try first part as provider
      const providerMatch = this.matchProvider(parts[0] || '');
      if (providerMatch) {
        targetProvider = providerMatch as ProviderId;
        targetModel = parts.slice(1).join('/'); // Rest is model (handle models with slashes)
      } else {
        // First part isn't a provider, treat whole arg as model name
        const inferredProvider = this.inferProviderFromModel(arg.replace(/\s+/g, '-'));
        if (inferredProvider) {
          targetProvider = inferredProvider;
          targetModel = arg.replace(/\s+/g, '-');
        }
      }
    } else {
      // Single token - could be provider or model
      const matched = this.matchProvider(arg);
      if (matched) {
        targetProvider = matched as ProviderId;
        // Use provider's best model
        const providerStatus = providers.find(p => p.provider === targetProvider);
        targetModel = providerStatus?.latestModel || null;
      } else {
        // Assume it's a model name - try to infer provider from model prefix
        const inferredProvider = this.inferProviderFromModel(arg);
        if (inferredProvider) {
          targetProvider = inferredProvider;
          targetModel = arg;
        }
      }
    }

    // Validate we have a valid provider
    if (!targetProvider) {
      // Silent error - just flash status briefly
      this.promptController?.setStatusMessage(`Unknown: ${arg}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Check provider is configured
    const providerInfo = configuredProviders.find(p => p.id === targetProvider);
    if (!providerInfo) {
      // Provider not configured - offer to set up API key
      const secretMap: Record<string, SecretName> = {
        'anvilwing': 'ANVILWING_API_KEY',
      };
      const secretId = secretMap[targetProvider];
      if (secretId) {
        this.promptController?.setStatusMessage(`${targetProvider} needs API key - setting up...`);
        // Store the pending model switch to complete after secret is set
        this.pendingModelSwitch = { provider: targetProvider, model: targetModel };
        setTimeout(() => this.promptForSecret(secretId), 500);
        return;
      }
      // Provider not supported
      this.promptController?.setStatusMessage(`${targetProvider} not available - only Anvilwing is supported`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Get model if not specified
    if (!targetModel) {
      const providerStatus = providers.find(p => p.provider === targetProvider);
      targetModel = providerStatus?.latestModel || providerInfo.latestModel;
    }

    // Save preference and update config
    saveModelPreference(this.profile, {
      provider: targetProvider,
      model: targetModel,
    });

    // Update local config
    this.profileConfig = {
      ...this.profileConfig,
      provider: targetProvider,
      model: targetModel,
    };

    // Update controller's model
    await this.controller.switchModel({
      provider: targetProvider,
      model: targetModel,
    });

    // Update status bar - this displays the model below the chat box
    this.promptController?.setModelContext({
      model: targetModel,
      provider: targetProvider,
    });

    // Silent success - no chat output, just status bar update
  }

  /**
   * Match user input to a provider ID (fuzzy matching)
   */
  private matchProvider(input: string): ProviderId | null {
    const lower = input.toLowerCase();
    const providers = getConfiguredProviders();

    // Exact match
    const exact = providers.find(p => p.id === lower || p.name.toLowerCase() === lower);
    if (exact) return exact.id;

    // Prefix match
    const prefix = providers.find(p =>
      p.id.startsWith(lower) || p.name.toLowerCase().startsWith(lower)
    );
    if (prefix) return prefix.id;

    // Alias matching
    const aliases: Record<string, ProviderId> = {
      'ds': 'anvilwing',
      'deep': 'anvilwing',
    };

    if (aliases[lower]) {
      const aliased = providers.find(p => p.id === aliases[lower]);
      if (aliased) return aliased.id;
    }

    return null;
  }

  /**
   * Infer provider from model name
   */
  private inferProviderFromModel(model: string): ProviderId | null {
    const lower = model.toLowerCase();

    if (lower.startsWith('anvilwing')) {
      return 'anvilwing';
    }

    return null;
  }

  /**
   * Show interactive model picker menu (Claude Code style).
   * Auto-discovers latest models from each provider's API.
   * Uses arrow key navigation with inline panel display.
   */
  private showModelMenu(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /model <provider> <model> to switch');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    // Show loading indicator
    this.promptController?.setStatusMessage('Discovering models...');

    // Fetch latest models from APIs
    void this.fetchAndShowModelMenu();
  }

  /**
   * Fetch models from provider APIs and show the interactive menu.
   */
  private async fetchAndShowModelMenu(): Promise<void> {
    try {
      // Get provider status and cached models
      const allProviders = getProvidersStatus();
      const cachedModels = getCachedDiscoveredModels();
      const currentModel = this.profileConfig.model;
      const currentProvider = this.profileConfig.provider;

      // Try to get fresh models from configured providers (with short timeout)
      let freshStatus: QuickProviderStatus[] = [];
      try {
        freshStatus = await Promise.race([
          quickCheckProviders(),
          new Promise<QuickProviderStatus[]>((resolve) => setTimeout(() => resolve([]), 3000))
        ]);
      } catch {
        // Use cached data on error
      }

      // Build menu items - group by provider, show models
      const menuItems: MenuItem[] = [];

      for (const provider of allProviders) {
        // Get models for this provider
        const providerCachedModels = cachedModels.filter(m => m.provider === provider.id);
        const freshProvider = freshStatus.find(s => s.provider === provider.id);

        // Collect model IDs
        let modelIds: string[] = [];

        // Add fresh latest model if available
        if (freshProvider?.available && freshProvider.latestModel) {
          modelIds.push(freshProvider.latestModel);
        }

        // Add cached models
        modelIds.push(...providerCachedModels.map(m => m.id));

        // Add provider's default model
        if (provider.latestModel && !modelIds.includes(provider.latestModel)) {
          modelIds.push(provider.latestModel);
        }

        // Remove duplicates and sort by priority (best first)
        modelIds = [...new Set(modelIds)];
        modelIds = sortModelsByPriority(provider.id, modelIds);

        // Limit to top 3 models per provider
        const topModels = modelIds.slice(0, 3);

        if (!provider.configured) {
          // Show unconfigured provider as single disabled item
          menuItems.push({
            id: `${provider.id}:setup`,
            label: `${provider.name}`,
            description: `(${provider.envVar} not set - select to configure)`,
            category: provider.id,
            isActive: false,
            disabled: false, // Allow selection to configure
          });
        } else if (topModels.length === 0) {
          // No models found - show provider with default
          menuItems.push({
            id: `${provider.id}:${provider.latestModel}`,
            label: `${provider.name} › ${provider.latestModel}`,
            description: 'default',
            category: provider.id,
            isActive: provider.id === currentProvider && provider.latestModel === currentModel,
            disabled: false,
          });
        } else {
          // Show each model as selectable item
          for (const modelId of topModels) {
            const isCurrentModel = provider.id === currentProvider && modelId === currentModel;
            const modelLabel = this.formatModelLabel(modelId);

            menuItems.push({
              id: `${provider.id}:${modelId}`,
              label: `${provider.name} › ${modelLabel}`,
              description: isCurrentModel ? '(current)' : '',
              category: provider.id,
              isActive: isCurrentModel,
              disabled: false,
            });
          }
        }
      }

      // Clear loading message
      this.promptController?.setStatusMessage(null);

      // Show the interactive menu
      this.promptController?.setMenu(
        menuItems,
        { title: 'Select Model' },
        (selected: MenuItem | null) => {
          if (selected) {
            // Parse provider:model format
            const [providerId, ...modelParts] = selected.id.split(':');
            const modelId = modelParts.join(':');

            if (modelId === 'setup') {
              // Configure provider API key
              const secretMap: Record<string, SecretName> = {
                'anvilwing': 'ANVILWING_API_KEY',
              };
              const secretId = secretMap[providerId ?? ''];
              if (secretId) {
                this.promptForSecret(secretId);
              }
            } else {
              // Switch to selected model
              void this.switchModel(`${providerId} ${modelId}`);
            }
          }
        }
      );
    } catch (error) {
      this.promptController?.setStatusMessage('Failed to load models');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
    }
  }

  /**
   * Format model ID for display (shorten long IDs).
   */
  private formatModelLabel(modelId: string): string {
    let label = modelId
      .replace(/^anvilwing-/, 'Anvilwing ');

    if (label.length > 30) {
      label = label.slice(0, 27) + '...';
    }

    return label;
  }

  private showSecrets(): void {
    const secrets = listSecretDefinitions();

    if (!this.promptController?.supportsInlinePanel()) {
      // Fallback for non-TTY - use status message
      const setCount = secrets.filter(s => !!process.env[s.envVar]).length;
      this.promptController?.setStatusMessage(`API Keys: ${setCount}/${secrets.length} configured`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    // Build interactive menu items
    const menuItems: MenuItem[] = secrets.map(secret => {
      const isSet = !!process.env[secret.envVar];
      const statusIcon = isSet ? '✓' : '✗';
      const providers = secret.providers?.length ? ` (${secret.providers.join(', ')})` : '';

      return {
        id: secret.id,
        label: `${statusIcon} ${secret.envVar}`,
        description: isSet ? 'configured' + providers : 'not set' + providers,
        isActive: isSet,
        disabled: false,
      };
    });

    // Show the interactive menu
    this.promptController.setMenu(
      menuItems,
      { title: 'API Keys — Select to Configure' },
      (selected: MenuItem | null) => {
        if (selected) {
          // Start secret input for selected key
          this.promptForSecret(selected.id as SecretName);
        }
      }
    );
  }

  /**
   * Start interactive secret input flow.
   * If secretArg is provided, set only that secret.
   * Otherwise, prompt for all unset secrets.
   */
  private async startSecretInput(secretArg?: string): Promise<void> {
    const secrets = listSecretDefinitions();

    if (secretArg) {
      // Set a specific secret
      const upper = secretArg.toUpperCase();
      const secret = secrets.find(s => s.id === upper || s.envVar === upper);
      if (!secret) {
        this.promptController?.setStatusMessage(`Unknown secret: ${secretArg}`);
        setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        return;
      }
      this.promptForSecret(secret.id);
      return;
    }

    // Queue all unset secrets for input
    const unsetSecrets = secrets.filter(s => !getSecretValue(s.id));
    if (unsetSecrets.length === 0) {
      this.promptController?.setStatusMessage('All secrets configured');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Queue all unset secrets and start with the first one
    this.secretInputMode.queue = unsetSecrets.map(s => s.id);
    const first = this.secretInputMode.queue.shift();
    if (first) {
      this.promptForSecret(first);
    }
  }

  /**
   * Show prompt for a specific secret and enable secret input mode.
   */
  private promptForSecret(secretId: SecretName): void {
    const secrets = listSecretDefinitions();
    const secret = secrets.find(s => s.id === secretId);
    if (!secret) return;

    // Show in inline panel (no chat output)
    if (this.promptController?.supportsInlinePanel()) {
      const lines = [
        chalk.bold.hex('#e8e9ed')(`Set ${secret.label}`),
        chalk.dim(secret.description),
        '',
        chalk.dim('Enter value (or press Enter to skip)'),
      ];
      this.promptController.setInlinePanel(lines);
    }

    // Enable secret input mode
    this.secretInputMode.active = true;
    this.secretInputMode.secretId = secretId;
    this.promptController?.setSecretMode(true);
    this.promptController?.setStatusMessage(`Enter ${secret.label}...`);
  }

  /**
   * Handle secret value submission.
   */
  private handleSecretValue(value: string): void {
    const secretId = this.secretInputMode.secretId;
    if (!secretId) return;

    // Disable secret mode and clear inline panel
    this.promptController?.setSecretMode(false);
    this.promptController?.clearInlinePanel();
    this.secretInputMode.active = false;
    this.secretInputMode.secretId = null;

    let savedSuccessfully = false;
    if (value.trim()) {
      try {
        setSecretValue(secretId, value.trim());
        this.promptController?.setStatusMessage(`${secretId} saved`);
        savedSuccessfully = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to save';
        this.promptController?.setStatusMessage(msg);
      }
    } else {
      this.promptController?.setStatusMessage(`Skipped ${secretId}`);
    }

    // Clear status after a moment
    setTimeout(() => this.promptController?.setStatusMessage(null), 1500);

    // Process next secret in queue if any
    if (this.secretInputMode.queue.length > 0) {
      const next = this.secretInputMode.queue.shift();
      if (next) {
        setTimeout(() => this.promptForSecret(next), 500);
      }
      return;
    }

    // Complete pending model switch if secret was saved successfully
    if (savedSuccessfully && this.pendingModelSwitch) {
      const { provider, model } = this.pendingModelSwitch;
      this.pendingModelSwitch = null;
      // Refresh provider cache and complete the switch
      setTimeout(async () => {
        await this.fetchProviders();
        await this.switchModel(model ? `${provider} ${model}` : provider);
      }, 500);
    }
  }

  /**
   * Snapshot the live conversation to the session store so /resume can
   * restore it later. Best-effort: a persistence failure must never break a
   * turn, so everything is wrapped. Skips empty/system-only histories so we
   * don't litter the picker with sessions that have no real exchange.
   */
  private persistSessionSnapshot(): void {
    try {
      const messages = this.controller.getHistory();
      if (!messages.some((m) => m.role === 'user')) {
        return;
      }
      const summary = saveSessionSnapshot({
        id: this.sessionId,
        profile: this.profile,
        provider: this.profileConfig.provider,
        model: this.profileConfig.model,
        workspaceRoot: this.workingDir,
        messages,
      });
      this.sessionId = summary.id;
    } catch {
      // best-effort persistence — never interrupt the user's turn
    }
  }

  /**
   * /resume — present saved conversations newest-first and restore the
   * chosen one's full message history into the agent's context.
   */
  private handleResume(): void {
    const renderer = this.promptController?.getRenderer();
    const sessions = listSessions().filter((s) => s.id !== this.sessionId && s.messageCount > 0);
    if (sessions.length === 0) {
      renderer?.addEvent('system', chalk.dim('No saved conversations to resume yet.'));
      return;
    }

    const items: MenuItem[] = sessions.slice(0, 25).map((s) => ({
      id: s.id,
      label: s.title,
      description: `${s.messageCount} msg · ${relativeTime(s.updatedAt)}`,
    }));

    this.promptController?.setMenu(
      items,
      { title: 'Resume a conversation' },
      (selected: MenuItem | null) => {
        if (selected) {
          this.resumeSession(selected.id);
        }
      },
    );
  }

  /**
   * Load a saved session by id, restore its history into the controller (and
   * thus the agent's context), and reprint the prior exchange so the user
   * sees where they left off.
   */
  private resumeSession(id: string): void {
    const renderer = this.promptController?.getRenderer();
    const stored = loadSessionById(id);
    if (!stored) {
      renderer?.addEvent('error', 'That conversation could not be loaded.');
      return;
    }

    this.controller.loadHistory(stored.messages);
    this.sessionId = stored.id;

    const restored = stored.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    renderer?.addEvent(
      'system',
      chalk.dim(`Resumed "${stored.title}" — ${restored.length} message${restored.length === 1 ? '' : 's'} restored`),
    );
    for (const m of stored.messages) {
      if (m.role === 'user') {
        renderer?.addUserHistoryItem(m.content);
      } else if (m.role === 'assistant' && m.content.trim()) {
        renderer?.addEvent('response', m.content);
      }
    }
  }

  /**
   * /context — a compact context-window usage panel. Uses the real model
   * window and the provider's last input-token count (falls back to a char/4
   * estimate, marked "~", before the first turn).
   */
  private showContext(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /context in interactive mode');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const model = this.profileConfig.model;
    const windowTokens = getModelContextInfo(model).contextWindow;
    const usage = computeContextUsage(this.controller.getHistory(), windowTokens, this.lastInputTokens);

    const label = (s: string) => chalk.hex('#ffd666')(s.padEnd(8));
    const dim = (s: string) => chalk.dim(s);
    const approx = usage.estimated ? '~' : '';

    const barWidth = 24;
    const filled = Math.min(barWidth, Math.round((usage.percentUsed / 100) * barWidth));
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

    const lines = [
      chalk.bold.hex('#e8e9ed')('Context') + dim('  (press any key to dismiss)'),
      '',
      dim(bar) + '  ' + chalk.hex('#e8e9ed')(`${usage.percentLeft}% context left`),
      '',
      label('Window') + dim(`${formatTokenCount(windowTokens)} tokens · ${model}`),
      label('Used') + dim(`${approx}${formatTokenCount(usage.usedTokens)} tokens (${usage.percentUsed}%)`),
      label('Free') + dim(`${formatTokenCount(usage.freeTokens)} tokens (${usage.percentLeft}%)`),
      '',
      dim(`System prompt ~${formatTokenCount(usage.systemTokens)} · conversation ~${formatTokenCount(usage.conversationTokens)} · ${usage.messageCount} messages`),
    ];

    this.promptController.setInlinePanel(lines);
  }

  /** /cost — Anvilwing tokens + Tavily searches consumed (this install). */
  private showUsage(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /cost in interactive mode');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }
    const { session, cumulative } = getUsage();
    const label = (s: string) => chalk.hex('#ffd666')(s.padEnd(9));
    const dim = (s: string) => chalk.dim(s);
    const ds = (u: { anvilwingInputTokens: number; anvilwingOutputTokens: number }) =>
      `${formatTokenCount(u.anvilwingInputTokens)} in · ${formatTokenCount(u.anvilwingOutputTokens)} out`;
    const lines = [
      chalk.bold.hex('#e8e9ed')('Usage') + dim('  (press any key to dismiss)'),
      '',
      label('Anvilwing') + dim(`${ds(cumulative)}   ·   this session ${ds(session)}`),
      label('Tavily') + dim(`${cumulative.tavilySearches} searches   ·   this session ${session.tavilySearches}`),
      '',
      // Two ≤78-col lines — the single-sentence version measured 97 cols and
      // word-wrapped onto an unindented row at the default 80-col terminal.
      dim(`Tavily free pool: ${TAVILY_MONTHLY_FREE.toLocaleString('en-US')}/mo + ${TAVILY_ONE_TIME_BONUS.toLocaleString('en-US')} one-time bonus (shared proxy).`),
      dim('Set your own key for unlimited: /key tvly-…'),
    ];
    this.promptController.setInlinePanel(lines);
  }

  /**
   * /diff — review every file the agent changed this run as a colored diff,
   * in a dismissable panel. Reads each file's original content from the change
   * tracker and its current content from disk; an empty tracker means nothing
   * changed since the last prompt.
   */
  private showDiff(): void {
    const renderer = this.promptController?.getRenderer();
    const changed = getChangedFiles();
    if (changed.size === 0) {
      renderer?.addEvent('system', chalk.dim('No file changes in the last run.'));
      return;
    }
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage(`${changed.size} file(s) changed this run`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const items: ChangeItem[] = [];
    for (const [absPath, record] of changed) {
      let current = '';
      let deleted = false;
      try {
        current = readFileSync(absPath, 'utf-8');
      } catch {
        deleted = true;
      }
      items.push({
        relPath: relative(this.workingDir, absPath) || absPath,
        previous: record.originalContent ?? '',
        current,
        existedBefore: record.existedBefore,
        deleted,
      });
    }

    const panel = renderChangePanel(items);
    const dim = (s: string) => chalk.dim(s);
    const lines = [
      chalk.bold.hex('#e8e9ed')('Changes') + dim('  (press any key to dismiss)'),
      '',
      ...panel.lines,
    ];
    this.promptController.setInlinePanel(lines);
  }

  /**
   * /rewind — restore the files changed this run. Two-step: bare `/rewind`
   * previews what will be restored/deleted (kept in the transcript so it stays
   * visible while the user types the confirm); `/rewind confirm` performs the
   * revert via the change tracker. File-level only — the conversation is not
   * rewound, and the message says so by scope ("files … before this run").
   */
  private handleRewind(arg: string): void {
    const renderer = this.promptController?.getRenderer();
    const changed = getChangedFiles();
    if (changed.size === 0 || !hasChangesToRevert()) {
      renderer?.addEvent('system', chalk.dim('Nothing to rewind — no file changes this run.'));
      return;
    }

    if (arg.trim().toLowerCase() !== 'confirm') {
      const items: RewindItem[] = [...changed].map(([abs, rec]) => ({
        relPath: relative(this.workingDir, abs) || abs,
        existedBefore: rec.existedBefore,
      }));
      const lines = rewindPreviewLines(items);
      lines.forEach((line, i) => {
        const last = i === lines.length - 1;
        renderer?.addEvent('system', last ? chalk.hex('#ffd666')(line) : chalk.dim(line));
      });
      return;
    }

    let restored = 0;
    let deleted = 0;
    for (const [, rec] of changed) {
      if (rec.existedBefore && rec.originalContent !== null) restored += 1;
      else if (!rec.existedBefore) deleted += 1;
    }
    revertAllChanges(this.workingDir); // restores/deletes on disk + clears tracking
    renderer?.addEvent('system', chalk.green('✓ ' + rewindResultLine(restored, deleted)));
  }

  private showHelp(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Help: /key sk-… (everything else is automatic)');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const cmd = (s: string) => chalk.hex('#ffd666')(s);
    const dim = (s: string) => chalk.dim(s);

    // One knob. Everything else (ultracode, max thought, the adversarial
    // verifier, auto-continue) is on by default for max performance — there
    // are no toggles to tune.
    const lines = [
      chalk.bold.hex('#e8e9ed')('Anvilwing Coder') + dim('  (press any key to dismiss)'),
      '',
      cmd('/key sk-…') + dim('     Set your Anvilwing API key (required)'),
      cmd('/key tvly-…') + dim('   Set your Tavily key for web search (optional)'),
      cmd('/update') + dim('      Check npm and upgrade to the latest version'),
      cmd('/resume') + dim('      Restore a previous conversation'),
      cmd('/context') + dim('     Show context-window usage'),
      cmd('/cost') + dim('        Anvilwing tokens + Tavily searches consumed'),
      cmd('/diff') + dim('        Review changes made this run'),
      cmd('/rewind') + dim('      Undo this run\'s file changes'),
      '',
      dim('Prefixes: ') + cmd('@file') + dim(' attach · ') + cmd('!cmd') + dim(' run shell · ') + cmd('#note') + dim(' save to memory'),
      '',
      dim('Everything else runs automatically —'),
      dim('anvilwing · max thought · ultracode · adversarial verifier, all on.'),
      dim('Shift+Tab permission mode · Ctrl+T toggles · Ctrl+D exits · ? for shortcuts'),
    ];

    this.promptController.setInlinePanel(lines);
  }


  private showKeyboardShortcuts(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /keys in interactive mode');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const kb = (key: string) => chalk.hex('#ffd666')(key);
    const desc = (text: string) => chalk.dim(text);
    // Pad the PLAIN key text before colouring so the description column is
    // grid-aligned — hand-counted spaces inside coloured templates drifted
    // by 1-2 cols per row.
    const row = (keys: string, text: string) => `  ${kb(keys.padEnd(14))}${desc(text)}`;

    // Only shortcuts the Ink Prompt (src/ui/ink/Prompt.tsx) actually
    // implements are listed — advertising keys the input handler ignores
    // would be a deceptive panel (transparency).
    const lines = [
      chalk.bold.hex('#e8e9ed')('Keyboard Shortcuts') + chalk.dim('  (press any key to dismiss)'),
      '',
      chalk.hex('#64d2ff')('Navigation'),
      row('Ctrl+A / Home', 'Move to start of line'),
      row('Ctrl+E / End', 'Move to end of line'),
      row('← / →', 'Move cursor'),
      row('↑ / ↓', 'Prompt history (older / newer)'),
      row('Ctrl+R', 'Reverse-search prompt history'),
      '',
      chalk.hex('#64d2ff')('Editing'),
      row('Ctrl+U', 'Delete to start of line'),
      row('Ctrl+W', 'Delete word backward'),
      row('Ctrl+K', 'Delete to end of line'),
      '',
      chalk.hex('#64d2ff')('Modes'),
      row('Shift+Tab', 'Cycle permission mode (default · accept edits · plan)'),
      row('Ctrl+T', 'Toggles menu — auto-continue · confirm actions · debug'),
      row('Ctrl+O', 'Expand the last truncated tool result'),
      '',
      chalk.hex('#64d2ff')('Completion'),
      row('@', 'Autocomplete a file; its content is inlined for the agent'),
      row('/', 'Autocomplete a command (↑/↓ · Tab to complete; Enter runs it)'),
      '',
      chalk.hex('#64d2ff')('Control'),
      row('Ctrl+C', 'Clear input / interrupt'),
      row('Ctrl+D', 'Exit (when empty)'),
    ];

    this.promptController.setInlinePanel(lines);
  }

  // Panels dismiss on the next keypress (Prompt → onDismissPanel), never on a
  // timer: the old 8s auto-dismiss yanked /context and /help mid-read, which
  // Claude Code never does.
  private dismissInlinePanel(): void {
    this.promptController?.clearInlinePanel();
  }

  private handleSubmit(text: string): void {
    const trimmed = text.trim();

    // Handle secret input mode - capture the API key value
    if (this.secretInputMode.active && this.secretInputMode.secretId) {
      this.handleSecretValue(trimmed);
      return;
    }

    if (!trimmed) {
      return;
    }

    // Handle slash commands first - these don't go to the AI
    if (trimmed.startsWith('/')) {
      if (this.handleSlashCommand(trimmed)) {
        return;
      }
      // Unknown slash command - silent status flash, dismiss inline panel
      this.dismissInlinePanel();
      this.promptController?.setStatusMessage(`Unknown: ${trimmed.slice(0, 30)}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // `!cmd` — bash mode (Claude Code parity): run the rest as a shell command
    // directly, no model round-trip. Same executor as /bash, via the leading
    // bang. Runs immediately (like a slash command), not queued behind the agent.
    if (trimmed.startsWith('!')) {
      this.dismissInlinePanel();
      void this.runLocalCommand(trimmed.slice(1).trim());
      return;
    }

    // `#note` — quick-capture a note to persistent project memory (Claude Code
    // parity), no model round-trip. Lands in .anvilwing/memory/ where the agent
    // reads it on later sessions.
    if (trimmed.startsWith('#')) {
      this.dismissInlinePanel();
      const note = trimmed.slice(1).trim();
      const r = this.promptController?.getRenderer();
      if (appendMemoryNote(this.workingDir, note)) r?.addEvent('system', chalk.green('✓ Saved to memory'));
      else r?.addEvent('system', chalk.yellow('Usage: #<note to remember>'));
      return;
    }

    // Dismiss inline panel for regular user prompts
    this.dismissInlinePanel();

    // Live follow-up queue (Claude Code parity): a prompt typed while the agent
    // is working is accepted immediately into a transient queue (visible above
    // the input, *not* in permanent history). It is processed at the next turn
    // boundary (ASAP, before any outer auto-continue decides the original task
    // is "complete"). No polluting system banners.
    if (this.isProcessing) {
      this.pendingPrompts.push(trimmed);
      const renderer = this.promptController?.getRenderer();
      renderer?.setFollowUpQueueMode(true);
      renderer?.setQueuedPrompts(this.pendingPrompts.slice());
      return;
    }

    void this.processPrompt(trimmed).catch((e) => {
      // processPrompt handles its own errors; this is the last net so a
      // rejection can't reach the global unhandledRejection handler (which
      // exits the CLI with code 1).
      try {
        this.promptController?.getRenderer()?.addEvent('error', formatErrorForDisplay(e instanceof Error ? e.message : String(e)));
      } catch { /* ignore */ }
    });
  }

  /**
   * Dequeue and run the next live follow-up, if any: commit its user line to
   * history, refresh the transient queue UI, then process it. Single source of
   * truth for the dequeue so the per-turn drain and the test seam can't drift —
   * that drift is exactly how a queued-prompt UX goes subtly wrong.
   */
  private async drainNextQueuedPrompt(): Promise<boolean> {
    if (this.pendingPrompts.length === 0 || this.shouldExit) {
      return false;
    }
    const next = this.pendingPrompts.shift();
    if (!next) {
      return false;
    }
    const r = this.promptController?.getRenderer();
    r?.setFollowUpQueueMode(false);
    r?.addUserHistoryItem(next);
    r?.setQueuedPrompts(this.pendingPrompts.slice());
    await this.processPrompt(next);
    return true;
  }

  private async processPrompt(prompt: string): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    // Start new run for file change tracking (enables /revert)
    startNewRun();

    // @-file mentions: inline the content of any `@path` the user referenced
    // so the agent gets it directly (the chat history still shows the raw
    // `@path` the user typed — only this agent-bound copy is expanded).
    const mentions = expandFileMentions(prompt, this.workingDir);
    const sanitizedPrompt = mentions.prompt;
    if (mentions.included.length > 0) {
      this.promptController?.getRenderer()?.addEvent(
        'system',
        chalk.dim(`Included ${mentions.included.length} referenced file${mentions.included.length === 1 ? '' : 's'}: ${mentions.included.join(', ')}`),
      );
    }

    // Store original prompt for auto-continuation (if not an auto-generated
    // continuation). Auto-continues are ALWAYS IMPORTANT:-prefixed now, so a
    // user-typed "continue" is a fresh request that resets the governor —
    // the old `prompt !== 'continue'` guard made the halt note's "say
    // continue to keep going" yield exactly one turn per 'continue', forever.
    if (!prompt.startsWith('IMPORTANT:')) {
      // A bare "continue"/"keep going" RESUMES the prior task: reset the
      // budget below but keep the stored task prompt — overwriting it with
      // the literal word "continue" would lose what we're resuming.
      const isBareResume = /^(continue|keep\s+going|go\s+on|resume)[.!]?$/i.test(prompt.trim());
      if (!isBareResume || !this.originalPromptForAutoContinue) {
        this.originalPromptForAutoContinue = prompt;
      }
      // A fresh user prompt clears any prior interrupt state — this is new
      // work the user actually wants done.
      this.userInterruptedRun = false;
      // Fresh user request → start a new auto-continue turn budget + failure log.
      this.autoGovernor.reset();
      this.failureRegistry.reset();
      getTaskCompletionDetector().reset();
      this.adversarialCorrectionCount = 0;
      // …and drop the PREVIOUS request's plan. Stale pending todos otherwise
      // hijack the new prompt: the auto-continue loop sees old pending items
      // and keeps grinding the OLD plan instead of what the user just asked
      // (audit #20). The model writes a fresh TodoWrite plan when the new
      // task warrants one.
      clearCurrentTodos();
      // New user turn → `↑ N tokens` restarts from zero. Continuations
      // ('continue' / IMPORTANT:-prefixed) keep accumulating into the same turn.
      this.turnTokenMeter.reset();
      this.promptController?.setMetaStatus({ outputTokens: 0 });
      // Pinned-prompt persistence removed per request — no longer
      // displayed above the chat box.
    }

    enterCriticalSection();

    // Per-turn dedupe latch for error display: a provider failure arrives
    // both as an 'error' event AND as the sink rejection thrown out of the
    // event loop — without the latch the same message printed twice.
    this.lastShownTurnError = null;
    this.isProcessing = true;
    this.currentResponseBuffer = '';
    this.finalResponseText = '';
    this.promptController?.setStreaming(true);
    this.promptController?.setStatusMessage('Analyzing request…');

    const renderer = this.promptController?.getRenderer();

    let episodeSuccess = false;
    const toolsUsed: string[] = [];
    const filesModified: string[] = [];
    // Tail of this turn's tool outputs (where TS/test/build errors land), so the
    // failure registry + governor see real error text, not just the narration.
    let turnToolOutput = '';
    // Reviewer findings from THIS turn (set by the adversarial.findings event),
    // used in the finally to drive a bounded auto-correction.
    let turnAdversarialFindings: string | null = null;

    // Track reasoning content for fallback when response is empty
    let reasoningBuffer = '';

    // Track reasoning-only time to prevent models from reasoning forever without action
    let reasoningOnlyStartTime: number | null = null;
    let reasoningTimedOut = false;
    let stepTimedOut = false;
    let hitlDepth = 0;
    // The `⏺ Tool(arg)` header most recently emitted into history, or null
    // once any other event rendered after it. With PARALLEL tools the
    // start/start/complete/complete interleave glued tool B's result under
    // tool A's header (§3); tool.complete re-emits its own header when it
    // isn't the last thing on screen.
    let lastToolHeaderEmitted: string | null = null;

    // Track total prompt processing time to prevent infinite loops
    const promptStartTime = Date.now();
    const TOTAL_PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours max for entire prompt without meaningful content
    let hasReceivedMeaningfulContent = false;
    // Track response content separately - tool calls don't count for reasoning timeout
    let hasReceivedResponseContent = false;

    try {
      // Use timeout-wrapped iterator to prevent hanging on slow/stuck models
      for await (const eventOrTimeout of iterateWithTimeout(
        this.controller.send(sanitizedPrompt),
        PROMPT_STEP_TIMEOUT_MS
      )) {
        // Check for timeout marker
        if (eventOrTimeout && typeof eventOrTimeout === 'object' && '__timeout' in eventOrTimeout) {
          if (hitlDepth > 0) {
            this.promptController?.setStatusMessage('Waiting for human decision…');
            continue;
          }
          stepTimedOut = true;
          this.promptController?.setStatusMessage(`Step timeout (${PROMPT_STEP_TIMEOUT_MS / 1000}s) — completing response`);
          // Cancel the controller so the underlying agent stops generating
          // events that would never be consumed. Without this the spinner
          // can keep ticking against a "ghost" run after the for-await
          // loop exits, and any in-flight tool keeps doing work the user
          // can't see or stop.
          try { this.controller.cancel('step timeout'); } catch { /* best-effort */ }
          break;
        }

        // Check total elapsed time - bail out if too long without meaningful content
        const totalElapsed = Date.now() - promptStartTime;
        if (!hasReceivedMeaningfulContent && totalElapsed > TOTAL_PROMPT_TIMEOUT_MS) {
          if (renderer) {
            renderer.addEvent('response', chalk.yellow(`\nResponse timeout (${Math.round(totalElapsed / 1000)}s) — completing\n`));
          }
          reasoningTimedOut = true;
          try { this.controller.cancel('response timeout'); } catch { /* best-effort */ }
          break;
        }

        const event = eventOrTimeout as AgentEventUnion;
        if (this.shouldExit) {
          break;
        }

        switch (event.type) {
          case 'message.start':
            // AI has started processing - update status to show activity
            this.currentResponseBuffer = '';
            this.finalResponseText = '';
            reasoningBuffer = '';
            reasoningOnlyStartTime = null; // Reset on new message
            this.promptController?.setStatusMessage('Thinking...');
            break;

          case 'message.delta':
            // Stream content as it arrives
            this.currentResponseBuffer += event.content ?? '';
            this.finalResponseText += event.content ?? '';
            // Live `↑ N tokens`: estimate from streamed chars until the
            // provider's usage event snaps the exact count. Synthetic deltas
            // (already-streamed narration replays, retry notices) were never
            // provider output — metering them double-counts.
            if (!event.synthetic) {
              this.turnTokenMeter.addStreamedChars((event.content ?? '').length);
              this.promptController?.setMetaStatus({ outputTokens: this.turnTokenMeter.current() });
            }
            if (renderer) {
              renderer.addEvent('stream', event.content);
            }
            // Reset reasoning timer only when we get actual non-empty content
            if (event.content && event.content.trim()) {
              reasoningOnlyStartTime = null;
              hasReceivedMeaningfulContent = true;
              hasReceivedResponseContent = true; // Track actual response content
            }
            break;

          case 'reasoning':
            // Accumulate reasoning for potential fallback synthesis
            reasoningBuffer += event.content ?? '';
            // Reasoning streams count toward completion_tokens too (Anvilwing
            // thinking) — meter them so the live `↑` doesn't sit at zero.
            this.turnTokenMeter.addStreamedChars((event.content ?? '').length);
            this.promptController?.setMetaStatus({ outputTokens: this.turnTokenMeter.current() });
            // Update status to show reasoning is actively streaming
            this.promptController?.setActivityMessage('Thinking');
            // Start the reasoning timer on first reasoning event
            if (!reasoningOnlyStartTime) {
              reasoningOnlyStartTime = Date.now();
            }
            // Display useful reasoning as 'thought' events BEFORE the response
            // The renderer's curateReasoningContent and shouldRenderThought will filter
            // to show only actionable/structured thoughts
            if (renderer && event.content?.trim()) {
              renderer.addEvent('thought', event.content);
            }
            break;

          case 'message.complete':
            // Response complete - clear the thinking indicator
            this.promptController?.setStatusMessage(null);

            // Response complete - ensure final output includes required "Next steps"
            if (renderer) {
              // Use the appended field from ensureNextSteps to avoid re-rendering the entire response
              const base = (event.content ?? '').trimEnd();
              let sourceText = base || this.currentResponseBuffer;

              // If content came via message.complete but NOT via deltas, render it now as a proper response
              // This handles models that don't stream deltas (e.g., anvilwing)
              // IMPORTANT: Do NOT re-emit content that was already streamed via 'message.delta' events
              // to prevent duplicate display of the same response
              if (base && !this.currentResponseBuffer.trim()) {
                renderer.addEvent('response', base);
              }
              // Note: We intentionally DO NOT re-emit currentResponseBuffer as a 'response' event
              // because it was already displayed via 'stream' events during message.delta handling

              // Fallback: If response is empty but we have reasoning, synthesize a response
              if (!sourceText.trim() && reasoningBuffer.trim()) {
                // Extract key conclusions from reasoning for display
                const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
                if (synthesized) {
                  renderer.addEvent('response', synthesized);
                  sourceText = synthesized;
                }
              }

              episodeSuccess = true; // Mark episode as successful only after we have content

              // Only add "Next steps" if tools were actually used (real work done)
              // This prevents showing "Next steps" after reasoning-only responses
              if (toolsUsed.length > 0) {
                const { appended } = ensureNextSteps(sourceText);
                // Only stream the newly appended content (e.g., "Next steps:")
                // The main response was already added as a response event above
                if (appended && appended.trim()) {
                  renderer.addEvent('response', appended);
                }
              }
              renderer.addEvent('response', '\n');
              lastToolHeaderEmitted = null; // prose rendered since the last header
              // Capture the authoritative final text BEFORE the buffer is cleared
              // (the finally's auto-continue reads run after this clear).
              this.finalResponseText = sourceText || this.finalResponseText;
            }
            this.currentResponseBuffer = '';
            break;

          case 'tool.start': {
            const toolName = event.toolName;
            const args = event.parameters;
            if (isHitlToolName(toolName)) {
              hitlDepth += 1;
            }

            // Reset reasoning timer when tools are being called (model is taking action)
            reasoningOnlyStartTime = null;
            hasReceivedMeaningfulContent = true;

            if (!toolsUsed.includes(toolName)) {
              toolsUsed.push(toolName);
            }

            const filePath = (args?.['file_path'] ?? args?.['path']) as string | undefined;
            if (filePath && /edit|write|create|update/i.test(toolName)) {
              if (!filesModified.includes(filePath)) {
                filesModified.push(filePath);
              }
            }

            // Claude-Code action line: `⏺ ToolName(primaryArg)`. The dim
            // present-tense label drives the working spinner above the prompt.
            // parallel_agents is suppressed here — its per-sub-agent Task notes
            // (subagent.start/complete) are the visible surface instead of a
            // raw `parallel_agents({"tasks":…})` JSON dump.
            if (renderer && toolName !== 'parallel_agents') {
              const header = formatToolCall(toolName, args, this.workingDir);
              renderer.addEvent('tool', header);
              lastToolHeaderEmitted = header;
            }
            this.promptController?.setStatusMessage(toolActivityLabel(toolName, args, this.workingDir));
            break;
          }

          case 'tool.complete': {
            if (isHitlToolName(event.toolName)) {
              hitlDepth = Math.max(0, hitlDepth - 1);
            }
            // Keep the tail of tool output for the failure registry / governor
            // (errors land here, not in the assistant narration).
            if (typeof event.result === 'string' && event.result) {
              turnToolOutput = (turnToolOutput + '\n' + event.result).slice(-16000);
            }
            // Clear the activity label; the agent is thinking again.
            this.promptController?.setStatusMessage('Thinking…');
            // Reset reasoning timer after tool completes
            reasoningOnlyStartTime = null;
            // Render the result as a dim `  ⎿  …` block (summarised, never a
            // raw multi-KB dump). Pre-formatted ⏺ blocks (editTools) pass
            // through with just their duplicate header stripped.
            if (event.result && typeof event.result === 'string' && event.result.trim() && renderer) {
              const params = event.parameters;
              const summary = formatToolResult(event.toolName, event.result, params);
              // Pair the ⎿ result with ITS call: if another tool's header (or
              // any other event) rendered since this tool's start, re-emit
              // this call's header so the result lands under the right one.
              if (event.toolName !== 'parallel_agents') {
                const ownHeader = formatToolCall(event.toolName, params, this.workingDir);
                if (lastToolHeaderEmitted !== ownHeader) {
                  renderer.addEvent('tool', ownHeader);
                }
                lastToolHeaderEmitted = null; // a result now sits below the header
              }
              // A tool that returned a FAILURE (the verifiedFailure banner,
              // emitted by execute_bash on a non-zero exit) renders RED like a
              // failed tool, instead of a uniform dim block — so the user can
              // scan the transcript for what went wrong. Tied to the exit-code
              // banner (not output text), so a command that merely prints the
              // word "Error" but exits 0 is NOT falsely flagged.
              const resultFailed = event.result.includes('═══ FAILED ═══');
              renderer.addEvent(resultFailed ? 'error' : 'tool-result', summary);
              // Remember the full result so Ctrl+O can expand it — but only
              // when the summary actually truncated (the `(ctrl+o to expand)`
              // marker promises the affordance; without truncation there's
              // nothing to expand). Keeps that promise honest.
              this.lastExpandableResult = summary.includes('(ctrl+o to expand)')
                ? { name: event.toolName, result: event.result, params }
                : null;
            }
            break;
          }

          case 'tool.error':
            if (isHitlToolName(event.toolName)) {
              hitlDepth = Math.max(0, hitlDepth - 1);
            }
            this.promptController?.setStatusMessage('Thinking…');
            if (renderer) {
              // Red `  ⎿  Error: …` line, mirroring a failed tool result.
              renderer.addEvent('error', formatToolError(event.error));
              lastToolHeaderEmitted = null;
            }
            break;

          case 'error':
            if (renderer) {
              // Compact display (no multi-KB HTML/JSON walls) + remember what
              // was shown so the catch below doesn't print it a second time —
              // the same failure also arrives as the sink rejection.
              const shown = formatErrorForDisplay(event.error);
              this.lastShownTurnError = shown;
              renderer.addEvent('error', shown);
              lastToolHeaderEmitted = null;
            }
            break;

          case 'usage': {
            // Meter cumulative Anvilwing consumption for /usage + the portal.
            recordAnvilwingUsage(event.inputTokens, event.outputTokens);
            // Snap the live `↑` estimate to the provider-exact output count
            // for this request; the meter keeps accumulating across the
            // turn's tool-loop requests.
            this.turnTokenMeter.recordExactOutput(event.outputTokens ?? 0);
            // inputTokens = exactly what occupies the context window this turn.
            // The real model window (not a hardcoded guess) is the denominator
            // so "% context left" reflects the actual model.
            const contextTokens = event.inputTokens ?? event.totalTokens ?? null;
            if (typeof contextTokens === 'number' && contextTokens > 0) {
              this.lastInputTokens = contextTokens;
            }
            const windowTokens = getModelContextInfo(this.profileConfig.model).contextWindow;
            // Window-drift self-report: the provider's prompt_tokens is REAL
            // API data — if it ever exceeds the configured window, the static
            // context table is provably stale (this exact drift hid the
            // 131k-vs-1M bug; the meter clamps to 100% so nothing else
            // surfaces it). Anvilwing's /models returns no window metadata
            // (probed), so this is the only runtime verification available.
            if (
              !this.warnedWindowDrift &&
              typeof contextTokens === 'number' && contextTokens > windowTokens
            ) {
              this.warnedWindowDrift = true;
              renderer?.addEvent('system', chalk.dim(
                `Note: the provider reports ${contextTokens.toLocaleString('en-US')} input tokens — more than the configured ${windowTokens.toLocaleString('en-US')}-token window for ${this.profileConfig.model}. The context table is likely stale; context % may be wrong.`,
              ));
            }
            this.promptController?.setMetaStatus({
              outputTokens: this.turnTokenMeter.current(),
              contextTokens,
              tokenLimit: windowTokens,
            });
            break;
          }

          case 'subagent.start':
            // A parallel sub-agent spawned — show it like Claude Code's Task.
            renderer?.addEvent('tool', formatSubAgentStart(event.description));
            this.promptController?.setStatusMessage(`Running sub-agent: ${event.description}`);
            break;

          case 'subagent.complete':
            renderer?.addEvent('system', chalk.dim(formatSubAgentComplete({
              description: event.description,
              success: event.success,
              elapsedMs: event.elapsedMs,
            })));
            break;

          case 'adversarial.findings':
            // The reviewer refuted this turn's draft — remember it so the
            // auto-continue loop can run a bounded re-fix (handled in finally).
            turnAdversarialFindings = event.findings;
            break;

          case 'context.compacted': {
            // The conversation was auto-compacted to stay within the window —
            // surface it as a dim note (Claude Code parity) instead of silently.
            renderer?.addEvent('system', chalk.dim(formatCompactionNote({
              removed: event.removed,
              freedTokens: event.freedTokens,
              summarized: event.summarized,
              percentage: event.percentage,
            })));
            break;
          }

          case 'provider.fallback': {
            // Display fallback notification
            if (renderer) {
              const fallbackMsg = chalk.yellow('⚠ ') +
                chalk.dim(`${event.fromProvider}/${event.fromModel} failed: `) +
                chalk.hex('#EF4444')(event.reason) +
                chalk.dim(' → switching to ') +
                chalk.hex('#34D399')(`${event.toProvider}/${event.toModel}`);
              renderer.addEvent('banner', fallbackMsg);
            }

            // Update the model context to reflect the new provider/model
            this.profileConfig = {
              ...this.profileConfig,
              provider: event.toProvider,
              model: event.toModel,
            };
            this.promptController?.setModelContext({
              model: event.toModel,
              provider: event.toProvider,
            });
            break;
          }

          case 'edit.explanation':
            // Show explanation for edits made
            if (event.content && renderer) {
              const filesInfo = event.files?.length ? ` (${event.files.join(', ')})` : '';
              renderer.addEvent('response', `${event.content}${filesInfo}`);
            }
            break;

        }

        // Check reasoning timeout on EVERY iteration (not just when reasoning events arrive)
        // This ensures we bail out even if events are sparse
        // Use hasReceivedResponseContent (not hasReceivedMeaningfulContent) so timeout
        // still triggers after tool calls if model just reasons without responding
        if (reasoningOnlyStartTime && !hasReceivedResponseContent) {
          const reasoningElapsed = Date.now() - reasoningOnlyStartTime;
          if (reasoningElapsed > PROMPT_REASONING_TIMEOUT_MS) {
            if (renderer) {
              renderer.addEvent('response', chalk.yellow(`\nReasoning timeout (${Math.round(reasoningElapsed / 1000)}s)\n`));
            }
            reasoningTimedOut = true;
          }
        }

        // Check if reasoning timeout was triggered - break out of event loop
        if (reasoningTimedOut) {
          // Cancel the controller too; otherwise the for-await drain
          // exits but the agent keeps producing events and side-effects
          // for the next 30+ seconds with no UI to consume them.
          try { this.controller.cancel('reasoning timeout'); } catch { /* best-effort */ }
          break;
        }
      }

      // After loop: synthesize from reasoning if no response was generated or timed out
      // This handles models like anvilwing that output thinking but empty response
      // Also handles step timeouts where the model was stuck
      // IMPORTANT: Don't add "Next steps" when only reasoning occurred - only after real work
      if (shouldSynthesizeFromReasoning({ hasReceivedResponseContent, finalResponseText: this.finalResponseText, currentResponseBuffer: this.currentResponseBuffer, reasoningBuffer })) {
        const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
        if (synthesized && renderer) {
          renderer.addEvent('stream', '\n' + synthesized);
          // Only add "Next steps" if tools were actually used (real work done)
          if (toolsUsed.length > 0) {
            const { appended } = ensureNextSteps(synthesized);
            if (appended?.trim()) {
              renderer.addEvent('stream', appended);
            }
          }
          renderer.addEvent('response', '\n');
          episodeSuccess = true;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (renderer) {
        // Same failure usually already arrived (and rendered) as the turn's
        // 'error' event — the sink queues the event BEFORE rejecting. Skip
        // the duplicate; render compactly when it really is new.
        const shown = formatErrorForDisplay(message);
        if (shown !== this.lastShownTurnError) {
          this.lastShownTurnError = shown;
          renderer.addEvent('error', shown);
        }
      }

      // Fallback: If we have reasoning content but no response was generated, synthesize one
      if (!episodeSuccess && shouldSynthesizeFromReasoning({ hasReceivedResponseContent, finalResponseText: this.finalResponseText, currentResponseBuffer: this.currentResponseBuffer, reasoningBuffer })) {
        const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
        if (synthesized && renderer) {
          renderer.addEvent('stream', '\n' + synthesized);
          renderer.addEvent('response', '\n');
          episodeSuccess = true; // Mark as partial success
        }
      }
    } finally {
      // Exit critical section - allow termination again
      exitCriticalSection();

      // Final fallback: If stream ended without message.complete but we have reasoning
      if (!episodeSuccess && shouldSynthesizeFromReasoning({ hasReceivedResponseContent, finalResponseText: this.finalResponseText, currentResponseBuffer: this.currentResponseBuffer, reasoningBuffer })) {
        const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
        if (synthesized && renderer) {
          renderer.addEvent('stream', '\n' + synthesized);
          // Only add "Next steps" if tools were actually used (real work done)
          if (toolsUsed.length > 0) {
            const { appended } = ensureNextSteps(synthesized);
            if (appended?.trim()) {
              renderer.addEvent('stream', appended);
            }
          }
          renderer.addEvent('response', '\n');
          episodeSuccess = true;
        }
      }

      // Detect a model safety refusal in the just-finished turn. When the
      // model declines the request, the request is *done* — auto-continue
      // would just resubmit "continue" and start a new spinner cycle, which
      // is what produced the stuck "Thinking… (4m N s)" timer the user saw.
      const refusedTurn = isSafetyRefusal(this.finalResponseText);
      // A turn the degeneration guard cut short (the model looped) must NOT be
      // auto-continued — re-prompting a looping model just makes it loop again.
      // End the loop like a refusal; the trimmed response (one copy + marker)
      // is already on screen. Detect it BOTH ways: the marker (when the trimmed
      // text propagated via message.complete) AND a direct loop scan (when the
      // raw streamed repetitions are still what finalResponseText holds).
      const degenerateTurn =
        wasRepetitionStopped(this.finalResponseText) ||
        detectRepetitionLoop(this.finalResponseText).looping;

      this.isProcessing = false;
      this.promptController?.setStreaming(false);
      this.promptController?.setStatusMessage(null);
      // Belt-and-suspenders: explicitly clear the activity message so the
      // "Thinking… (esc to interrupt · Ns)" line doesn't linger after the
      // final reply if setMode→stopSpinnerAnimation races with another
      // renderPrompt tick.
      this.promptController?.setActivityMessage(null);
      // Force an idle re-render so the spinner area is repainted without
      // the streaming activity line. setStreaming(false) → setMode('idle')
      // already calls renderPrompt(), but a coalesced spinner tick that
      // races with the transition can leave the last "Thinking… (Ns)"
      // frame on screen until the next event. forceRender squashes it.
      this.promptController?.forceRender();

      // Clear any transient follow-up queue UI when we return to idle.
      const r = this.promptController?.getRenderer();
      r?.setFollowUpQueueMode(false);
      r?.setQueuedPrompts([]);
      // Note: pendingPrompts may still have items if a drain just started
      // a new processPrompt; the new run will manage the list.

      // Snapshot this turn's full output (tool results + narration) BEFORE the
      // buffer is cleared — the auto-continue governor + failure registry need
      // the real error text, which the reset below would otherwise wipe.
      const combinedTurnOutput = (turnToolOutput + '\n' + this.finalResponseText).slice(-16000);
      this.currentResponseBuffer = '';

      // Autosave the conversation so /resume has something to restore. Each
      // turn updates the same snapshot in place (keyed by this.sessionId).
      this.persistSessionSnapshot();

      // Process any queued follow-up — single source of truth (drainNextQueuedPrompt).
      // This takes priority over auto-continue: a user's explicit follow-up runs
      // before the loop decides the original task is "complete".
      //
      // GUARDED: processPrompt is launched fire-and-forget (void) and the
      // global unhandledRejection handler exits the whole CLI with code 1 —
      // an exception anywhere in this post-turn pipeline (drain, completion
      // heuristics, governor, renderer calls) must degrade to an error line,
      // never kill the live session.
      try {
      if (await this.drainNextQueuedPrompt()) {
        // handled
      } else if (refusedTurn || degenerateTurn) {
        // Refusal OR a degeneration cutoff terminates the turn. Don't re-prompt
        // the model — a refusal is the final answer, and a model that just
        // looped will only loop again. Clear the stored "original prompt" so a
        // stray Alt+G later doesn't pick up where this turn left off.
        this.originalPromptForAutoContinue = null;
        if (degenerateTurn) {
          this.promptController?.getRenderer()?.addEvent('system', chalk.dim(
            'Stopped: the model was repeating itself. Tell me how to proceed, or rephrase the request.',
          ));
        }
      } else if (!this.shouldExit && !this.userInterruptedRun) {
        // Auto mode: keep running until user's prompt is fully completed.
        // Skipped after a Ctrl+C interrupt so we don't immediately resume
        // the work the user just cancelled.
        const autoMode = this.promptController?.getAutoMode() ?? 'off';
        // Suppress auto-continue in plan mode: it would only re-drive the
        // mutating-tool attempts plan mode blocks, looping to the governor
        // stall instead of leaving the proposed plan on screen for the user to
        // approve (Shift+Tab). Plan mode is a single planning pass.
        if (autoContinueAllowed(autoMode)) {
          // Check if original user prompt is fully completed
          const detector = getTaskCompletionDetector();
          const analysis = detector.analyzeCompletion(this.finalResponseText, toolsUsed);

          // Record this turn with the governor (bounds the loop + detects a
          // stall: the same tools/files/failure repeating with no new progress)
          // and the failure registry (catches the same error recurring across
          // NON-consecutive turns — a thrash the stall check would miss).
          this.autoGovernor.recordTurn({
            toolsUsed,
            filesModified,
            failingSignal: detectFailingTestOrBuild(combinedTurnOutput),
          });
          this.failureRegistry.trackTurn(combinedTurnOutput);
          const gov = this.autoGovernor.check();
          const failureNudge = this.failureRegistry.nudge();
          const todos = getCurrentTodos();
          const pending = pendingTodos(todos);

          // Completion BEFORE the governor: a final turn that finishes the
          // task must read as "Task complete" even when the same turn trips
          // the limit/stall — the old order rendered "Paused — tell me how to
          // proceed" on finished work. A quiet medium-confidence turn (the
          // detector's shouldVerify band, previously dead code) counts as done
          // when nothing changed and nothing is failing: there is no signal
          // left that another turn could act on.
          const quietDone =
            analysis.shouldVerify &&
            pending.length === 0 &&
            filesModified.length === 0 &&
            !detectFailingTestOrBuild(combinedTurnOutput);
          // A pure-TEXT turn — no tools called, no files touched, no pending
          // plan, not promising more work ("I'll…/next…"), no failing test — is
          // a CONVERSATIONAL answer (an ack, an explanation, a direct reply).
          // It is DONE when given; auto-continuing it just makes the model
          // repeat itself until the stall governor halts (Claude Code doesn't
          // churn on a conversational reply). This is the common case for a
          // question or "just acknowledge X" that needs no tools at all.
          const conversationalDone =
            toolsUsed.length === 0 &&
            pending.length === 0 &&
            filesModified.length === 0 &&
            !analysis.signals.hasIncompleteWorkIndicators &&
            !detectFailingTestOrBuild(combinedTurnOutput);
          if ((analysis.isComplete && pending.length === 0) || quietDone || conversationalDone) {
            this.promptController?.setStatusMessage('Task complete');
            setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
          } else if (gov.stop) {
            // Yield to the user WITH state instead of thrashing forever.
            const note = gov.reason === 'limit'
              ? `Paused after ${gov.turn} auto-continue turns (turn limit).${pending.length ? ` ${pending.length} task${pending.length === 1 ? '' : 's'} still pending` : ''} — say "continue" to keep going.`
              : `Paused: no new progress over the last few turns (same actions repeating).${pending.length ? ` ${pending.length} task${pending.length === 1 ? '' : 's'} pending` : ''} — say "continue" to keep going, or redirect me.`;
            this.promptController?.getRenderer()?.addEvent('system', chalk.dim(note));
            this.promptController?.setStatusMessage(null);
            // KEEP originalPromptForAutoContinue: the note promises "continue"
            // resumes this task — nulling it here broke that promise.
          } else if (turnAdversarialFindings && this.adversarialCorrectionCount < MAX_ADVERSARIAL_CORRECTIONS) {
            // The reviewer refuted this turn's draft — re-run the FULL tool loop
            // to actually fix the findings (not just show the caveat), bounded
            // by the governor + this per-request cap.
            this.adversarialCorrectionCount += 1;
            this.promptController?.setStatusMessage('Addressing reviewer findings…');
            await new Promise(resolve => setTimeout(resolve, 300));
            await this.processPrompt(buildAdversarialCorrectionPrompt(turnAdversarialFindings));
          } else {
            // Continue — completion (incl. quiet medium-confidence) and the
            // governor already returned above; pending todos force a continue
            // even if the response sounded "done".
            this.promptController?.setStatusMessage('Continuing...');
            await new Promise(resolve => setTimeout(resolve, 500));

            // Prefer the plan's next task; fall back to the response heuristic.
            // The bare-'continue' fallback is gone: a literal 'continue' was
            // indistinguishable from the USER typing "continue", which forced
            // processPrompt to skip the governor reset for real user input
            // and broke the halt note's promise.
            const base = nextTodoPrompt(todos)
              ?? this.generateAutoContinuePrompt(
                this.originalPromptForAutoContinue || '',
                combinedTurnOutput,
                toolsUsed,
              )
              ?? `IMPORTANT: continue the original task: ${(this.originalPromptForAutoContinue ?? '').slice(0, 1500) || 'finish the work above'}.`;
            // When a failure keeps recurring, lead with the change-approach nudge.
            // Keep an IMPORTANT: prefix so this counts as an auto-continue (not a
            // fresh user prompt, which would reset the governor).
            const autoPrompt = failureNudge
              ? `IMPORTANT: ${failureNudge}\n\n${base.replace(/^IMPORTANT:\s*/, '')}`
              : base;
            await this.processPrompt(autoPrompt);
          }
        }
      }
      } catch (postTurnError) {
        const msg = postTurnError instanceof Error ? postTurnError.message : String(postTurnError);
        try {
          this.promptController?.getRenderer()?.addEvent('error', formatErrorForDisplay(msg));
          this.promptController?.setStatusMessage(null);
        } catch { /* renderer down — nothing more to do */ }
      }
    }
  }

  private generateAutoContinuePrompt(originalPrompt: string, response: string, toolsUsed: string[]): string | null {
    // Audit #23: canned "Continue fixing…" keywords carried no goal text, so
    // a drifted model had nothing to re-anchor to. Every continuation now
    // restates the original request.
    const anchor = originalPrompt.trim()
      ? `\n\nOriginal request (stay anchored to it): "${originalPrompt.trim().slice(0, 1500)}"`
      : '';
    // Highest-priority signal: a test or build is currently failing
    // in the visible output. Override every other heuristic and force
    // a sharp, focused next-action prompt — the agent must drill into
    // the FIRST failure rather than declaring victory.
    const failingSignal = detectFailingTestOrBuild(response);
    if (failingSignal) {
      const noDocsInstruction = `IMPORTANT: Do NOT create markdown files, documentation, summaries, or reports.`;
      return `${noDocsInstruction} The output above shows a failing test/build (${failingSignal}). Read the FIRST failure carefully, identify the root cause, edit exactly the file(s) needed, then re-run the same test/build command to confirm. Do not stop until that command exits cleanly.${anchor}`;
    }

    // Only auto-continue for certain types of work
    const hasFileOperations = toolsUsed.some(t => ['Read', 'Write', 'Edit', 'Search', 'Grep'].includes(t));
    const hasBashOperations = toolsUsed.includes('Bash');

    if (!hasFileOperations && !hasBashOperations) {
      return null; // No meaningful work to continue
    }

    // Analyze response to determine what to do next
    const lowercaseResponse = response.toLowerCase();

    // Check for common patterns that indicate more work is needed
    if (lowercaseResponse.includes('next steps') ||
        lowercaseResponse.includes('further') ||
        lowercaseResponse.includes('additional') ||
        lowercaseResponse.includes('implement') ||
        lowercaseResponse.includes('complete') ||
        lowercaseResponse.includes('finish')) {

      // Core instruction to prevent documentation spam
      const noDocsInstruction = `IMPORTANT: Do NOT create markdown files, documentation, summaries, or reports. Focus only on the actual code/implementation work. Perform the next concrete action in the codebase.`;

      // Generate a follow-up prompt based on the original task
      if (originalPrompt.includes('fix') || originalPrompt.includes('bug')) {
        return `${noDocsInstruction} Continue fixing - edit the next file that needs changes.${anchor}`;
      } else if (originalPrompt.includes('implement') || originalPrompt.includes('add')) {
        return `${noDocsInstruction} Continue implementing - write or edit the next piece of code.${anchor}`;
      } else if (originalPrompt.includes('refactor') || originalPrompt.includes('clean')) {
        return `${noDocsInstruction} Continue refactoring - apply changes to the next file.${anchor}`;
      } else if (originalPrompt.includes('test')) {
        return `${noDocsInstruction} Continue with tests - run or fix the next test.${anchor}`;
      } else if (originalPrompt.includes('build') || originalPrompt.includes('deploy') || originalPrompt.includes('publish')) {
        return `${noDocsInstruction} Continue the build/deploy process - execute the next command.${anchor}`;
      } else {
        return `${noDocsInstruction} Continue with the original task "${originalPrompt.slice(0, 1500)}..." - perform the next action.`;
      }
    }

    return null;
  }

  private handleInterrupt(): void {
    if (!this.isProcessing) {
      return;
    }
    const renderer = this.promptController?.getRenderer();
    if (renderer) {
      renderer.addEvent('banner', chalk.yellow('Interrupted'));
    }
    // Actually cancel the in-flight controller run. Without this the
    // for-await loop in processPrompt keeps consuming events, the spinner
    // stays up, and the agent grinds through the rest of its tool loop
    // while the user sees only a "Interrupted" banner. cancel() is a no-op
    // when there's no active sink, so this is safe to call unconditionally.
    try {
      this.controller.cancel('user interrupt via Ctrl+C');
    } catch {
      // Best-effort; if the controller is already torn down the next
      // Ctrl+C will fall through to authorizedShutdown.
    }
    // Suppress the auto-continue re-launch in processPrompt's finally
    // block. Otherwise the agent immediately starts a fresh "continue"
    // cycle 500ms later and the user has to keep mashing Ctrl+C to keep
    // up. Cleared when the user submits a new prompt.
    this.userInterruptedRun = true;
  }

  /**
   * Ctrl+T — the toggles menu. One discoverable surface for the below-box
   * settings that previously needed slash commands: each row shows its live
   * on/off state, ↑↓ to move, Enter to flip. Re-opens after a flip so several
   * can be changed in a row; Esc closes. (Permission mode stays on Shift+Tab —
   * it's a 3-way cycle with its own strip, not an on/off toggle.)
   */
  private showTogglesMenu(): void {
    const controller = this.promptController;
    if (!controller?.supportsInlinePanel()) return;
    const state = controller.getModeToggleState();
    const onOff = (on: boolean) => (on ? 'on' : 'off');
    const items: MenuItem[] = [
      { id: 'auto', label: `Auto-continue   ${onOff(state.autoMode === 'on')}`, description: 'Keep working through a multi-step task without re-prompting' },
      { id: 'hitl', label: `Confirm actions ${onOff(state.hitlMode === 'on')}`, description: 'Pause for your approval before risky tool calls (HITL)' },
      { id: 'debug', label: `Debug output    ${onOff(Boolean(state.debugEnabled))}`, description: 'Show raw events and timing in the transcript' },
    ];
    controller.setMenu(items, { title: 'Toggles — ↑↓ then Enter · esc to close' }, (selected: MenuItem | null) => {
      if (!selected) return; // esc — leave state as-is
      switch (selected.id) {
        case 'auto': controller.toggleAutoContinue(); break;
        case 'hitl': controller.toggleHITL(); break;
        // applyDebugState keeps this.debugEnabled, the global logger, and the
        // controller in sync — the same path /debug uses.
        case 'debug': this.applyDebugState(!this.debugEnabled); break;
      }
      // Re-open so the user sees the new state and can flip more.
      setTimeout(() => this.showTogglesMenu(), 0);
    });
  }

  private handleAutoContinueToggle(): void {
    const autoMode = this.promptController?.getAutoMode() ?? 'off';

    this.promptController?.setStatusMessage(`Auto: ${autoMode}`);
    setTimeout(() => this.promptController?.setStatusMessage(null), 1500);

    // Reset task completion detector when entering any auto mode
    if (autoMode !== 'off') {
      const detector = getTaskCompletionDetector();
      detector.reset();
      // Clear any stored original prompt
      this.originalPromptForAutoContinue = null;
    }
  }

  private handleHITLToggle(): void {
    const mode = this.promptController?.getModeToggleState().hitlMode ?? 'off';
    getHITL().updateConfig({ autoPause: mode === 'on' });
    this.promptController?.setStatusMessage(`HITL: ${mode}`);
    setTimeout(() => this.promptController?.setStatusMessage(null), 1500);
  }

  /**
   * Render a HITL decision as an in-app menu BELOW the prompt: the question and
   * any context as a block, then the model's options plus an "Enter your own"
   * write-in — navigable with ↑↓ and Enter, the same surface as the slash
   * palette. No screen clear, no terminal handoff. Resolves with the chosen
   * option id (or the typed custom plan).
   */
  private presentHitlDecision(request: DecisionRequest): Promise<DecisionChoice> {
    return new Promise<DecisionChoice>((resolve) => {
      const controller = this.promptController;
      const r = controller?.getRenderer();
      // DISMISSAL (Esc/Ctrl+C) must be SAFE, not consent (audit #15). Map it to
      // a decline-like option (no/reject/cancel/skip) when one exists — so
      // dismissing "approve this risky op? [default: yes]" declines instead of
      // approving. Only when no such option exists (e.g. a 4-way HITL_Decision
      // with no decline) does it fall back to the model's default.
      const declineId = request.options.find((o) =>
        /^(no|n|reject|decline|cancel|skip|abort|don'?t|deny)\b/i.test(o.id) ||
        /^(no|reject|decline|cancel|skip|abort|don'?t|deny)\b/i.test(o.label),
      )?.id;
      const dismissId = declineId ?? request.defaultOptionId ?? request.options[0]?.id ?? '__custom__';
      const fallbackId = request.defaultOptionId ?? request.options[0]?.id ?? '__custom__';
      if (!controller || !r) {
        resolve({ optionId: dismissId });
        return;
      }

      // The question + context live INSIDE the bottom-anchored popup (Claude
      // Code / opencode style) rather than scrolling into history above a bare
      // menu — one compact box the user reads and answers in place.
      const body: string[] = [];
      if (request.description?.trim()) body.push(request.description.trim());
      if (request.context?.trim()) body.push(request.context.trim());

      const items: MenuItem[] = [
        ...request.options.map((o) => ({ id: o.id, label: o.label, description: o.description })),
        { id: '__custom__', label: 'Enter your own', description: 'Type a custom plan, instruction, or alternative approach' },
      ];
      // Default the cursor to the model's recommended option, if it named one.
      const initialIndex = request.defaultOptionId
        ? Math.max(0, items.findIndex((i) => i.id === request.defaultOptionId))
        : 0;

      controller.setMenu(items, {
        question: request.title,
        body: body.length ? body : undefined,
        footer: '↑↓ choose · enter select · esc cancel',
        boxed: true,
        initialIndex,
      }, (selected: MenuItem | null) => {
        if (!selected) {
          resolve({ optionId: dismissId }); // Esc → the SAFE/decline option (#15)
          return;
        }
        if (selected.id === '__custom__') {
          r.addEvent('system', chalk.cyan('Type your own plan or instruction, then Enter:'));
          void r.captureInput({ allowEmpty: false, trim: true, resetBuffer: true })
            .then((text: string) => {
              const t = (text || '').trim();
              resolve(t ? { optionId: '__custom__', customInput: t } : { optionId: fallbackId });
            })
            .catch(() => resolve({ optionId: fallbackId }));
          return;
        }
        resolve({ optionId: selected.id });
      });
    });
  }

  /**
   * Shift+Tab cycled the permission mode. The hint line under the input box
   * already shows the active mode; this surfaces a brief one-line note in
   * the chat so the change is unmistakable, matching how Claude Code echoes
   * a mode switch.
   */
  private handlePermissionModeChange(mode: string): void {
    const note = mode === 'plan'
      ? 'plan mode — read-only; I won’t edit files or run commands until you approve a plan'
      : mode === 'acceptEdits'
        ? 'accept edits on — file edits apply without the adversarial pre-flight'
        : 'default mode';
    this.promptController?.setStatusMessage(note);
    setTimeout(() => this.promptController?.setStatusMessage(null), 2500);
  }

  /**
   * Ctrl+O — expand the last truncated tool result. The `(ctrl+o to expand)`
   * marker promises this; we honor it by re-emitting the SAME tool result with
   * no line cap (a huge maxLines), appended below as a dim block. If nothing is
   * pending (the last result fit on screen), a brief status note says so rather
   * than silently doing nothing.
   */
  private handleExpandToolResult(): void {
    const last = this.lastExpandableResult;
    const renderer = this.promptController?.getRenderer();
    if (!last || !renderer) {
      this.promptController?.setStatusMessage('Nothing to expand');
      setTimeout(() => this.promptController?.setStatusMessage(null), 1500);
      return;
    }
    // Re-render the full result (no truncation). One expand per result.
    this.lastExpandableResult = null;
    renderer.addEvent('tool-result', formatToolResult(last.name, last.result, last.params, { maxLines: 100000 }));
  }

  private handleCtrlC(info: { hadBuffer: boolean }): void {
    const now = Date.now();

    // Reset count if more than 2 seconds since last Ctrl+C
    if (now - this.lastCtrlCTime > 2000) {
      this.ctrlCCount = 0;
    }

    this.lastCtrlCTime = now;
    this.ctrlCCount++;

    if (info.hadBuffer) {
      // Clear buffer, reset count
      this.ctrlCCount = 0;
      return;
    }

    // Always allow double Ctrl+C to exit, even while processing
    if (this.ctrlCCount >= 2) {
      // Use authorized shutdown to bypass anti-termination guard
      void authorizedShutdown(0);
      this.shouldExit = true;
      this.ctrlCCount = 0;
      return;
    }

    if (this.isProcessing) {
      // Interrupt processing on first Ctrl+C, then allow next Ctrl+C to exit
      this.handleInterrupt();
      const renderer = this.promptController?.getRenderer();
      if (renderer) {
        renderer.addEvent('banner', chalk.dim('Press Ctrl+C again to exit'));
      }
      return;
    }

    // First Ctrl+C when idle: show hint
    const renderer = this.promptController?.getRenderer();
    if (renderer) {
      renderer.addEvent('banner', chalk.dim('Press Ctrl+C again to exit'));
    }
  }

  private handleExit(): void {
    this.shouldExit = true;
    this.cleanupSudoPasswordHandler();
    this.promptController?.stop();
    void authorizedShutdown(0);
  }

  private waitForExit(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.shouldExit) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
}

// The --profile / -p flag was removed; the only call site passes nothing.
// We retain the function as a single source of truth for the hardcoded
// profile name that downstream config (agent prompt, model, rulebook)
// keys off of.
function resolveProfile(): ProfileName {
  return 'anvilwing-code';
}
