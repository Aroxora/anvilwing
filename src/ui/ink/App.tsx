/**
 * App — Phase 3 root that mounts the Phase 1 StatusLine + Phase 2 Prompt
 * together and exposes a minimal command surface.
 *
 * This is the integration that proves the Ink tree can replace the
 * sticky-bottom panel of the existing renderer wholesale: status row on
 * top, suggestions list, prompt at the bottom. The host (eventually
 * interactiveShell.ts) drives state via the props on this component.
 *
 * Phase 4 will add a `<Static>` chat-history block above this component;
 * the API stays the same — only the host's rendering of past events
 * changes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { StatusLine, type StatusLineProps } from './StatusLine.js';
import { Prompt, type PromptProps } from './Prompt.js';
import { ChatStatic, type ChatItem } from './ChatStatic.js';
import { Menu, type MenuProps } from './Menu.js';
import { permissionModeStrip, permissionHint as permissionHintFn, type PermissionModeSegment } from '../../core/permissionMode.js';

export interface AppProps {
  /** Past chat events. Rendered via <Static> so scrollback is permanent. */
  history?: ChatItem[];
  /**
   * In-progress assistant message. Streaming deltas accumulate here so
   * the text grows in place; once the model emits its `response` event
   * the controller moves the final text into `history` and clears
   * this. Without this slot, every delta would create its own
   * <Static> entry — which is what produced the "one word per line"
   * symptom users saw in 1.1.0/1.1.1.
   */
  streamingMessage?: string | null;
  status?: StatusLineProps;
  prompt: PromptProps;
  /** When present, an interactive menu replaces the prompt and owns input. */
  menu?: MenuProps;
  /** Toggle-modes strip under the input box: all three permission modes, one active. */
  permissionStrip?: PermissionModeSegment[];
  /** Dim trailing hint at the end of the toggle-modes strip. */
  permissionHint?: string;
  /** Dim meta line (product · model · context · toggles) under the strip. */
  metaLine?: string | null;
  /** Live follow-up queue (Claude Code parity): shown only while spinning, above the input. Not in <Static> history. */
  queuedPrompts?: string[];
  /**
   * A dismissable panel (/help, /keys, /context, /secrets) shown above the
   * input. Pre-formatted chalk lines from the host; rendered as a block —
   * before this, only the first line leaked into the meta chips, so panel
   * bodies were invisible on the real terminal.
   */
  inlinePanel?: string[];
}

export const App: React.FC<AppProps> = ({ history, streamingMessage, status, prompt, menu, permissionStrip, permissionHint, metaLine, queuedPrompts, inlinePanel }) => {
  const strip = permissionStrip ?? permissionModeStrip();
  // Hide the trailing `DONE:` completion marker while it streams — ChatStatic
  // renders it as a clean ✓ once committed, so showing the raw marker live (and
  // the partial "DONE:" being typed) is just noise.
  const liveStreamText = streamingMessage
    ? streamingMessage.replace(/\n*DONE:[^\n]*$/, '').replace(/[ \t\n]+$/, '')
    : streamingMessage;
  return (
    <Box flexDirection="column">
      {history && history.length > 0 ? <ChatStatic items={history} /> : null}
      {menu ? (
        <Box marginTop={1}>
          <Menu key={`${menu.title ?? ''}:${menu.items.length}`} {...menu} />
        </Box>
      ) : (
        <>
          {/* Live-streaming assistant text: the dynamic region below the
              only <Static> node (ChatStatic). Ink log-update repaints it
              each frame; on the 'response' event the controller pushes
              the final text into history AND nulls streamingMessage in a
              single rerender, so the live region clears in the same
              commit that ChatStatic gains the entry — no duplication.
              Same default foreground as a committed assistant bubble so
              the swap is seamless. */}
          {streamingMessage ? (
            // §1: the in-progress ⏺ block keeps the same one-blank-line gap
            // from the transcript that it will have once committed — without
            // the margin the text jumped a row at commit time.
            <Box marginTop={history && history.length > 0 ? 1 : 0}>
              <Text color="#ff9f43">⏺ </Text>
              <Box flexGrow={1}>
                <Text color="#e8e9ed">{liveStreamText}</Text>
              </Box>
            </Box>
          ) : null}
          {status ? (
            <Box marginTop={history && history.length > 0 ? 1 : 0}>
              <StatusLine {...status} />
            </Box>
          ) : null}
          {/* Live follow-up queue (Claude Code parity, transient only while spinning).
              Shown above the input, never in permanent <Static> history. Dequeued
              items are appended to history at start-of-turn so responses follow
              their question immediately (correct ordering). */}
          {queuedPrompts && queuedPrompts.length > 0 ? (
            // flexDirection column (Ink's Box defaults to ROW): without it the
            // header and previews flowed on ONE 90+ col row that wrapped into
            // garbled chrome at 80 cols. Stacked lines match the suggestions
            // and inlinePanel siblings.
            <Box flexDirection="column" marginTop={1} paddingLeft={1}>
              {/* §9: no chrome emoji — plain dim header, like Claude Code. */}
              <Text dimColor>Queued ({queuedPrompts.length})</Text>
              {queuedPrompts.slice(0, 2).map((p, i) => {
                const short = p.length > 38 ? p.slice(0, 35) + '…' : p;
                return <Text key={i} dimColor>   {short}</Text>;
              })}
              {queuedPrompts.length > 2 ? (
                <Text dimColor>   +{queuedPrompts.length - 2} more</Text>
              ) : null}
            </Box>
          ) : null}
          {/* Dismissable panel (/help · /keys · /context · /secrets) above the
              input. Empty strings become ' ' so blank rows mount (same React-key
              fix ChatStatic uses). */}
          {inlinePanel && inlinePanel.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {inlinePanel.map((line, i) => (
                <Text key={`ip-${i}`}>{line.length ? line : ' '}</Text>
              ))}
            </Box>
          ) : null}
          {/* The rounded Box gives the prompt Claude Code's input-box shape.
              Below it: row 1 is the persistent toggle-modes strip (active mode
              in ember, everything else dim); row 2 is the dim meta line. */}
          <Box flexDirection="column" marginTop={1}>
            <Box borderStyle="round" borderColor="#30303a" paddingX={1}>
              <Prompt {...prompt} />
            </Box>
            <Box paddingLeft={2}>
              {strip.map((seg, i) => (
                <React.Fragment key={seg.label}>
                  {i > 0 ? <Text dimColor> · </Text> : null}
                  {seg.active
                    ? <Text color="#ff9f43">{seg.label}</Text>
                    : <Text dimColor>{seg.label}</Text>}
                </React.Fragment>
              ))}
              {/* Same live-state fallback as `strip` above — a hardcoded
                  default-mode string here would contradict the strip when the
                  module mode is acceptEdits/plan. permissionMode.permissionHint
                  owns the wording (incl. "? for shortcuts"). */}
              <Text dimColor> · {permissionHint ?? permissionHintFn()}</Text>
            </Box>
            {metaLine ? (
              <Box paddingLeft={2}>
                <Text dimColor>{metaLine}</Text>
              </Box>
            ) : null}
          </Box>
        </>
      )}
    </Box>
  );
};
