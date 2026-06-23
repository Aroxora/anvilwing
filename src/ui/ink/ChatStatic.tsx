/**
 * ChatStatic — Phase 4 of the Ink migration.
 *
 * Wraps Ink's <Static> component so chat history is committed to
 * scrollback exactly once and never repainted. This is the architectural
 * fix for the resize / rapid-paste / overlay-leak bugs that motivated
 * the Ink switch: messages above the live UI become real terminal lines
 * that no longer participate in any frame diff. <Static> writes a row,
 * then forgets it.
 *
 * Styling follows the Claude Code transcript shape (see
 * src/ui/CLAUDE_CODE_UX.md): every action — an assistant turn or a tool
 * call — opens with a ember `⏺` bullet; tool results render dim under a
 * `⎿` turn. The host emits pre-formatted text; this component owns the
 * colour roles per kind.
 */

import React from 'react';
import { Static, Box, Text } from 'ink';
import { renderMarkdown } from './markdownRender.js';

export interface ChatItem {
  /** Stable identity for React's key prop — usually a monotonic id. */
  id: string;
  /** Tag the host can use to dispatch on style. */
  kind: 'user' | 'assistant' | 'system' | 'tool' | 'toolResult' | 'error' | 'banner';
  /** Pre-formatted content (already wrapped / styled by the caller). */
  text: string;
}

export interface ChatStaticProps {
  items: ChatItem[];
}

// Space Black brand roles (mirror src/ui/theme.ts).
const EMBER = '#ff9f43'; // action bullet / user
const LUNAR = '#e8e9ed';     // assistant / tool-name foreground
const ASH = '#8b8e96';       // dim — system + tool results
const RUBY = '#ff4d3d';      // errors / diff removals
const EMERALD = '#28c840';   // diff additions
const AMBER = '#ffd666';     // post-write diagnostics warning

// A write/edit tool-result carries a line-numbered diff from
// src/tools/diffUtils.ts (formatDiffClaudeStyle): `   12 +   added`,
// `   12 -   removed`, `   12     context`. The 3 spaces after the +/- marker
// make the shape distinctive enough that ordinary tool output won't match.
const DIFF_ADDED = /^\s*\d+ \+   /;
const DIFF_REMOVED = /^\s*\d+ -   /;

// A TodoWrite checklist line (see renderTodoChecklist): `☒` done, `☐` pending,
// `▸` the active step. Colored so the plan reads at a glance and visibly
// updates — done steps fade, the active step stands out.
const TODO_LINE = /[☒☐▸]/;

/**
 * Tool result. Diff lines (write/edit) color per line — additions green,
 * removals red. A todo checklist colors by status — completed dim, the active
 * step ember, pending lunar — so a plan and its updates render clearly.
 * Everything else stays a single dim block.
 */
const ToolResult: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.split('\n');
  const hasDiff = lines.some((l) => DIFF_ADDED.test(l) || DIFF_REMOVED.test(l));
  const hasTodo = !hasDiff && lines.some((l) => TODO_LINE.test(l));
  if (hasTodo) {
    return (
      <Box flexDirection="column">
        {lines.map((l, i) => {
          const done = l.includes('☒');
          const active = l.includes('▸');
          const color = done ? ASH : active ? EMBER : LUNAR;
          return <Text key={i} color={color} dimColor={done} bold={active}>{l.length ? l : ' '}</Text>;
        })}
      </Box>
    );
  }
  if (!hasDiff) return <Text color={ASH}>{text}</Text>;
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => {
        const color = l.includes('⚠ diagnostics:') ? AMBER
          : DIFF_ADDED.test(l) ? EMERALD
          : DIFF_REMOVED.test(l) ? RUBY
          : ASH;
        // Empty <Text> children collide on React keys / fail to mount.
        return <Text key={i} color={color}>{l.length ? l : ' '}</Text>;
      })}
    </Box>
  );
};

// The `DONE:` completion sentinel (system-prompt contract, detected by
// taskCompletionDetector) is a MACHINE marker — it must not leak into the
// transcript raw. Split a trailing `DONE: <sentence>` off the assistant body
// so it renders as a clean ember `✓` summary line instead of literal "DONE:".
function splitDoneSentinel(body: string): { main: string; done: string | null } {
  const lines = body.replace(/\s+$/, '').split('\n');
  // Find the LAST `DONE:` line wherever it sits — not just the exact final
  // line. Models routinely add a sign-off sentence AFTER the marker ("…verified.
  // Let me know if you need anything"), which left the raw "DONE:" visible
  // because only the last line was checked. Strip that line out and keep the
  // surrounding prose as the main body.
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^DONE:\s*.+$/.test(lines[i]!.trim())) { idx = i; break; }
  }
  if (idx === -1) return { main: body, done: null };
  const done = lines[idx]!.trim().replace(/^DONE:\s*/, '').trim();
  const main = lines.filter((_, i) => i !== idx).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
  return { main, done };
}

/** An action line: ember bullet + a hang-indented body. Assistant Markdown
 *  is rendered to themed ANSI at commit time (Claude Code parity); plain prose
 *  passes through unchanged and keeps the lunar default. A trailing `DONE:`
 *  sentinel renders as a clean `✓` summary, never as the raw marker. */
const Action: React.FC<{ body: string }> = ({ body }) => {
  const { main, done } = splitDoneSentinel(body);
  const rendered = renderMarkdown(main);
  const isMarkdown = rendered !== main;
  const hasMain = main.trim().length > 0;
  return (
    <Box flexDirection="column">
      {hasMain ? (
        <Box>
          <Text color={EMBER}>⏺ </Text>
          <Box flexGrow={1}>
            {isMarkdown ? <Text color={LUNAR}>{rendered}</Text> : <Text color={LUNAR}>{main}</Text>}
          </Box>
        </Box>
      ) : null}
      {done ? (
        <Box>
          <Text color={EMBER}>{hasMain ? '  ✓ ' : '⏺ '}</Text>
          <Box flexGrow={1}><Text color={ASH}>{done}</Text></Box>
        </Box>
      ) : null}
    </Box>
  );
};

/**
 * A tool action: ember bullet, then the tool NAME bold and its argument PLAIN
 * (CLAUDE_CODE_UX.md §2/§47). Body arrives as `ToolName(arg)`; split at the
 * first `(` so `Write(fib.py)` renders `Write` bold, `(fib.py)` plain. A name
 * with no argument (e.g. `Update Todos`) stays bold in whole, matching §2.
 */
const ToolAction: React.FC<{ body: string }> = ({ body }) => {
  const i = body.indexOf('(');
  const name = i === -1 ? body : body.slice(0, i);
  const arg = i === -1 ? '' : body.slice(i);
  return (
    <Box>
      <Text color={EMBER}>⏺ </Text>
      <Box flexGrow={1}>
        <Text color={LUNAR}><Text bold>{name}</Text>{arg}</Text>
      </Box>
    </Box>
  );
};

function renderItem(item: ChatItem): React.ReactNode {
  switch (item.kind) {
    case 'tool': {
      // Text arrives as `⏺ ToolName(arg)`; re-render so the bullet is ember and
      // the tool name is lunar-bold with the argument plain (§2/§47).
      const body = item.text.startsWith('⏺') ? item.text.replace(/^⏺\s?/, '') : item.text;
      return <ToolAction body={body} />;
    }
    case 'assistant':
      return <Action body={item.text} />;
    case 'toolResult':
      // Already carries its `  ⎿  …` lead-in + continuation indent. Diffs are
      // colored line-by-line; plain results render as one dim block.
      return <ToolResult text={item.text} />;
    case 'user':
      // Carry the input box's `> ` marker (§5) onto the committed turn so the
      // user's message is unmistakable in scrollback — Claude Code parity. The
      // marker is dim; the text keeps the ember accent role (§8).
      return (
        <Box>
          <Text color={ASH}>{'> '}</Text>
          <Box flexGrow={1}><Text color={EMBER} bold>{item.text}</Text></Box>
        </Box>
      );
    case 'system':
      return <Text color={ASH} dimColor>{item.text}</Text>;
    case 'error':
      return <Text color={RUBY}>{item.text}</Text>;
    case 'banner':
      // Banners embed their own chalk colour (rounded welcome box, etc.).
      return <Text>{item.text}</Text>;
    default:
      return <Text>{item.text}</Text>;
  }
}

export const ChatStatic: React.FC<ChatStaticProps> = ({ items }) => {
  return (
    <Static items={items}>
      {(item, index) => (
        // §1: one blank line between consecutive ⏺ blocks (distinct paragraphs).
        // A toolResult (⎿) hugs the action above it, so no gap there; the first
        // item gets no leading gap. A failed tool's `⎿ Error:` line (kind
        // 'error' but shaped as a result) hugs its call the same way — §3 says
        // error results render like results, just red.
        <Box key={item.id} flexDirection="column" marginTop={index > 0 && item.kind !== 'toolResult' && !(item.kind === 'error' && /^\s*⎿/.test(item.text)) ? 1 : 0}>
          {renderItem(item)}
        </Box>
      )}
    </Static>
  );
};
