# Claude Code UI/UX contract

This is the reference the Ink renderer targets. Anvilwing Coder keeps its own
brand palette (Ember Orange over the Space Black base: ember `#ff9f43`,
lunar `#e8e9ed`, ice-cyan `#64d2ff`) but matches Claude Code's **structure,
glyphs, spacing, and interaction model exactly**. No emoji in the chrome. No square boxes. The rule
of thumb: a screenshot of a Anvilwing session should be indistinguishable in
*shape* from a Claude Code session — only the accent colour and the name differ.

## 1. The action bullet `⏺`

Every discrete agent action — an assistant prose turn **and** every tool call —
is introduced by a filled bullet `⏺` in the accent colour, one space, then the
content. This is the single most recognisable element of the UI.

```
⏺ I'll read the file first, then run it.

⏺ Read(fibonacci.py)
  ⎿  Read 38 lines

⏺ The file already implements recursive fibonacci with @lru_cache. No changes needed.
```

- Bullet glyph: `⏺` (U+23FA). Colour: brand ember (`#ff9f43`).
- One blank line separates consecutive `⏺` blocks (assistant turns and tool
  groups are visually distinct paragraphs).

## 2. Tool calls — `⏺ ToolName(primaryArg)`

A tool call is the bullet, the tool's **display name**, and its single most
salient argument in parentheses. Never `[ToolName]`. Never an emoji.

| Tool        | Render                                  |
|-------------|-----------------------------------------|
| Read        | `⏺ Read(fibonacci.py)`                  |
| Write       | `⏺ Write(quicksort.js)`                 |
| Edit        | `⏺ Update(src/app.ts)` (Edit → "Update")|
| Bash        | `⏺ Bash(python3 fibonacci.py)`          |
| Grep/Search | `⏺ Search(pattern: "lru_cache")`        |
| Glob        | `⏺ Search(**/*.ts)`                     |
| WebSearch   | `⏺ Web Search("trump latest news")`     |
| WebFetch    | `⏺ Fetch(apnews.com/hub/donald-trump)`  |
| Task/Agent  | `⏺ Task(research the API)`              |
| TodoWrite   | `⏺ Update Todos`                        |

The tool name is bold; the argument is plain. Long args are truncated with `…`.

## 3. Tool results — `⎿`

The result of a tool renders on the next line(s), indented two spaces, with the
box-drawing turn `⎿` then two spaces, in **dim** text. It is a *summary*, not a
raw dump.

```
⏺ Read(fibonacci.py)
  ⎿  Read 38 lines

⏺ Bash(python3 fibonacci.py)
  ⎿  12586269025

⏺ Update(src/app.ts)
  ⎿  Updated src/app.ts with 3 additions and 1 removal

⏺ Update Todos
  ⎿  ☒ Explore the codebase
     ☐ Implement the feature
     ☐ Run tests
```

- Glyph: `⎿` (U+23BF), then two spaces. Indent the whole block two columns.
- TodoWrite/TodoRead render the **actual task list** as the result body — one
  line per task, `☒` for completed, `☐` for pending/in-progress — not a
  "Todos updated" summary. The structured list travels on the `tool.complete`
  event's `parameters` so the formatter renders from data, not parsed text.
- Multi-line results show the first few lines, then an overflow marker:
  `… +18 lines (ctrl+o to expand)` in dim.
- Errors render the same way but in red:
  `⎿  Error: python: command not found`. No `═══ FAILED ═══` banners, no
  "Suggested actions" bullets, no exit-code tables.

## 4. The spinner / working line

While the agent is working, a single animated line sits just above the input
box:

```
✻ Synthesizing… (8s · ↑ 1.2k tokens · esc to interrupt)
```

- Leading glyph animates through a sparkle cycle: `· ✢ ✳ ✶ ✻ ✽` in ember-orange.
- Then a label: the current activity ("Running python3 fibonacci.py",
  "Searching the web") or, when generic, a rotating gerund
  ("Thinking", "Synthesizing", "Forging", "Puzzling", "Conjuring", "Noodling").
- Trailing meta in dim parens: elapsed `Ns`, `· ↑ <tokens>`, `· esc to
  interrupt`. Omit a field when its value is unknown.

## 5. The input box

A **rounded** box. Never square.

```
╭──────────────────────────────────────────────────────────────╮
│ > write fibonacci.py with @lru_cache memoization              │
╰──────────────────────────────────────────────────────────────╯
  ⏵ default · ⏵⏵ accept edits · ⏸ plan · shift+tab — ? for shortcuts
  anvilwing · anvilwing · 8% context left · auto
```

- Corners `╭ ╮ ╰ ╯`, sides `─ │`. Border colour: dim wire when idle, ember when
  the agent is busy is acceptable but default is a low-contrast border.
- Prompt prefix `> ` in dim. The cursor is an inverse block.
- On submit, the committed user turn in the transcript carries the same `> `
  marker (dim) so it is unmistakable in scrollback; the text keeps the
  ember accent role (§8). Anchors each turn to the box it was typed in.
- **Below the box, row 1 — the toggle-modes strip.** Explicit user-requested
  deviation from stock Claude Code (which shows only the active mode's hint):
  all three permission modes stay visible, ` · `-separated. The active mode is
  ember `#ff9f43`; inactive labels, separators, and the trailing hint are
  dim. Exact labels: `⏵ default`, `⏵⏵ accept edits`, `⏸ plan`. Trailing hint:
  `shift+tab — ? for shortcuts` in default mode, `shift+tab to cycle` in any
  other mode (mirrors Claude Code's active-mode hint wording).
- **Below the box, row 2 — the meta line (§6).**

## 6. The mode / meta line

Claude Code keeps chrome minimal. Status (model, context left, cwd) lives in the
hint area below the box or in `/status`, not in a noisy emoji chip strip. The
Anvilwing equivalent: a single dim line, ` · `-separated, **no emoji**,
rendered directly under the toggle-modes strip (row 2 below the input box —
the spinner/working line of §4 stays above the box, as do the transient
above-box regions: suggestions, queued follow-ups (§10), inline panels; mode
and meta chrome all moved below):

```
anvilwing · anvilwing · 8% context left · auto
```

(Was: `📁 C:\… · 🧠 anvilwing · ctx 8% · auto`.)

## 7. The welcome banner

A rounded box, a sparkle, the product name, the load-bearing essentials. No
marketing.

```
╭───────────────────────────────────────────────────╮
│ ✻ Welcome to Anvilwing Coder                        │
│                                                     │
│   anvilwing · /help for commands              │
│   cwd: C:\GitHub\anvilwing                     │
╰───────────────────────────────────────────────────╯
```

When no key is set, the body switches to the key-setup guidance (unchanged
content, same box).

## 8. Colour roles (Space Black-mapped)

| Role            | Claude Code      | Anvilwing (`theme.ts`)        |
|-----------------|------------------|------------------------------|
| action bullet   | accent           | ember `#ff9f43`          |
| tool result     | dim/gray         | ash `#8b8e96`                |
| user text       | accent           | ember `#ff9f43`          |
| assistant text  | default fg       | lunar `#e8e9ed`              |
| error           | red              | ruby `#ff4d3d`               |
| additions       | green            | emerald `#28c840`            |
| removals        | red              | ruby `#ff4d3d`               |
| box border idle | dim              | wire `#30303a`               |

## 9. What is explicitly removed

- `[ToolName]` bracket labels.
- All chrome emoji: 📁 🧠 📝 📖 🔍 🌐 🔧 📌 ⏱ ⚙ ✨ 💾 📄 🗑.
- The square input box `┌ ┐ └ ┘`.
- `Done:` labels, `═══ FAILED ═══` blocks, "Suggested actions", exit-code tables.
- Auto-appended "Next steps:" sections.
- Raw WebFetch HTML/JS dumps in scrollback (results are summarised under `⎿`).

## 10. Live follow-up queue (Claude Code parity)
While the agent is working (spinner visible), the input box remains fully live. Typed follow-ups are accepted immediately and shown in a transient dim "Queued (n) + preview" stacked region (one line per item, no glyph — §9 bans chrome emoji) above the input (never in the permanent `<Static>` transcript). They are processed at the next assistant turn boundary (ASAP, before any outer auto-continue loop), with the user line appended to history only at dequeue time so each response appears directly after its question. `/clear` and idle return clear the transient queue. No polluting "Queued" system banners in scrollback.
