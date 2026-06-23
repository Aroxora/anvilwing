/**
 * InkPromptController — the CLI's prompt controller, backed by the Ink
 * renderer. Constructed via createPromptController(); it is the only
 * renderer the shell uses.
 *
 * Goal: satisfy every method that src/headless/interactiveShell.ts calls
 * so the rest of the codebase doesn't notice the swap. Live methods
 * (status, history, secret mode, menu) drive an Ink reconciler commit;
 * decorative methods that don't yet have an Ink implementation are
 * marked as TODOs and behave as no-ops, with the call recorded so
 * future hardening can fill the gaps with real behaviour rather than
 * silent drift.
 *
 * Renderer shim: interactiveShell.ts also calls a handful of methods
 * directly via promptController.getRenderer() — addEvent, addOutputTap,
 * captureInput, clearBuffer, setSecretMode, forceRender. We expose a
 * facade implementing exactly those.
 */

import { EventEmitter } from 'node:events';
import type { Writable, Readable } from 'node:stream';
import type { Instance as InkInstance } from 'ink';
import type { ChatItem } from './ChatStatic.js';
import { cyclePermissionMode, permissionHint, permissionModeStrip, permissionStatusChip } from '../../core/permissionMode.js';
import { isGenericThinking } from '../../core/thinkingVerbs.js';
import { isNearDuplicateNarration, richerNarration } from './narrationDedup.js';

// Types previously re-exported from the legacy UnifiedUIRenderer +
// PromptController. Inlined here so the Ink path stands alone — the
// legacy renderer files have been removed.
export type EditGuardMode = 'display-edits' | 'require-approval' | 'block-writes' | 'ask-permission' | 'plan';

export interface PromptCallbacks {
  onSubmit: (text: string) => void;
  onQueue: (text: string) => void;
  onInterrupt: () => void;
  onExit?: () => void;
  onCtrlC?: (info: { hadBuffer: boolean }) => void;
  onResume?: () => void;
  onChange?: (event: { text: string; cursor: number }) => void;
  onEditModeChange?: (mode: EditGuardMode) => void;
  onToggleAutoContinue?: () => void;
  onClearContext?: () => void;
  onExpandToolResult?: () => void;
  /** Fired on Esc (outside any menu/search) — interrupts a running turn. */
  onEscape?: () => void;
  /** Fired on `?` with an empty buffer — show the keyboard-shortcuts panel. */
  onShowShortcuts?: () => void;
  /** Fired on Ctrl+T — open the toggles menu (auto-continue · HITL · debug). */
  onShowToggles?: () => void;
  /** Fired on any key while a dismissable inline panel is open — dismiss it. */
  onDismissPanel?: () => void;
  onToggleHITL?: () => void;
  /** Fired after Shift+Tab cycles the permission mode, with the new mode. */
  onCyclePermissionMode?: (mode: string) => void;
}

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  category?: string;
  disabled?: boolean;
  isActive?: boolean;
}

type Mode = 'idle' | 'streaming';

interface ModeToggleState {
  autoMode: 'off' | 'on';
  autoContinueHotkey?: string;
  debugEnabled?: boolean;
  hitlMode: 'off' | 'on';
  hitlHotkey?: string;
}

/** Map RendererEventType (UnifiedUIRenderer) to ChatItem.kind. */
const EVENT_KIND_MAP: Record<string, ChatItem['kind']> = {
  banner: 'banner',
  system: 'system',
  error: 'error',
  response: 'assistant',
  stream: 'assistant',
  thought: 'system',
  tool: 'tool',
  'tool-call': 'tool',
  'tool-result': 'toolResult',
  raw: 'system',
  streaming: 'system',
};

interface RendererTap {
  (type: string, content: string): void;
}

/**
 * The minimal subset of the legacy UnifiedUIRenderer that
 * interactiveShell.ts actually calls. Backed by Ink state under the
 * hood. Method signatures match the legacy renderer exactly — the
 * caller can't tell which implementation it's holding.
 */
class InkRendererShim extends EventEmitter {
  private taps: Set<RendererTap> = new Set();
  private resolveCapture: ((value: string) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly owner: InkPromptController) {
    super();
  }

  addEvent(type: string, content: string): void {
    // Always feed the taps first — they observe the raw event stream
    // even if the type is filtered out of the visible history.
    for (const tap of this.taps) {
      try { tap(type, content); } catch { /* tap errors must not break rendering */ }
    }

    // Thoughts are the model's pre-response reasoning. Showing them as
    // plain chat lines (which my previous map did) leaks "The user
    // just said 'hi' — this is a greeting…" into the visible
    // transcript right above the actual answer. Drop them from the
    // chat surface; debug mode can re-enable later.
    if (type === 'thought' || type === 'streaming') return;

    if (type === 'stream') {
      // Coalesce streaming deltas into a single growing assistant
      // message. Pre-fix this rendered "Hi How can I help you today"
      // as one word per line because each delta became its own
      // ChatItem. Now the in-progress message lives in
      // owner._streamingText and renders in a non-Static slot above
      // the prompt; on the next non-stream event (typically the
      // 'response' completion) we commit it as a Static entry.
      this.owner._appendStreamingDelta(content);
      return;
    }

    if (type === 'response') {
      // Streaming is finishing. Replace the in-progress text with the
      // canonical final content (the streamed chunks may have lost
      // formatting under markdown wrapping) and commit to history.
      this.owner._commitStreaming(content);
      return;
    }

    // Non-streaming events: a brand-new committed history entry. Also
    // finalises any in-progress streaming message in case the model
    // emitted a tool/system event between deltas.
    this.owner._finalizeStreamingIfAny();
    const kind = EVENT_KIND_MAP[type] ?? 'system';
    this.owner._appendHistoryEntry({ id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, text: content });
  }

  addOutputTap(fn: RendererTap): () => void {
    this.taps.add(fn);
    return () => { this.taps.delete(fn); };
  }

  /**
   * Resolve the next user submission with the typed text. Used by the
   * sudo-password capture flow in interactiveShell.ts.
   *
   * Implementation: stash a resolver, swap the prompt callbacks for one
   * that resolves it, restore on submit. The owner runs setSecretMode
   * around the call site.
   */
  captureInput(_opts: { allowEmpty?: boolean; trim?: boolean; resetBuffer?: boolean } = {}): Promise<string> {
    return new Promise<string>((resolve) => {
      this.resolveCapture = resolve;
      this.owner._installCaptureHandler((text) => {
        const trim = _opts.trim !== false;
        const value = trim ? text.trim() : text;
        if (this.resolveCapture) {
          const r = this.resolveCapture;
          this.resolveCapture = null;
          this.owner._restoreSubmitHandler();
          if (_opts.resetBuffer !== false) this.owner._setBuffer('');
          r(value);
        }
      });
    });
  }

  clearBuffer(): void {
    this.owner._setBuffer('');
  }

  setSecretMode(enabled: boolean): void {
    this.owner._setSecretMode(enabled);
  }

  /** No-op. Ink owns its render loop; manual force is unnecessary. */
  forceRender(): void { /* no-op — Ink reconciler handles redraws */ }

  /** Shape parity with the legacy renderer; returns a fixed false. */
  supportsInlinePanel(): boolean { return true; }

  /**
   * Used by interactiveShell.ts when re-rendering a tool result after
   * the user expands it. Live update: append a new history entry with
   * the expanded content.
   */
  expandLastToolResult(): boolean { return false; }
  getCollapsedResultCount(): number { return 0; }

  // Live follow-up queue (Claude Code parity). interactiveShell.ts drives the
  // queue through getRenderer() (this shim), but the state lives on the owning
  // controller — proxy through so the call doesn't throw "is not a function"
  // and crash the shell when a prompt is submitted while the agent is busy.
  setFollowUpQueueMode(on: boolean): void { this.owner.setFollowUpQueueMode(on); }
  setQueuedPrompts(prompts: string[]): void { this.owner.setQueuedPrompts(prompts); }
  addUserHistoryItem(text: string): void { this.owner.addUserHistoryItem(text); }
}

export interface IPromptController extends EventEmitter {
  start(): void;
  whenReady(): Promise<void>;
  stop(): void;
  setStreaming(s: boolean): void;
  getMode(): Mode;
  setContextUsage(p: number | null): void;
  setModeToggles(opts: Partial<ModeToggleState>): void;
  setDebugMode(enabled: boolean): void;
  toggleAutoContinue(): void;
  getAutoMode(): 'off' | 'on';
  setAutoMode(m: 'off' | 'on'): void;
  toggleHITL(): void;
  getHITLMode(): 'off' | 'on';
  getModeToggleState(): Readonly<ModeToggleState>;
  setStatusMessage(message: string | null): void;
  setOverrideStatus(message: string | null): void;
  setStreamingLabel(label: string | null): void;
  setStatusLine(s: { main?: string | null; override?: string | null; streaming?: string | null }): void;
  setMetaStatus(meta: { elapsedSeconds?: number | null; outputTokens?: number | null; contextTokens?: number | null; tokenLimit?: number | null }): void;
  clearAllStatus(): void;
  setModelContext(opts: { model?: string | null; provider?: string | null }): void;
  setChromeMeta(meta: { workspace?: string; directory?: string; writes?: string; sessionLabel?: string; thinkingLabel?: string; autosave?: boolean; version?: string }): void;
  setInlinePanel(lines: string[]): void;
  clearInlinePanel(): void;
  supportsInlinePanel(): boolean;
  setPinnedPrompt(text: string | null): void;
  getPinnedPrompt(): string | null;
  clearPinnedPrompt(): void;
  setMenu(items: MenuItem[], options: { title?: string; initialIndex?: number; question?: string; body?: string[]; footer?: string; boxed?: boolean }, callback: (item: MenuItem | null) => void): void;
  closeMenu(): void;
  isMenuActive(): boolean;
  setActivityMessage(message: string | null): void;
  setCompletionFiles(files: string[]): void;
  setEditMode(mode: EditGuardMode): void;
  applyEditMode(mode: EditGuardMode): void;
  getEditMode(): EditGuardMode;
  getBuffer(): string;
  getCursor(): number;
  setBuffer(text: string, cursorPos?: number): void;
  setSecretMode(enabled: boolean): void;
  clear(): void;
  clearScreen(): void;
  render(): void;
  forceRender(): void;
  handleResize(): void;
  dispose(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRenderer(): any;
}

export class InkPromptController extends EventEmitter implements IPromptController {
  private readonly callbacks: PromptCallbacks;
  // ink module + App component imported lazily on start() so non-Ink
  // codepaths don't pay the React parse cost.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inkRender: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private React: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private AppComponent: any = null;
  private inst: InkInstance | null = null;
  private readonly shim = new InkRendererShim(this);
  private readonly stdin: Readable;
  private readonly stdout: Writable;

  // In-progress assistant message — accumulates 'stream' deltas. While
  // non-null it renders below <Static> in a regular Ink Box so the text
  // grows in place. Committed to history on 'response' (or finalised
  // when any non-stream event arrives mid-flight).
  private streamingText = '';
  // Monotonic suffix for ChatItem ids: Date.now() alone collides when several
  // entries are appended in the same millisecond (e.g. the synchronous /resume
  // replay), producing duplicate React keys in <Static>.
  private idSeq = 0;

  // ── live state ────────────────────────────────────────────────
  private statusMain: string | null = null;
  private statusOverride: string | null = null;
  private statusStreaming: string | null = null;
  private activityMessage: string | null = null;
  private mode: Mode = 'idle';
  // outputTokens drives the spinner's `↑ N tokens`; contextPercent (from
  // contextTokens/tokenLimit) drives the `% context left` chip. Two concerns,
  // never the same number.
  private metaInfo: { contextPercent?: number; sessionTime?: string; model?: string; provider?: string; workspace?: string; directory?: string; outputTokens?: number } = {};
  // ms timestamp the current spinner run began — drives the elapsed counter in
  // StatusLine. Set when the UI transitions into a spinning state, cleared when
  // it stops, so each working run reports its own elapsed time.
  private spinStart: number | null = null;
  private history: ChatItem[] = [];
  private inlinePanel: string[] | null = null;
  private secretMode = false;
  private editMode: EditGuardMode = 'display-edits';
  private pinnedPrompt: string | null = null;
  private modeToggleState: ModeToggleState = {
    autoMode: 'on',
    autoContinueHotkey: '⌥G',
    hitlMode: 'off',
    hitlHotkey: '⌥V',
  };
  private buffer = '';
  // Submitted prompts (oldest→newest) for Up/Down shell history navigation.
  private readonly promptHistory: string[] = [];
  // Workspace files (repo-relative) for @-mention autocomplete.
  private completionFiles: string[] = [];
  // Set by InkRendererShim.captureInput — temporarily replaces onSubmit.
  private captureSubmit: ((text: string) => void) | null = null;
  private menuCallback: ((item: MenuItem | null) => void) | null = null;
  private menuItems: MenuItem[] = [];

  // Live follow-up queue (Claude Code parity): when true, the onSubmit wrapper
  // skips appending the user line to permanent <Static> history. The line is
  // shown only in the transient queued region (App) until its turn is dequeued.
  // At dequeue time the shell calls addUserHistoryItem just before processPrompt.
  private followUpQueueMode = false;
  private queuedPrompts: string[] = [];
  private menuTitle?: string;
  private menuQuestion?: string;
  private menuBody?: string[];
  private menuFooter?: string;
  private menuBoxed = false;
  private menuInitialIndex?: number;
  private menuOpen = false;
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private disposed = false;
  // Resolves once Ink has finished its async mount (the dynamic ink/react/App
  // imports + first render). Callers that drive events right after start()
  // must await this, or a fast process.exit() can pre-empt the mount and the
  // first frame never reaches stdout (empty-output flake under CPU contention).
  private resolveReady!: () => void;
  private readonly readyPromise: Promise<void> = new Promise((r) => { this.resolveReady = r; });

  constructor(stdin: Readable, stdout: Writable, callbacks: PromptCallbacks) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.callbacks = callbacks;
  }

  // ── lifecycle ─────────────────────────────────────────────────

  /**
   * Async start so the Ink + React modules can be loaded via dynamic
   * import (the dist build emits ESM under `module: NodeNext`, where
   * `require()` mixed with top-level await is a hard error in Node 22+).
   * Call sites that go through createPromptController() should await
   * .start(); the legacy controller's start() is sync, so the IPrompt
   * interface defines start() as `void` and we coerce here.
   */
  start(): void { void this.startAsync(); }

  /** Resolves once Ink has mounted and rendered its first frame. */
  whenReady(): Promise<void> { return this.readyPromise; }

  private async startAsync(): Promise<void> {
    if (this.started || this.disposed) { this.resolveReady(); return; }
    this.started = true;
    try {
      const [ink, react, appMod] = await Promise.all([
        import('ink'),
        import('react'),
        import('./App.js'),
      ]);
      this.React = react;
      this.AppComponent = appMod.App;
      this.inkRender = ink.render;
      this.inst = this.inkRender(this.buildTree(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stdin: this.stdin as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stdout: this.stdout as any,
        // exitOnCtrlC=false so the host's onCtrlC callback fires first.
        exitOnCtrlC: false,
      });
    } finally {
      // Always resolve — a waiter must never hang even if mount throws.
      this.resolveReady();
    }
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    try { this.inst?.unmount(); } catch { /* ignore */ }
    this.inst = null;
  }

  dispose(): void { this.stop(); }

  /** Manual repaint hook — Ink owns its tick, so render/forceRender are coalesced into a rerender(). */
  render(): void { this.rerender(); }
  forceRender(): void { this.rerender(); }
  handleResize(): void { /* Ink subscribes to SIGWINCH itself */ }

  /**
   * Reset the chat surface (the shell's /clear). Ink's <Static> is
   * append-only — it slices items from an internal index that only grows
   * — so shrinking the history array cannot clear committed scrollback.
   * The only correct reset is to unmount, clear the terminal while Ink is
   * NOT mounted (so the escape can't desync a live render), and remount
   * with empty history; the fresh <Static> restarts at index 0.
   */
  clearScreen(): void {
    this.history = [];
    this.streamingText = '';
    if (this.inst && this.inkRender && this.React && this.AppComponent) {
      try { this.inst.unmount(); } catch { /* ignore */ }
      this.inst = null;
      // \x1b[3J also drops scrollback so the cleared content can't be scrolled to.
      try { this.stdout.write('\x1b[2J\x1b[3J\x1b[H'); } catch { /* ignore */ }
      this.inst = this.inkRender(this.buildTree(), {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stdin: this.stdin as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stdout: this.stdout as any,
        exitOnCtrlC: false,
      });
    } else {
      this.rerender();
    }
  }

  // ── status / activity / streaming ─────────────────────────────

  setStatusMessage(message: string | null): void { this.statusMain = (message?.trim() || null); this.rerender(); }
  setOverrideStatus(message: string | null): void { this.statusOverride = (message?.trim() || null); this.rerender(); }
  setStreamingLabel(label: string | null): void { this.statusStreaming = (label?.trim() || null); this.rerender(); }
  setStatusLine(status: { main?: string | null; override?: string | null; streaming?: string | null }): void {
    if ('main' in status) this.statusMain = status.main?.trim() || null;
    if ('override' in status) this.statusOverride = status.override?.trim() || null;
    if ('streaming' in status) this.statusStreaming = status.streaming?.trim() || null;
    this.rerender();
  }
  clearAllStatus(): void {
    this.statusMain = null; this.statusOverride = null; this.statusStreaming = null;
    this.activityMessage = null;
    this.rerender();
  }
  setActivityMessage(message: string | null): void { this.activityMessage = message; this.rerender(); }

  setStreaming(streaming: boolean): void { this.mode = streaming ? 'streaming' : 'idle'; this.rerender(); }
  getMode(): Mode { return this.mode; }

  setContextUsage(percentage: number | null): void {
    if (percentage !== null) { this.metaInfo.contextPercent = percentage; this.rerender(); }
  }

  setMetaStatus(meta: { elapsedSeconds?: number | null; outputTokens?: number | null; contextTokens?: number | null; tokenLimit?: number | null }): void {
    if (typeof meta.elapsedSeconds === 'number' && Number.isFinite(meta.elapsedSeconds) && meta.elapsedSeconds >= 0) {
      const m = Math.floor(meta.elapsedSeconds / 60);
      const s = meta.elapsedSeconds % 60;
      this.metaInfo.sessionTime = `${m}:${s < 10 ? '0' : ''}${s}`;
    }
    if (typeof meta.outputTokens === 'number' && Number.isFinite(meta.outputTokens) && meta.outputTokens >= 0) {
      this.metaInfo.outputTokens = meta.outputTokens;
    }
    // NaN passes a `!= null` check — a proxy that garbles prompt_tokens would
    // render "NaN% context left". Only finite inputs with a positive window
    // may update the chip.
    if (typeof meta.contextTokens === 'number' && Number.isFinite(meta.contextTokens)
      && typeof meta.tokenLimit === 'number' && Number.isFinite(meta.tokenLimit) && meta.tokenLimit > 0) {
      this.metaInfo.contextPercent = Math.round((meta.contextTokens / meta.tokenLimit) * 100);
    }
    this.rerender();
  }

  setModelContext(options: { model?: string | null; provider?: string | null }): void {
    if (options.model !== undefined) this.metaInfo.model = options.model || undefined;
    if (options.provider !== undefined) this.metaInfo.provider = options.provider || undefined;
    this.rerender();
  }

  setChromeMeta(meta: { workspace?: string; directory?: string }): void {
    if (meta.workspace !== undefined) this.metaInfo.workspace = meta.workspace;
    if (meta.directory !== undefined) this.metaInfo.directory = meta.directory;
    this.rerender();
  }

  // ── toggles ───────────────────────────────────────────────────

  setModeToggles(options: Partial<ModeToggleState>): void {
    this.modeToggleState = { ...this.modeToggleState, ...options };
    this.rerender();
  }
  setDebugMode(enabled: boolean): void { this.modeToggleState.debugEnabled = enabled; this.rerender(); }
  toggleAutoContinue(): void {
    this.modeToggleState.autoMode = this.modeToggleState.autoMode === 'off' ? 'on' : 'off';
    this.rerender();
    this.callbacks.onToggleAutoContinue?.();
  }
  getAutoMode(): 'off' | 'on' { return this.modeToggleState.autoMode; }
  setAutoMode(mode: 'off' | 'on'): void { this.modeToggleState.autoMode = mode; this.rerender(); }
  toggleHITL(): void {
    this.modeToggleState.hitlMode = this.modeToggleState.hitlMode === 'off' ? 'on' : 'off';
    this.rerender();
    this.callbacks.onToggleHITL?.();
  }
  getHITLMode(): 'off' | 'on' { return this.modeToggleState.hitlMode; }
  getModeToggleState(): Readonly<ModeToggleState> { return this.modeToggleState; }

  // ── inline panel / pinned prompt / menu ──────

  setInlinePanel(lines: string[]): void { this.inlinePanel = [...lines]; this.rerender(); }
  clearInlinePanel(): void { this.inlinePanel = null; this.rerender(); }
  supportsInlinePanel(): boolean { return true; }

  setPinnedPrompt(text: string | null): void { this.pinnedPrompt = text; this.rerender(); }
  getPinnedPrompt(): string | null { return this.pinnedPrompt; }
  clearPinnedPrompt(): void { this.pinnedPrompt = null; this.rerender(); }

  setMenu(items: MenuItem[], options: { title?: string; initialIndex?: number; question?: string; body?: string[]; footer?: string; boxed?: boolean }, callback: (item: MenuItem | null) => void): void {
    this.menuItems = items;
    this.menuCallback = callback;
    this.menuTitle = options.title;
    this.menuQuestion = options.question;
    this.menuBody = options.body;
    this.menuFooter = options.footer;
    this.menuBoxed = options.boxed ?? false;
    // Honor the caller's starting cursor (HITL passes the model's recommended
    // / safe default — e.g. approval menus open on "No"). Was accepted by the
    // signature but silently dropped, so every menu opened on index 0.
    this.menuInitialIndex = options.initialIndex;
    this.menuOpen = true;
    this.rerender();
  }
  closeMenu(): void { this.resolveMenu(null); }
  isMenuActive(): boolean { return this.menuOpen; }

  /** Close the menu and fire the stored callback exactly once. */
  private resolveMenu(item: MenuItem | null): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    const callback = this.menuCallback;
    this.menuCallback = null;
    this.menuItems = [];
    this.menuTitle = undefined;
    this.menuInitialIndex = undefined;
    this.rerender();
    if (callback) { try { callback(item); } catch { /* selection-handler errors must not break the UI */ } }
  }

  // ── input buffer ──────────────────────────────────────────────

  setSecretMode(enabled: boolean): void { this.secretMode = enabled; this.rerender(); }
  setEditMode(mode: EditGuardMode): void { this.editMode = mode; this.callbacks.onEditModeChange?.(mode); }
  applyEditMode(mode: EditGuardMode): void { this.setEditMode(mode); }
  getEditMode(): EditGuardMode { return this.editMode; }

  /**
   * The input buffer in the Ink path is owned by the Prompt component,
   * not by this controller. We keep `this.buffer` as a snapshot for
   * legacy callers asking for getBuffer/getCursor; updates flow when the
   * Prompt's onSubmit / clear actions fire. setBuffer drives a new
   * `initial` prop on the next mount.
   */
  getBuffer(): string { return this.buffer; }
  getCursor(): number { return this.buffer.length; }
  setBuffer(text: string, _cursorPos?: number): void { this.buffer = text; this.rerender(); }
  clear(): void { this.buffer = ''; this.rerender(); }

  // Live follow-up queue support (see followUpQueueMode comment above)
  setFollowUpQueueMode(on: boolean): void { this.followUpQueueMode = !!on; this.rerender(); }
  setQueuedPrompts(prompts: string[]): void { this.queuedPrompts = Array.isArray(prompts) ? prompts.slice() : []; this.rerender(); }
  setCompletionFiles(files: string[]): void { this.completionFiles = Array.isArray(files) ? files : []; this.rerender(); }
  addUserHistoryItem(text: string): void {
    const t = (text || '').trim();
    if (!t) return;
    this.history = [...this.history, { id: `u-${Date.now()}-q-${this.idSeq++}`, kind: 'user', text: t }];
    this.rerender();
  }

  // ── renderer facade ───────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRenderer(): any { return this.shim; }

  // ── internal ──────────────────────────────────────────────────

  /** Append history (used by the renderer shim's addEvent). */
  _appendHistoryEntry(item: ChatItem): void {
    this.history = [...this.history, item];
    this.rerender();
  }

  /**
   * Streaming accumulators. Deltas append to streamingText, which App
   * renders live as the dynamic region below ChatStatic (<Static>). The
   * old duplication bug — partial text orphaned in scrollback when a
   * Static item appended below it — cannot recur: ChatStatic is the ONLY
   * Static node and renders first, so nothing Static ever appends below
   * the live region, and _commitStreaming pushes history + clears
   * streamingText in a single atomic rerender.
   */
  _appendStreamingDelta(delta: string): void {
    this.streamingText = (this.streamingText || '') + (delta || '');
    // COALESCE rerenders. A rerender per delta was O(n²) over the growing
    // text — React/Ink reconciled the full accumulated message on every SSE
    // chunk (measured: >2s main-thread CPU per ~6KB streamed, event loop
    // ~70% busy → laggy keystrokes and Esc while the model streams). One
    // flush per ~33ms frame is imperceptible and ~3× cheaper; the text
    // itself accumulates immediately, so commit/finalize semantics and
    // anything reading streamingText stay exact.
    if (this.streamFlushTimer) return;
    const t = setTimeout(() => {
      this.streamFlushTimer = null;
      this.rerender();
    }, 33);
    // Don't let a pending paint hold the process open on exit.
    (t as { unref?: () => void }).unref?.();
    this.streamFlushTimer = t;
  }

  /** Cancel a pending coalesced stream paint (the caller is about to commit
   *  + rerender atomically — a stale timer would just waste a reconcile). */
  private clearStreamFlush(): void {
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
  }

  _commitStreaming(finalText: string): void {
    this.clearStreamFlush();
    // The real delta path ends with addEvent('response', '\n') — the body
    // lives in the accumulated streamingText, NOT in finalText. The
    // non-delta path carries the full text in finalText with an empty
    // streamingText. A tools run emits a "Next steps" addendum as a
    // distinct response. So: commit the buffered body if present, then
    // commit finalText — _pushAssistant collapses it into the body when the
    // canonical text is just the streamed body with its punctuation restored.
    const incoming = (finalText || '').trim();
    const buffered = (this.streamingText || '').trim();
    this.streamingText = '';
    if (buffered) this._pushAssistant(buffered);
    if (incoming) this._pushAssistant(incoming);
    // Single rerender: ChatStatic gains the entries AND the live region
    // (streamingMessage) goes null in the same commit — atomic swap, no
    // duplicate of the streamed body in scrollback.
    this.rerender();
  }

  _finalizeStreamingIfAny(): void {
    this.clearStreamFlush();
    if (!this.streamingText) return;
    const text = this.streamingText.trim();
    this.streamingText = '';
    if (text) this._pushAssistant(text);
    // No rerender — the caller is about to push another history entry
    // and rerender once. Avoid the double commit.
  }

  /**
   * Append assistant narration, collapsing a near-duplicate into one richer
   * entry. The streamed body and the provider's canonical message.complete are
   * often the same sentence differing only in punctuation; appending both
   * glues a visible duplicate ("…upgrade planI'll start…").
   *
   * Dedups against the most recent ASSISTANT entry, SCANNING BACK PAST
   * interleaved tool/toolResult/system entries. The old code only looked at
   * history[length-1]: on a long turn the model re-streams the same opening
   * body and each tool.start flushes it via _finalizeStreamingIfAny, but the
   * tool entry committed between two bodies made last.kind !== 'assistant', so
   * the dedup was skipped and ~30 identical ⏺ blocks stacked. Scanning back to
   * the last assistant entry (bounded) restores the collapse without disturbing
   * the interleaved tool/result entries.
   */
  private _pushAssistant(text: string): void {
    const t = (text || '').trim();
    if (!t) return;
    // Walk back to the NEAREST assistant entry, skipping interleaved
    // tool/toolResult/system entries (the SCAN_CAP is a pathological-history
    // safety valve, not a tuning knob — in practice only a few tool entries
    // sit between two re-streamed bodies, so the loop stops fast). We compare
    // ONLY against that nearest assistant entry: a dup collapses in place; a
    // non-dup means this is genuinely new narration. This is what keeps a
    // re-streamed body from stacking once per tool call.
    const SCAN_CAP = 100;
    const start = this.history.length - 1;
    const floor = Math.max(0, start - SCAN_CAP);
    for (let i = start; i >= floor; i--) {
      const entry = this.history[i];
      if (!entry || entry.kind !== 'assistant') continue;
      if (isNearDuplicateNarration(entry.text, t)) {
        const keep = richerNarration(entry.text, t);
        if (keep !== entry.text) {
          this.history = [...this.history.slice(0, i), { ...entry, text: keep }, ...this.history.slice(i + 1)];
        }
        return;
      }
      break; // the nearest assistant entry isn't a dup → this is new narration
    }
    this.history = [...this.history, { id: `r-${Date.now()}-${this.idSeq++}`, kind: 'assistant', text: t }];
  }

  /** Shift+Tab from the Prompt: advance the permission mode and repaint. */
  private cyclePermissionModeFromUI(): void {
    const next = cyclePermissionMode();
    this.rerender();
    this.callbacks.onCyclePermissionMode?.(next);
  }

  _setBuffer(text: string): void { this.buffer = text; this.rerender(); }
  _setSecretMode(enabled: boolean): void { this.secretMode = enabled; this.rerender(); }

  _installCaptureHandler(handler: (text: string) => void): void { this.captureSubmit = handler; this.rerender(); }
  _restoreSubmitHandler(): void { this.captureSubmit = null; this.rerender(); }

  /**
   * Cancel an in-flight captureInput (sudo password / HITL write-in) on
   * Esc/Ctrl+C. Resolves the pending capture promise with '' so the host's
   * existing falsy branch runs (provideSudoPassword(null), HITL fallback),
   * and drops secret mode so typing un-masks. Returns true when a capture
   * was cancelled (callers stop there — the keypress is consumed). Without
   * this, a stale capture silently swallowed the user's NEXT chat message,
   * delivering it as the sudo password (and caching it for 5 minutes).
   */
  cancelCaptureIfActive(): boolean {
    const pending = this.captureSubmit;
    if (!pending) return false;
    this.captureSubmit = null;
    this.secretMode = false;
    this.buffer = '';
    this.rerender();
    try { pending(''); } catch { /* capture resolution must not break input */ }
    return true;
  }

  private rerender(): void {
    if (!this.inst) return;
    try { this.inst.rerender(this.buildTree()); } catch { /* swallow rerender races */ }
  }

  private buildTree() {
    const composedStatus = this.statusOverride
      || (this.mode === 'streaming' ? this.statusStreaming : null)
      || this.activityMessage
      || this.statusMain;
    const modeChips = this.formatModeChips();
    const spinning = this.mode === 'streaming' || Boolean(this.activityMessage);
    const thinkingGerund = spinning && isGenericThinking(composedStatus);
    // Stamp the start of a working run on the rising edge; clear it when the
    // spinner stops so the next run's elapsed counter restarts from zero.
    if (spinning) {
      if (this.spinStart == null) this.spinStart = Date.now();
    } else {
      this.spinStart = null;
    }
    return this.React!.createElement(this.AppComponent!, {
      history: this.history,
      streamingMessage: this.streamingText || null,
      status: {
        message: composedStatus,
        spinning,
        startTime: this.spinStart,
        tokensUsed: this.metaInfo.outputTokens ?? null,
        thinkingGerund,
      },
      inlinePanel: this.inlinePanel && this.inlinePanel.length ? this.inlinePanel : undefined,
      permissionStrip: permissionModeStrip(),
      permissionHint: permissionHint(),
      metaLine: modeChips,
      queuedPrompts: this.queuedPrompts.length ? this.queuedPrompts : undefined,
      menu: this.menuOpen ? {
        items: this.menuItems,
        title: this.menuTitle,
        question: this.menuQuestion,
        body: this.menuBody,
        footer: this.menuFooter,
        boxed: this.menuBoxed,
        initialIndex: this.menuInitialIndex,
        onSelect: (item: MenuItem) => this.resolveMenu(item),
        onCancel: () => this.resolveMenu(null),
      } : undefined,
      prompt: {
        initial: this.buffer,
        secret: this.secretMode,
        onSubmit: (text: string) => {
          if (this.captureSubmit) {
            this.captureSubmit(text);
            return;
          }
          // Commit the user's submitted text into history before
          // dispatching to the host. The legacy renderer auto-emitted
          // an 'addEvent("prompt", text)' on its own submit path; the
          // Ink path didn't, so submitted prompts vanished from the
          // chat surface. Symptom: user typed "hi", saw the agent
          // respond, but their own "hi" was never in the transcript.
          // Skip secret submissions (passwords) and slash commands —
          // both are interpreted by the host, not user-visible
          // history. Keeps history aligned with what the agent saw.
          //
          // For live follow-up queue (while isProcessing): we *skip* the
          // permanent history append. The text lives only in the transient
          // queuedPrompts region (App) until the shell dequeues it and calls
          // addUserHistoryItem right before starting its turn. This
          // guarantees the response always appears immediately after its
          // triggering user line (correct ordering, no clumping).
          //
          // ORDERING MATTERS: the host's queue branch sets
          // followUpQueueMode SYNCHRONOUSLY inside onSubmit, so the append
          // decision must come AFTER the callback. The old append-first
          // order meant the FIRST follow-up of a busy turn (flag not yet
          // set) was committed immediately AND re-added at dequeue — a
          // duplicate user bubble, with the first copy mid-stream in the
          // wrong position.
          const trimmed = text.trim();
          // Record into the Up/Down shell history (skip secrets + consecutive
          // dupes; cap to keep it bounded).
          if (!this.secretMode && trimmed && this.promptHistory[this.promptHistory.length - 1] !== trimmed) {
            this.promptHistory.push(trimmed);
            if (this.promptHistory.length > 200) this.promptHistory.shift();
          }
          this.buffer = '';
          this.rerender();
          this.callbacks.onSubmit(text);
          if (!this.secretMode && trimmed && !trimmed.startsWith('/')) {
            if (!this.followUpQueueMode) {
              this.history = [
                ...this.history,
                { id: `u-${Date.now()}-${this.idSeq++}`, kind: 'user', text: trimmed },
              ];
              this.rerender();
            }
          }
        },
        onExit: () => this.callbacks.onExit?.(),
        onCancel: () => {
          // Esc/Ctrl+C during an in-flight captureInput (sudo password, HITL
          // write-in) must CANCEL the capture, not leak it: a stale capture
          // silently swallowed the user's next chat message — it never
          // reached the agent or the transcript and was delivered as the
          // sudo password (and cached). Resolve with '' (the hosts' falsy
          // branches map it to "no password" / fallback) and stop here.
          if (this.cancelCaptureIfActive()) return;
          this.callbacks.onCtrlC?.({ hadBuffer: this.buffer.length > 0 });
          this.callbacks.onInterrupt();
        },
        onCyclePermissionMode: () => this.cyclePermissionModeFromUI(),
        onExpandToolResult: () => this.callbacks.onExpandToolResult?.(),
        onEscape: () => {
          if (this.cancelCaptureIfActive()) return;
          this.callbacks.onEscape?.();
        },
        onShowShortcuts: () => this.callbacks.onShowShortcuts?.(),
        onShowToggles: () => this.callbacks.onShowToggles?.(),
        panelOpen: Boolean(this.inlinePanel && this.inlinePanel.length),
        onDismissPanel: () => this.callbacks.onDismissPanel?.(),
        history: this.promptHistory,
        completionFiles: this.completionFiles,
      },
    });
  }

  /**
   * The dim meta line under the toggle-modes strip (below the input box).
   * Claude Code keeps this minimal and emoji-free: product, model, context
   * left, then active toggles. The cwd and elapsed time deliberately don't
   * live here (cwd is in the welcome box; elapsed rides the spinner).
   */
  private formatModeChips(): string | null {
    const parts: string[] = ['anvilwing'];
    const meta = this.metaInfo;
    if (meta.model) parts.push(meta.model);
    if (meta.contextPercent != null) {
      const left = Math.max(0, 100 - meta.contextPercent);
      parts.push(`${left}% context left`);
    }
    const permChip = permissionStatusChip();
    if (permChip) parts.push(permChip);
    if (this.modeToggleState.autoMode === 'on') parts.push('auto');
    if (this.modeToggleState.hitlMode === 'on') parts.push('HITL');
    if (this.modeToggleState.debugEnabled) parts.push('debug');
    if (this.pinnedPrompt) parts.push(this.pinnedPrompt.slice(0, 40));
    // The inline panel now renders as its own block (see App.inlinePanel); it
    // no longer leaks its first line into the meta chips.
    return parts.length ? parts.join(' · ') : null;
  }
}

/**
 * Factory — returns the Ink-backed controller. Ink is now the only
 * renderer; the legacy UnifiedUIRenderer + PromptController have been
 * removed. interactiveShell.ts exits early on non-TTY so Ink's
 * raw-mode requirement is always satisfied here. Plain mode
 * (NO_COLOR / TERM=dumb) still flows through Ink — Ink itself
 * down-styles when colours are disabled.
 */
export async function createPromptController(
  stdin: Readable,
  stdout: Writable,
  callbacks: PromptCallbacks,
): Promise<IPromptController> {
  return new InkPromptController(stdin, stdout, callbacks);
}
