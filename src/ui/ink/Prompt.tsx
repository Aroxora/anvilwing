/**
 * Prompt — Ink-rendered input box.
 *
 * Phase 2 of the Ink migration. Real text input via React reducer + Ink's
 * useInput. The reducer is the single source of truth for buffer + cursor;
 * keystrokes dispatch actions; Ink's reconciler renders. Frame coalescing,
 * visual-column handling, and resize bookkeeping are owned by Ink.
 *
 * Render contract: this component is the only writer for the prompt row.
 * No `process.stdout.write` side-effects — submission and cancellation
 * surface through the `onSubmit` / `onCancel` props so the host can pipe
 * to the existing event bus.
 *
 * Paste sanitization mirrors UnifiedUIRenderer.sanitizePasteContent: ANSI
 * escapes, raw C0 control bytes, and bracketed-paste markers are stripped
 * at intake (issues #3 + #8). The sanitizer runs on every batch of text
 * Ink hands us, so a malicious paste can't survive into the buffer.
 */

import React, { useReducer, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { activeMentionPartial, rankFileMatches, applyMentionCompletion } from '../../core/fileMentions.js';
import { activeSlashPartial, rankCommandMatches, applySlashCompletion, type SlashCommand } from '../../core/slashCommands.js';
import { PasteRegistry, pasteLineCount } from './pasteBuffer.js';

export interface PromptProps {
  initial?: string;
  prefix?: string;
  /** Hide the buffer (password mode). */
  secret?: boolean;
  /** Called with the final buffer when the user presses Enter. */
  onSubmit: (text: string) => void;
  /** Called when the user presses Ctrl+C with an empty buffer. */
  onCancel: () => void;
  /** Ctrl+D on an empty buffer — exit the shell (readline/Claude Code parity). */
  onExit?: () => void;
  /** Called on Shift+Tab — cycles the permission mode (default → acceptEdits → plan). */
  onCyclePermissionMode?: () => void;
  /** Submitted prompts, oldest→newest. Up/Down navigate it (shell history). */
  history?: string[];
  /** Called on Ctrl+O — expand the last truncated tool result. */
  onExpandToolResult?: () => void;
  /** Called on Esc (when no menu/search is open) — interrupts a running turn. */
  onEscape?: () => void;
  /** Called when `?` is pressed on an empty buffer — show the shortcuts panel. */
  onShowShortcuts?: () => void;
  /** Called on Ctrl+T — open the toggles menu (auto-continue, HITL, debug). */
  onShowToggles?: () => void;
  /** True while a dismissable inline panel (/help, /cost, …) is on screen. */
  panelOpen?: boolean;
  /** Called when any key is pressed while a panel is open — dismiss it. */
  onDismissPanel?: () => void;
  /** Workspace files (repo-relative) for @-mention autocomplete. */
  completionFiles?: string[];
}

interface State {
  text: string;
  cursor: number;
}

type Action =
  | { type: 'insert'; text: string }
  | { type: 'insertRaw'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'killToStart' }
  | { type: 'killToEnd' }
  | { type: 'killWordBack' }
  | { type: 'set'; text: string; cursor?: number };

function sanitize(text: string): string {
  if (!text) return '';
  // Full ANSI sequences (with the \x1b prefix intact).
  let s = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g, '');
  // Ink's parseKeypress sometimes splits a chunk such that the \x1b is
  // consumed but the body lands in the next input string (e.g. "[2J" or
  // "[201~"). Strip those leaked CSI bodies too. The pattern matches the
  // standard CSI body shape; legitimate user text rarely matches.
  s = s.replace(/\[[0-9;?]*[A-Za-z~]/g, '');
  s = s.replace(/\r\n/g, '\n');
  // Strip C0 controls EXCEPT the ones the walk-loop in useInput acts on:
  //   \x01 (Ctrl+A) → home, \x03 (Ctrl+C) → cancel, \x05 (Ctrl+E) → end,
  //   \x09 (tab, accepted as text), \x0a (\n) → submit, \x0d (\r) → submit.
  // Everything else is hostile (NUL, BEL, BS, VT, FF, etc.).
  s = s.replace(/[\x00\x02\x04\x06\x07\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return s;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'insert': {
      const clean = sanitize(action.text);
      if (!clean) return state;
      const before = state.text.slice(0, state.cursor);
      const after = state.text.slice(state.cursor);
      return { text: before + clean + after, cursor: state.cursor + clean.length };
    }
    // Internally-generated, already-safe text (the paste placeholder token).
    // The token starts with `[P`, which the leaked-CSI-body stripper in
    // sanitize() would mangle, so it must skip that pass.
    case 'insertRaw': {
      if (!action.text) return state;
      const before = state.text.slice(0, state.cursor);
      const after = state.text.slice(state.cursor);
      return { text: before + action.text + after, cursor: state.cursor + action.text.length };
    }
    case 'backspace': {
      if (state.cursor === 0) return state;
      const before = state.text.slice(0, state.cursor - 1);
      const after = state.text.slice(state.cursor);
      return { text: before + after, cursor: state.cursor - 1 };
    }
    case 'delete': {
      if (state.cursor >= state.text.length) return state;
      const before = state.text.slice(0, state.cursor);
      const after = state.text.slice(state.cursor + 1);
      return { text: before + after, cursor: state.cursor };
    }
    case 'left':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'right':
      return { ...state, cursor: Math.min(state.text.length, state.cursor + 1) };
    case 'home':
      return { ...state, cursor: 0 };
    case 'end':
      return { ...state, cursor: state.text.length };
    case 'killToStart':
      // Ctrl+U — delete everything left of the cursor.
      return { text: state.text.slice(state.cursor), cursor: 0 };
    case 'killToEnd':
      // Ctrl+K — delete from the cursor to end of line.
      return { text: state.text.slice(0, state.cursor), cursor: state.cursor };
    case 'killWordBack': {
      // Ctrl+W — delete the whitespace + word immediately left of the cursor.
      if (state.cursor === 0) return state;
      let i = state.cursor;
      while (i > 0 && /\s/.test(state.text[i - 1]!)) i--;
      while (i > 0 && !/\s/.test(state.text[i - 1]!)) i--;
      return { text: state.text.slice(0, i) + state.text.slice(state.cursor), cursor: i };
    }
    case 'set':
      return { text: action.text, cursor: action.cursor ?? action.text.length };
    default:
      return state;
  }
}

export const Prompt: React.FC<PromptProps> = ({ initial = '', prefix = '> ', secret = false, onSubmit, onCancel, onExit, onCyclePermissionMode, history, onExpandToolResult, onEscape, onShowShortcuts, onShowToggles, panelOpen, onDismissPanel, completionFiles }) => {
  // Source of truth lives in a ref, not React state. useReducer's state
  // commit is deferred to the next render; Ink can fire useInput multiple
  // times in the same JS turn (parseKeypress splits a chunk into N
  // events), and every closure would read the same stale state. Apply
  // the reducer synchronously to the ref, then force a re-render so the
  // UI catches up. The bumper is the only useState-style hook needed.
  const stateRef = useRef<State>({ text: initial, cursor: initial.length });
  const [, bumpRender] = useReducer((n: number) => n + 1, 0);
  // Shell history navigation. index === -1 means "current draft" (not in
  // history); 0 is the newest entry, increasing toward older. `draft` holds
  // the in-progress buffer saved when nav starts, restored on Down past newest.
  const histRef = useRef<{ index: number; draft: string }>({ index: -1, draft: '' });
  // Ctrl+R reverse-i-search. While active, typed chars build `query`; the
  // buffer mirrors the `idx`-th history entry containing it (0 = newest match,
  // Ctrl+R steps older). `saved` is the pre-search buffer, restored on cancel.
  const searchRef = useRef<{ active: boolean; query: string; idx: number; saved: string }>({ active: false, query: '', idx: 0, saved: '' });
  // @-mention completion menu. idx = highlighted match; partialFor tracks the
  // partial the idx belongs to (reset on change); dismissedFor is the partial
  // the user pressed Esc on (re-opens when the partial changes).
  const compRef = useRef<{ idx: number; partialFor: string | null; dismissedFor: string | null }>({ idx: 0, partialFor: null, dismissedFor: null });
  // `/`-command completion menu — same shape/UX as the @-mention menu above.
  const slashRef = useRef<{ idx: number; partialFor: string | null; dismissedFor: string | null }>({ idx: 0, partialFor: null, dismissedFor: null });
  // Large-paste registry: a multi-line paste collapses to a placeholder token
  // in the buffer; `submit` re-expands it so the model gets the full text.
  const pasteRef = useRef<PasteRegistry>(new PasteRegistry());
  // Expand any collapsed pastes before handing the buffer to the host, then
  // reset the registry for the next composition.
  const submit = (raw: string): void => {
    onSubmit(pasteRef.current.expand(raw));
    pasteRef.current.clear();
  };

  // @-mention completion state from the LIVE buffer. Called in useInput (so it
  // never reads a stale render-time capture) and in the render (to draw the
  // menu). Idempotent: re-resets idx only when the partial actually changes.
  const completion = (): { partial: string | null; matches: string[]; open: boolean } => {
    const partial = activeMentionPartial(stateRef.current.text, stateRef.current.cursor);
    const matches = partial !== null ? rankFileMatches(partial, completionFiles ?? [], 6) : [];
    const c = compRef.current;
    if (partial !== c.partialFor) {
      c.partialFor = partial;
      c.idx = 0;
      if (c.dismissedFor !== partial) c.dismissedFor = null;
    }
    return { partial, matches, open: matches.length > 0 && c.dismissedFor !== partial };
  };

  // `/`-command completion state from the LIVE buffer (mirrors completion()).
  const slashCompletion = (): { partial: string | null; matches: SlashCommand[]; open: boolean } => {
    const partial = activeSlashPartial(stateRef.current.text, stateRef.current.cursor);
    const matches = partial !== null ? rankCommandMatches(partial, 8) : [];
    const c = slashRef.current;
    if (partial !== c.partialFor) {
      c.partialFor = partial;
      c.idx = 0;
      if (c.dismissedFor !== partial) c.dismissedFor = null;
    }
    return { partial, matches, open: matches.length > 0 && c.dismissedFor !== partial };
  };

  // Sync the ref to externally-driven `initial` changes. The ref is
  // only initialised once on mount, so when the host clears the buffer
  // after a submit (sets `initial=''` via prop) the ref still holds
  // the old text and the prompt keeps showing it. Watching `initial`
  // here resets the ref whenever it transitions to a new value the
  // user didn't type — the typical case is buffer clearing after
  // submit. We don't reset when `initial` matches what's already in
  // the ref so user keystrokes between renders aren't clobbered.
  useEffect(() => {
    if (initial !== stateRef.current.text) {
      stateRef.current = { text: initial, cursor: initial.length };
      // The buffer was replaced from outside (typically cleared after submit);
      // any collapsed-paste tokens left in the old buffer are now stale.
      pasteRef.current.clear();
      bumpRender();
    }
  }, [initial]);

  const apply = (action: Action): void => {
    stateRef.current = reducer(stateRef.current, action);
    bumpRender();
  };

  useInput((input, key) => {
    if (process.env['ANVILWING_INK_DEBUG'] === '1') {
      process.stderr.write(`KEY: input=${JSON.stringify(input)} ret=${key.return} bs=${key.backspace} ctrl=${key.ctrl} tab=${key.tab} shift=${key.shift}\n`);
    }
    // A dismissable panel (/help, /cost, …) is up: any key dismisses it and is
    // consumed (honors the "press any key to dismiss" hint). Claude Code parity.
    // Esc is the exception — it must ALSO reach the interrupt/cancel path: while
    // a turn runs the status line promises "esc to interrupt", so dismissing a
    // panel must not swallow that. onEscape no-ops when idle (handleInterrupt
    // guards on isProcessing) and cancels an active capture first, so firing it
    // here is safe in every state.
    if (panelOpen) { onDismissPanel?.(); if (key.escape) onEscape?.(); return; }
    const hist = history ?? [];
    // Reverse-i-search (Ctrl+R) owns input while active. Newest→oldest matches
    // of `query`; the buffer mirrors the current match.
    const reverseMatches = (q: string): string[] => {
      if (!q) return [];
      const out: string[] = [];
      for (let i = hist.length - 1; i >= 0; i--) if (hist[i]!.includes(q)) out.push(hist[i]!);
      return out;
    };
    const s = searchRef.current;
    if (s.active) {
      const showMatch = (): void => {
        const ms = reverseMatches(s.query);
        if (ms.length) { s.idx = Math.min(s.idx, ms.length - 1); apply({ type: 'set', text: ms[s.idx]! }); }
        else { s.idx = 0; apply({ type: 'set', text: '' }); }
      };
      if (key.return) {
        s.active = false;
        const text = stateRef.current.text;
        apply({ type: 'set', text: '', cursor: 0 });
        submit(text);
        return;
      }
      if (key.escape || (key.ctrl && (input === 'g' || input === 'G')) || (key.ctrl && (input === 'c' || input === 'C'))) {
        s.active = false;
        apply({ type: 'set', text: s.saved }); // cancel — restore the pre-search buffer
        return;
      }
      if (key.ctrl && (input === 'r' || input === 'R')) { s.idx += 1; showMatch(); return; }
      if (key.backspace || key.delete) { s.query = s.query.slice(0, -1); s.idx = 0; showMatch(); return; }
      // A printable character refines the query. Control/navigation keys
      // accept the current match and leave search so the user can edit it.
      const clean = input ? sanitize(input) : '';
      if (clean && !key.ctrl && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        s.query += clean; s.idx = 0; showMatch(); return;
      }
      s.active = false; bumpRender(); return;
    }

    // Shift+Tab (CSI \x1b[Z → key.tab && key.shift) cycles the permission
    // mode. Caught before any text path so the escape never lands as text.
    if (key.tab && key.shift) {
      onCyclePermissionMode?.();
      return;
    }
    if (key.ctrl && (input === 'r' || input === 'R')) {
      searchRef.current = { active: true, query: '', idx: 0, saved: stateRef.current.text };
      bumpRender();
      return;
    }
    // `/`-command palette. Open when the buffer is a `/<partial>` first token
    // with matches and wasn't Esc-dismissed. UX matches Claude Code: ↑/↓ move,
    // Esc dismisses, Tab fills (`/command ` — for commands that take an arg),
    // and Enter RUNS the highlighted command (completing the partial first, so
    // `/cont`+Enter or an arrow-selected entry runs the right command — not the
    // raw partial). Anchored at the buffer start so it never overlaps an
    // @-mention (which needs a space before the @).
    {
      const sc = slashCompletion();
      if (sc.open) {
        const pick = sc.matches[Math.min(slashRef.current.idx, sc.matches.length - 1)]!;
        if (key.return) {
          const r = applySlashCompletion(stateRef.current.text, stateRef.current.cursor, pick.command);
          slashRef.current.partialFor = null; slashRef.current.dismissedFor = null;
          apply({ type: 'set', text: '', cursor: 0 });
          onSubmit(r.text.trimEnd());
          return;
        }
        if (key.tab && !key.shift) {
          const r = applySlashCompletion(stateRef.current.text, stateRef.current.cursor, pick.command);
          slashRef.current.partialFor = null; slashRef.current.dismissedFor = null;
          apply({ type: 'set', text: r.text, cursor: r.cursor });
          return;
        }
        if (key.upArrow) { slashRef.current.idx = Math.max(0, slashRef.current.idx - 1); bumpRender(); return; }
        if (key.downArrow) { slashRef.current.idx = Math.min(sc.matches.length - 1, slashRef.current.idx + 1); bumpRender(); return; }
        if (key.escape) { slashRef.current.dismissedFor = sc.partial; bumpRender(); return; }
      }
    }
    // @-mention completion menu. Open when an @<partial> at the cursor has
    // matches and wasn't Esc-dismissed. Owns Tab/Enter (accept), Up/Down
    // (move highlight), Esc (dismiss). Typing/backspace fall through to refine.
    {
      const comp = completion();
      if (comp.open) {
        const pick = comp.matches[Math.min(compRef.current.idx, comp.matches.length - 1)]!;
        if ((key.tab && !key.shift) || key.return) {
          const r = applyMentionCompletion(stateRef.current.text, stateRef.current.cursor, pick);
          compRef.current.partialFor = null; compRef.current.dismissedFor = null;
          apply({ type: 'set', text: r.text, cursor: r.cursor });
          return;
        }
        if (key.upArrow) { compRef.current.idx = Math.max(0, compRef.current.idx - 1); bumpRender(); return; }
        if (key.downArrow) { compRef.current.idx = Math.min(comp.matches.length - 1, compRef.current.idx + 1); bumpRender(); return; }
        if (key.escape) { compRef.current.dismissedFor = comp.partial; bumpRender(); return; }
      }
    }
    // Up/Down — shell history navigation (per session). Older on Up, newer on
    // Down; Down past the newest restores the saved draft. (`hist` is declared
    // at the top of this handler for the reverse-search block above.)
    if (key.upArrow) {
      if (hist.length === 0) return;
      const h = histRef.current;
      if (h.index === -1) h.draft = stateRef.current.text;
      h.index = Math.min(h.index + 1, hist.length - 1);
      apply({ type: 'set', text: hist[hist.length - 1 - h.index] ?? '' });
      return;
    }
    if (key.downArrow) {
      const h = histRef.current;
      if (h.index <= 0) {
        if (h.index === 0) { h.index = -1; apply({ type: 'set', text: h.draft }); }
        return;
      }
      h.index -= 1;
      apply({ type: 'set', text: hist[hist.length - 1 - h.index] ?? '' });
      return;
    }
    // Any other key is an edit/action — exit history navigation so the next
    // Up starts from the current buffer again.
    histRef.current.index = -1;
    if (key.return) {
      const text = stateRef.current.text;
      // Multi-line input (Claude Code parity): Option/Alt+Enter inserts a
      // newline at the cursor, and a line ending in a backslash continues onto
      // the next line (the trailing `\` becomes the newline). Either keeps
      // editing instead of submitting.
      if (key.meta) { apply({ type: 'insert', text: '\n' }); return; }
      if (text.endsWith('\\')) { apply({ type: 'set', text: text.slice(0, -1) + '\n', cursor: text.length }); return; }
      // Clear our own buffer on submit. The text lives in stateRef (typed
      // keystrokes), not in the `initial` prop — for typed input the host's
      // buffer stays '' the whole time, so the `initial` useEffect never
      // re-fires and can't clear us. Without this self-clear, every submitted
      // message stays in the box and the next one appends ("helloworld").
      apply({ type: 'set', text: '', cursor: 0 });
      onSubmit(text);
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'C')) {
      if (stateRef.current.text.length === 0) {
        onCancel();
      } else {
        apply({ type: 'set', text: '', cursor: 0 });
      }
      return;
    }
    // Ctrl+D: empty buffer → exit (the shortcuts panel advertises this);
    // with text → forward-delete (readline). Without this branch Ink's
    // decoded input ('d') fell through to the insert walk and a literal
    // `d` appeared in the box.
    if (key.ctrl && (input === 'd' || input === 'D')) {
      if (stateRef.current.text.length === 0) { onExit?.(); return; }
      apply({ type: 'delete' });
      return;
    }
    if (key.leftArrow) return apply({ type: 'left' });
    if (key.rightArrow) return apply({ type: 'right' });
    if (key.backspace) return apply({ type: 'backspace' });
    if (key.delete) return apply({ type: 'delete' }); // forward-delete (Del) removes the char AT the cursor
    if (key.ctrl && (input === 'a' || input === 'A')) return apply({ type: 'home' });
    if (key.ctrl && (input === 'e' || input === 'E')) return apply({ type: 'end' });
    if (key.ctrl && (input === 'u' || input === 'U')) return apply({ type: 'killToStart' });
    if (key.ctrl && (input === 'k' || input === 'K')) return apply({ type: 'killToEnd' });
    if (key.ctrl && (input === 'w' || input === 'W')) return apply({ type: 'killWordBack' });
    if (key.ctrl && (input === 'o' || input === 'O')) { onExpandToolResult?.(); return; }
    // Ctrl+T → toggles menu (auto-continue · HITL · debug). Keyboard access to
    // the below-box settings that otherwise needed slash commands.
    if (key.ctrl && (input === 't' || input === 'T')) { onShowToggles?.(); return; }
    // Esc with no menu/search open → interrupt a running turn (makes the
    // spinner's "esc to interrupt" promise real). No-op when idle (the host
    // guards on isProcessing). Menu/search Esc is handled in their blocks above.
    if (key.escape) { onEscape?.(); return; }

    // `?` on an EMPTY buffer shows the shortcuts panel — makes the dim
    // "? for shortcuts" hint real (Claude Code parity). With any text typed,
    // `?` is a literal character, so normal prompts containing `?` are fine.
    if (input === '?' && stateRef.current.text.length === 0 && !key.ctrl && !key.meta) {
      onShowShortcuts?.();
      return;
    }

    // Ink hands us paste / pre-buffered chunks as a single `input` string.
    // parseKeypress only flags key.return / key.ctrl when the chunk is a
    // pure single key. When a control byte is embedded mid-chunk (e.g.
    // 'world\x01' or '[2J' after Ink ate the \x1b prefix) the flags stay
    // false and the raw bytes sit inside `input`. Sanitise the WHOLE
    // chunk first so multi-byte ANSI sequences like '[2J' are stripped
    // as one, then walk for embedded \r / Ctrl+letter and insert the
    // rest. Splitting into per-char dispatches without sanitising the
    // chunk first would let CSI bodies through.
    if (input) {
      const cleaned = sanitize(input);
      // A large multi-line paste arrives as one chunk: collapse it to a compact
      // `[Pasted text #N +M lines]` placeholder so it doesn't flood the box, and
      // hold the full text in the registry for re-expansion at submit (Claude
      // Code parity). Reverse-search owns input while active, so skip there.
      const pasteLines = pasteLineCount(cleaned);
      if (pasteLines !== null && !searchRef.current.active) {
        const token = pasteRef.current.register(cleaned, pasteLines);
        apply({ type: 'insertRaw', text: token });
        return;
      }
      // Iterate by code point ([...x]) so surrogate-pair emoji stay intact.
      const chars = [...cleaned];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]!;
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          // A TERMINATING newline (nothing but newlines after it) is the user
          // pressing Enter → submit. An INTERNAL newline means a multi-line
          // PASTE arrived as one chunk → insert it so the whole paste lands in
          // the buffer instead of submitting line 1 and dropping the rest.
          const rest = chars.slice(i + 1).join('');
          if (!rest || /^[\r\n]*$/.test(rest)) {
            const text = stateRef.current.text;
            apply({ type: 'set', text: '', cursor: 0 });
            submit(text);
            return;
          }
          apply({ type: 'insert', text: '\n' });
          continue;
        }
        if (code === 0x03) {
          if (stateRef.current.text.length === 0) { onCancel(); return; }
          apply({ type: 'set', text: '', cursor: 0 });
          pasteRef.current.clear();
          continue;
        }
        if (code === 0x04) {
          // Raw EOF byte embedded in a chunk — same contract as the
          // key.ctrl+'d' branch above.
          if (stateRef.current.text.length === 0) { onExit?.(); return; }
          apply({ type: 'delete' });
          continue;
        }
        if (code === 0x01) { apply({ type: 'home' }); continue; }
        if (code === 0x05) { apply({ type: 'end' });  continue; }
        // sanitize() above already stripped C0 bytes other than the
        // shortlist we just handled, so this insert is always safe.
        apply({ type: 'insert', text: ch });
      }
    }
  });

  // Snapshot the ref into a local for the JSX below. Outside the input
  // handler the latest committed render value is the right thing to draw.
  const state = stateRef.current;

  // Render the buffer with a visible cursor block. In secret mode we
  // collapse the buffer to • characters but keep the cursor markers so
  // the user can still see where they are editing.
  // Children must be non-empty strings — empty <Text> siblings collide
  // on React's auto-generated keys and the parent fails to mount, which
  // also prevents useInput's effect from running. Render a single space
  // when a slice would be empty.
  const display = secret ? '•'.repeat(state.text.length) : state.text;
  // Leading '!' runs the line in bash (Claude Code parity); tint the prompt
  // mark so the mode is visible before Enter.
  const bashMode = state.text.startsWith('!');

  // Multi-line aware: split on '\n' and locate the cursor's line/column so the
  // inverse cursor block lands on the right row. Continuation lines drop the
  // '> ' mark (indented two cols), matching Claude Code.
  const dispLines = display.split('\n');
  let curLine = 0;
  let curCol = state.cursor;
  for (let i = 0; i < dispLines.length; i++) {
    if (curCol <= dispLines[i]!.length) { curLine = i; break; }
    curCol -= dispLines[i]!.length + 1; // +1 for the consumed '\n'
    curLine = i + 1;
  }

  // Surface state via a hidden marker line for subprocess testing.
  // ANVILWING_INK_DEBUG=1 enables a `STATE: <buffer>|<cursor>` annotation
  // that the test harness greps for. Off by default.
  useEffect(() => {
    if (process.env['ANVILWING_INK_DEBUG'] === '1') {
      process.stderr.write(`STATE: ${state.text}|${state.cursor}\n`);
    }
  }, [state.text, state.cursor]);

  const search = searchRef.current;
  const comp = completion();
  const slash = slashCompletion();
  const inputRow = (
    <Box key="input" flexDirection="column">
      {dispLines.map((ln, i) => {
        const mark = i === 0 ? prefix : '  ';
        const markEl = i === 0 && bashMode
          ? <Text key="m" color="#ff9f43">{mark}</Text>
          : <Text key="m" dimColor>{mark}</Text>;
        if (i === curLine) {
          return (
            <Box key={`il-${i}`}>
              {markEl}
              <Text key="b">{ln.slice(0, curCol) || ' '}</Text>
              <Text key="c" inverse>{ln.slice(curCol, curCol + 1) || ' '}</Text>
              <Text key="a">{ln.slice(curCol + 1) || ' '}</Text>
            </Box>
          );
        }
        return (
          <Box key={`il-${i}`}>
            {markEl}
            <Text key="t">{ln || ' '}</Text>
          </Box>
        );
      })}
    </Box>
  );
  if (search.active) {
    // bash-style reverse-i-search status line above the input.
    return (
      <Box flexDirection="column">
        <Box key="rsearch"><Text dimColor>{`(reverse-i-search)\`${search.query}\`:`}</Text></Box>
        {inputRow}
      </Box>
    );
  }
  if (slash.open) {
    // `/`-command palette under the input — ▸ marks the highlighted command,
    // with its description dimmed (↑/↓ move, Tab/Enter accept, Esc dismiss).
    return (
      <Box flexDirection="column">
        {inputRow}
        <Box key="smenu" flexDirection="column" paddingLeft={2}>
          {slash.matches.map((c, i) => (
            <Box key={`sm-${i}`}>
              <Text color={i === slashRef.current.idx ? '#ff9f43' : undefined}>
                {(i === slashRef.current.idx ? '▸ ' : '  ') + c.command}
              </Text>
              <Text dimColor>{'  ' + c.description}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
  if (comp.open) {
    // @-mention completion menu under the input — ▸ marks the highlighted file
    // (↑/↓ to move, Tab/Enter to accept, Esc to dismiss).
    return (
      <Box flexDirection="column">
        {inputRow}
        <Box key="cmenu" flexDirection="column" paddingLeft={2}>
          {comp.matches.map((f, i) => (
            <Box key={`cm-${i}`}>
              <Text color={i === compRef.current.idx ? '#ff9f43' : undefined}>
                {(i === compRef.current.idx ? '▸ ' : '  ') + '@' + f}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }
  return inputRow;
};
