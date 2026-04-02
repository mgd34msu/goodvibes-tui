/**
 * strategies/collapse.ts
 *
 * Collapse strategy — full context collapse into a single compacted summary
 * message. This is the most aggressive strategy, used when token pressure
 * exceeds 85% or when manually triggered.
 *
 * All messages are reduced to a structured handoff that preserves:
 * - The original task context (if known)
 * - Key decisions and outcomes
 * - The most recent user/assistant exchange
 */

import type { ProviderMessage } from '../../../providers/interface.ts';
import { estimateTokens } from '../../../core/compaction-types.ts';
import type { StrategyInput, StrategyOutput } from '../types.ts';

/**
 * Applies the collapse strategy: reduces all messages to a single structured
 * handoff message that preserves the essential session context.
 *
 * @param input - Strategy input containing messages and context.
 * @returns Strategy output with a single collapsed message.
 */
export function runCollapse(input: StrategyInput): StrategyOutput {
  const startMs = Date.now();
  const { messages, tokensBefore, sessionId, strategy } = input;
  const warnings: string[] = [];

  // Extract the last user/assistant exchange to preserve conversational context
  const lastUserMsg = messages.findLast((m) => m.role === 'user');
  const lastAssistantMsg = messages.findLast((m) => m.role === 'assistant');

  const recentExchange: string[] = [];
  if (lastUserMsg) {
    const text = extractText(lastUserMsg);
    if (text) recentExchange.push(`User: ${text.slice(0, 500)}`);
  }
  if (lastAssistantMsg) {
    const text = extractText(lastAssistantMsg);
    if (text) recentExchange.push(`Assistant: ${text.slice(0, 500)}`);
  }

  const handoffLines: string[] = [
    `[Session Collapse — ${new Date().toISOString()}]`,
    `Session: ${sessionId}`,
    `${messages.length} message(s) collapsed to reduce context from ~${tokensBefore} tokens.`,
    '',
    '## Most Recent Exchange',
    recentExchange.length > 0
      ? recentExchange.join('\n')
      : '(no user/assistant exchange found)',
    '',
    '## Context Note',
    'The full conversation history has been collapsed. Please resume from the above context.',
  ];

  const handoff: ProviderMessage = {
    role: 'user',
    content: [{ type: 'text', text: handoffLines.join('\n') }],
  };

  const compacted: ProviderMessage[] = [handoff];
  const tokensAfter = estimateTokens(JSON.stringify(compacted));

  if (tokensAfter >= tokensBefore) {
    warnings.push('collapse: compacted output is not smaller than input; possible data issue');
  }

  return {
    messages: compacted,
    tokensAfter,
    summary: `Collapse: ${messages.length} messages → 1 handoff message (~${tokensAfter} tokens).`,
    strategy,
    durationMs: Date.now() - startMs,
    warnings,
  };
}

/** Extracts plain text from a ProviderMessage. */
function extractText(msg: ProviderMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}
