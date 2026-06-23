/**
 * Display formatting for provider/runtime error messages.
 *
 * Provider SDK errors embed the ENTIRE HTTP response body in `.message` — a
 * Cloudflare 502 HTML page is ~5KB, a context-length 400 JSON ~3KB. Rendering
 * that verbatim paints a wall of red text that buries the conversation and
 * reads like a crash. This formatter makes any error one compact, readable
 * block: ANSI stripped (defense in depth — Ink drops non-SGR escapes but SGR
 * passes through), whitespace collapsed, hard length cap with head+tail kept.
 *
 * Pure (no I/O) so it unit-tests directly.
 */

const MAX_DISPLAY_CHARS = 400;

/** Strip ANSI/VT escape sequences (SGR and otherwise). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB0])/g, '');
}

/** True when the body looks like a raw HTML error page (worthless verbatim). */
function looksLikeHtml(s: string): boolean {
  return /<!DOCTYPE html|<html[\s>]/i.test(s);
}

/**
 * Format an error message for the transcript: compact, capped, never a wall.
 */
export function formatErrorForDisplay(raw: string): string {
  let text = stripAnsi(String(raw ?? '')).trim();
  if (!text) return 'Unknown error';

  if (looksLikeHtml(text)) {
    // Keep the status prefix the SDK puts before the body ("502 <!DOCTYPE…")
    // and the page <title> if present — drop the rest of the markup.
    const status = text.match(/^\s*(\d{3})\b/)?.[1];
    const title = text.match(/<title>([^<]{1,120})<\/title>/i)?.[1]?.trim();
    const parts = [status, title ?? 'HTML error page from provider'].filter(Boolean);
    return `${parts.join(' — ')} [full body omitted]`;
  }

  // Collapse runs of blank lines and trailing space noise.
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

  if (text.length > MAX_DISPLAY_CHARS) {
    const head = text.slice(0, 300).trimEnd();
    const tail = text.slice(-80).trimStart();
    text = `${head}\n… [${text.length - 380} chars omitted] …\n${tail}`;
  }
  return text;
}
