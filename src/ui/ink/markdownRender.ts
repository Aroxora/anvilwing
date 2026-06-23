/**
 * Render assistant Markdown to themed ANSI for the terminal transcript, the way
 * Claude Code does. Applied at COMMIT time (when an assistant turn becomes a
 * permanent <Static> ChatItem) — the live streaming region stays plain so
 * formatting solidifies once, with no per-frame reflow.
 *
 * Space Black palette (mirrors src/ui/theme.ts): headings/strong in lunar,
 * inline code + code blocks in ice-cyan, links in ember, rules/quotes dim.
 */
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import chalk from 'chalk';

const LUNAR = '#e8e9ed';
const ICE = '#64d2ff';
const EMBER = '#ff9f43';
const ASH = '#8b8e96';

// marked-terminal does NOT apply the inline renderers (codespan, strong, link)
// to text inside list items — it hands the listitem renderer the RAW item text,
// so `- use \`foo\` and **bar**` came out with literal backticks/asterisks. Apply
// the inline styling here. Only PAIRED, unambiguous markers are touched (so a
// bare `a ** b` or a lone backtick is left alone), and list items never contain
// fenced code blocks, so this can't corrupt code-block content.
function styleListInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, (_m, code) => chalk.hex(ICE)(code))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b) => chalk.hex(LUNAR).bold(b))
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, label) => chalk.hex(EMBER).underline(label));
}

let configured = false;
function configure(): void {
  if (configured) return;
  marked.use(
    markedTerminal({
      // Headings as bold text, no leading `##`.
      showSectionPrefix: false,
      reflowText: false,
      tab: 2,
      heading: chalk.hex(LUNAR).bold,
      firstHeading: chalk.hex(LUNAR).bold,
      strong: chalk.hex(LUNAR).bold,
      em: chalk.italic,
      codespan: chalk.hex(ICE),
      code: chalk.hex(ICE),
      link: chalk.hex(EMBER).underline,
      href: chalk.hex(EMBER).underline,
      blockquote: chalk.hex(ASH).italic,
      hr: chalk.hex(ASH),
      listitem: (text: string) => styleListInline(text),
    }) as Parameters<typeof marked.use>[0],
  );
  configured = true;
}

/**
 * Render Markdown to a themed ANSI string. Returns the input unchanged if it
 * contains no Markdown-ish syntax (cheap fast-path) or if rendering throws —
 * plain prose must never be mangled or dropped.
 */
// Trigger rendering ONLY on STRUCTURAL Markdown or unambiguous paired inline
// syntax (`**bold**`, `` `code` ``). Bare single `*` / `_` are deliberately
// excluded: prose and math like "2*3*4" or "a_b_c" are valid CommonMark
// emphasis and marked would silently delete the markers (and the text between),
// corrupting plain output. Better to under-render than to mangle.
const MARKDOWN_RE = new RegExp(
  [
    '(?:^|\\n) {0,3}#{1,6} ', // ATX heading
    '```', // fenced code block
    '(?:^|\\n) {0,3}> ', // blockquote
    '(?:^|\\n) {0,3}(?:[-+]|\\d+\\.) +\\S', // bullet (-, +) or ordered list
    '(?:^|\\n) {0,3}\\|.*\\|.*\\n {0,3}\\|? *:?-{2,}', // table: header row + separator
    '\\[[^\\]\\n]+\\]\\([^)\\n]+\\)', // [text](url) link
    '`[^`\\n]+`', // `inline code`
    '\\*\\*[^*\\n]+\\*\\*', // **bold**
  ].join('|'),
);

export function renderMarkdown(text: string): string {
  if (!text) return text;
  // Fast path: no structural Markdown → leave the prose exactly as-is.
  if (!MARKDOWN_RE.test(text)) return text;
  try {
    configure();
    const out = marked.parse(text, { async: false }) as string;
    // marked appends a trailing newline; keep the body tight for the transcript.
    return typeof out === 'string' ? out.replace(/\n+$/, '') : text;
  } catch {
    return text;
  }
}
