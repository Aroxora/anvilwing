/**
 * Menu — interactive Ink selection list. The Ink path's only way to make
 * a menu choice: arrow keys move the cursor, Enter selects, Escape /
 * Ctrl+C cancels. Owns useInput while mounted; App renders it in place of
 * the Prompt so the two never fight over keystrokes.
 *
 * Before this component existed, InkPromptController.setMenu only mapped
 * items to passive suggestion labels and the selection callback was never
 * invoked with a choice — /model and /secrets were unreachable in the Ink
 * UI.
 */

import React, { useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MenuItem } from './InkPromptController.js';

export interface MenuProps {
  items: MenuItem[];
  title?: string;
  /** HITL popup: the decision question, shown bold (accent) at the top of the box. */
  question?: string;
  /** HITL popup: description / context lines, dim, under the question. */
  body?: string[];
  /** HITL popup: a single dim hint line at the bottom of the box. */
  footer?: string;
  /** Render as a bottom-anchored bordered popup (Claude Code / opencode style).
   *  Opt-in: slash-palette menus stay as a plain in-place list. */
  boxed?: boolean;
  /** Open with the cursor on this index (clamped to a selectable item).
   *  HITL approval menus rely on this: requestApproval defaults to "No" for
   *  safety — without honoring it the highlight sat on "Yes" and a trusting
   *  Enter approved the risky action. */
  initialIndex?: number;
  onSelect: (item: MenuItem) => void;
  onCancel: () => void;
}

function firstSelectable(items: MenuItem[], preferred?: number): number {
  if (
    typeof preferred === 'number' && Number.isInteger(preferred) &&
    preferred >= 0 && preferred < items.length && !items[preferred]?.disabled
  ) {
    return preferred;
  }
  const active = items.findIndex((i) => i.isActive && !i.disabled);
  if (active >= 0) return active;
  const enabled = items.findIndex((i) => !i.disabled);
  return enabled >= 0 ? enabled : 0;
}

export const Menu: React.FC<MenuProps> = ({ items, title, question, body, footer, boxed, initialIndex, onSelect, onCancel }) => {
  const [cursor, move] = useReducer((cur: number, dir: -1 | 1): number => {
    if (items.length === 0) return 0;
    // Walk in `dir` until a non-disabled item is found; give up after a
    // full loop so an all-disabled list doesn't spin forever.
    let next = cur;
    for (let i = 0; i < items.length; i++) {
      next = (next + dir + items.length) % items.length;
      if (!items[next]?.disabled) return next;
    }
    return cur;
  }, firstSelectable(items, initialIndex));

  useInput((input, key) => {
    if (key.upArrow) { move(-1); return; }
    if (key.downArrow) { move(1); return; }
    if (key.return) {
      const item = items[cursor];
      if (item && !item.disabled) onSelect(item);
      return;
    }
    if (key.escape || (key.ctrl && (input === 'c' || input === 'C'))) {
      onCancel();
    }
  });

  const options = items.map((item, i) => {
    const selected = i === cursor;
    const color = item.disabled ? 'gray' : selected ? '#ff9f43' : undefined;
    return (
      <Box key={item.id}>
        <Text color={color} dimColor={item.disabled} inverse={selected && !item.disabled}>
          {selected ? '▸ ' : '  '}{item.label}
        </Text>
        {item.description ? <Text dimColor>  {item.description}</Text> : null}
      </Box>
    );
  });

  const content = (
    <Box flexDirection="column">
      {question ? (
        <Text bold color="#ff9f43">{question}</Text>
      ) : title ? (
        <Text bold>{title}</Text>
      ) : null}
      {body && body.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {body.map((line, i) => <Text key={`b-${i}`} dimColor>{line}</Text>)}
        </Box>
      ) : null}
      {options}
      {footer ? <Box marginTop={1}><Text dimColor>{footer}</Text></Box> : null}
    </Box>
  );

  // HITL: a bottom-anchored bordered popup (Claude Code / opencode). Other menus
  // (slash palette) stay a plain in-place list — boxed is opt-in.
  if (boxed) {
    return (
      <Box borderStyle="round" borderColor="#ff9f43" paddingX={1} flexDirection="column">
        {content}
      </Box>
    );
  }
  return content;
};
