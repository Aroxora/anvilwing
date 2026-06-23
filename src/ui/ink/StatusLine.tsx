/**
 * StatusLine — Ink-rendered working line. The CLI's renderer is Ink-only;
 * this component owns the spinner / activity message row.
 *
 * Claude Code shape (see src/ui/CLAUDE_CODE_UX.md): a sparkle that animates
 * through `· ✢ ✳ ✶ ✻ ✽`, the current activity, then dim meta
 * `(Ns · ↑ X tokens · esc to interrupt)`. The component self-ticks (its own
 * interval) so the sparkle spins and the elapsed counter advances between host
 * rerenders — Ink reconciles it to a stable fiber, so the interval survives
 * the controller's prop updates. The mode/meta chips line lives below the
 * input box (App.metaLine), not here.
 *
 * Render contract: this component is the *only* writer for its rows. No
 * console.log / process.stdout.write side-effects.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { pickThinkingVerb } from '../../core/thinkingVerbs.js';

export interface StatusLineProps {
  /** Active line shown next to the spinner. Empty/undefined hides the row. */
  message?: string | null;
  /** Animate the sparkle + show elapsed/token meta. */
  spinning?: boolean;
  /** ms timestamp the current activity began, for the elapsed counter. */
  startTime?: number | null;
  /** Cumulative output tokens, for the `↑ X tokens` meta. */
  tokensUsed?: number | null;
  /**
   * When the spinner is showing a generic "thinking" state (no specific tool
   * activity), replace `message` with a whimsical gerund that rotates over time
   * — Claude Code parity (CLAUDE_CODE_UX.md §4).
   */
  thinkingGerund?: boolean;
}

const VERB_ROTATE_MS = 3200;

const STAR_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];
const EMBER = '#ff9f43';
const LUNAR = '#e8e9ed';

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const StatusLine: React.FC<StatusLineProps> = ({ message, spinning, startTime, tokensUsed, thinkingGerund }) => {
  const [frame, setFrame] = useState(0);
  const [verb, setVerb] = useState(() => pickThinkingVerb());

  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % STAR_FRAMES.length), 120);
    return () => clearInterval(id);
  }, [spinning]);

  // Rotate the gerund while the agent is in a generic thinking state, so the
  // working line cycles "Synthesizing… → Puzzling… → Forging…" like Claude Code
  // rather than sitting on one static word.
  useEffect(() => {
    if (!spinning || !thinkingGerund) return;
    setVerb((v) => pickThinkingVerb({ exclude: v }));
    const id = setInterval(() => setVerb((v) => pickThinkingVerb({ exclude: v })), VERB_ROTATE_MS);
    return () => clearInterval(id);
  }, [spinning, thinkingGerund]);

  const label = spinning && thinkingGerund ? `${verb}…` : message;
  const hasMessage = Boolean(label && label.length);
  if (!hasMessage) return null;

  const glyph = STAR_FRAMES[frame % STAR_FRAMES.length];

  // Meta + sparkle only appear while working; an idle status line is just the
  // bare message (matches Claude Code, and keeps the row uncluttered when the
  // host parks a static note here).
  const meta: string[] = [];
  if (spinning) {
    if (typeof startTime === 'number' && startTime > 0) {
      meta.push(`${Math.max(0, Math.floor((Date.now() - startTime) / 1000))}s`);
    }
    if (typeof tokensUsed === 'number' && tokensUsed > 0) {
      meta.push(`↑ ${fmtTokens(tokensUsed)} tokens`);
    }
    meta.push('esc to interrupt');
  }

  return (
    <Box>
      {spinning ? <Text color={EMBER}>{glyph} </Text> : null}
      <Text color={LUNAR}>{label}</Text>
      {meta.length ? <Text dimColor>{` (${meta.join(' · ')})`}</Text> : null}
    </Box>
  );
};
