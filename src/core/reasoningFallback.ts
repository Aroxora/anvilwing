/**
 * Guard for the "synthesize a response from reasoning" fallback in the
 * interactive shell.
 *
 * The fallback exists for models that stream thinking but produce an empty
 * response (or time out mid-turn). The bug it replaces: the three call sites
 * gated on `currentResponseBuffer`, which is CLEARED at message.complete, and
 * the after-loop site also fired on a stale reasoning/step-timeout flag. So
 * after a turn that already showed a real answer, synthesized (and
 * punctuation-mangled) reasoning was glued onto it — the duplicated/garbled
 * "thought process" users saw.
 *
 * The fallback must fire ONLY when the turn produced no response content at all.
 * Extracted as a free function so it's unit-testable without the shell.
 */
export function shouldSynthesizeFromReasoning(input: {
  hasReceivedResponseContent: boolean;
  finalResponseText: string;
  currentResponseBuffer: string;
  reasoningBuffer: string;
}): boolean {
  const producedNoResponse =
    !input.hasReceivedResponseContent &&
    input.finalResponseText.trim().length === 0 &&
    input.currentResponseBuffer.trim().length === 0;
  return producedNoResponse && input.reasoningBuffer.trim().length > 0;
}
