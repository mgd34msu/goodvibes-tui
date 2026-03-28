import type { ToolCall } from '../types/tools.ts';
import type { ContentPart } from '../providers/interface.ts';

/**
 * Represents a single message as stored in ConversationManager.
 * Mirrors the internal Message union type.
 */
export interface ExportMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  callId?: string;
  toolName?: string;
  reasoningContent?: string;
  reasoningSummary?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  cancelled?: boolean;
}

export interface ExportMetadata {
  model?: string;
  provider?: string;
  sessionId?: string;
  title?: string;
}

/**
 * exportToMarkdown - Convert a conversation to a clean Markdown string.
 *
 * Format:
 * - Header with session metadata (model, provider, date, session ID)
 * - Each message as a section with role prefix
 * - Code blocks preserved
 * - Tool calls formatted as `<details>` collapsible blocks
 * - Tool results formatted as `<details>` collapsible blocks
 * - Token usage summary at the end
 */
export function exportToMarkdown(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
): string {
  const lines: string[] = [];
  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // ── Header ──────────────────────────────────────────────────────────────
  const title = metadata?.title || metadata?.sessionId || 'Conversation';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|-------|-------|');
  lines.push(`| **Date** | ${dateStr} |`);
  if (metadata?.model)    lines.push(`| **Model** | ${metadata.model} |`);
  if (metadata?.provider) lines.push(`| **Provider** | ${metadata.provider} |`);
  if (metadata?.sessionId) lines.push(`| **Session** | ${metadata.sessionId} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Token totals (accumulated from assistant messages) ──────────────────
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  // ── Messages ─────────────────────────────────────────────────────────────
  for (const msg of messages) {
    if (msg.role === 'system') {
      lines.push('> **System**');
      lines.push('>');
      const content = extractText(msg.content);
      for (const l of content.split('\n')) {
        lines.push(`> ${l}`);
      }
      lines.push('');
      continue;
    }

    if (msg.role === 'user') {
      lines.push('## User');
      lines.push('');
      const content = extractText(msg.content);
      lines.push(content);
      // Note if images were attached
      if (Array.isArray(msg.content) && msg.content.every(p => typeof p === 'object' && p !== null && 'type' in p)) {
        const imageCount = (msg.content as ContentPart[]).filter(p => p.type === 'image').length;
        if (imageCount > 0) {
          lines.push('');
          lines.push(`*[${imageCount} image attachment${imageCount > 1 ? 's' : ''}]*`);
        }
      }
      lines.push('');
      continue;
    }

    if (msg.role === 'assistant') {
      lines.push('## Assistant');
      lines.push('');

      // Reasoning summary (if present)
      if (msg.reasoningSummary) {
        lines.push('<details>');
        lines.push('<summary>Reasoning summary</summary>');
        lines.push('');
        lines.push(msg.reasoningSummary);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }

      // Main content
      if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
        lines.push(msg.content);
        lines.push('');
      } else if (Array.isArray(msg.content)) {
        const text = extractText(msg.content as ContentPart[]);
        if (text.trim()) {
          lines.push(text);
          lines.push('');
        }
      }

      // Tool calls
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          let argsStr: string;
          try {
            argsStr = JSON.stringify(tc.arguments, null, 2);
          } catch {
            argsStr = String(tc.arguments);
          }
          lines.push('<details>');
          lines.push(`<summary>Tool call: <code>${tc.name}</code></summary>`);
          lines.push('');
          lines.push('```json');
          lines.push(argsStr);
          lines.push('```');
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
      }

      // Accumulate token usage
      if (msg.usage) {
        totalInput     += msg.usage.inputTokens  ?? 0;
        totalOutput    += msg.usage.outputTokens ?? 0;
        totalCacheRead  += msg.usage.cacheReadTokens  ?? 0;
        totalCacheWrite += msg.usage.cacheWriteTokens ?? 0;
      }

      continue;
    }

    if (msg.role === 'tool') {
      const toolLabel = msg.toolName ? `Tool result: ${msg.toolName}` : 'Tool result';
      const content = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      const isLong = content.length > 500;

      if (isLong) {
        lines.push('<details>');
        lines.push(`<summary>${toolLabel}</summary>`);
        lines.push('');
        lines.push('```');
        lines.push(content.slice(0, 4000) + (content.length > 4000 ? '\n...(truncated)' : ''));
        lines.push('```');
        lines.push('');
        lines.push('</details>');
      } else {
        lines.push(`**${toolLabel}**`);
        lines.push('');
        lines.push('```');
        lines.push(content);
        lines.push('```');
      }
      lines.push('');
      continue;
    }
  }

  // ── Token usage summary ──────────────────────────────────────────────────
  if (totalInput > 0 || totalOutput > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Token Usage');
    lines.push('');
    lines.push('| Metric | Tokens |');
    lines.push('|--------|--------|');
    lines.push(`| Input | ${totalInput.toLocaleString()} |`);
    lines.push(`| Output | ${totalOutput.toLocaleString()} |`);
    if (totalCacheRead > 0)
      lines.push(`| Cache read | ${totalCacheRead.toLocaleString()} |`);
    if (totalCacheWrite > 0)
      lines.push(`| Cache write | ${totalCacheWrite.toLocaleString()} |`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Extract plain text from a string or ContentPart array. */
export function extractText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return (content as ContentPart[])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('');
}
