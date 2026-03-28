import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ContentPart } from '../providers/interface.ts';
import { exportToMarkdown, extractText, type ExportMessage, type ExportMetadata } from './markdown.ts';

// ── Public Types ─────────────────────────────────────────────────────────────

export type { ExportMessage, ExportMetadata };

export interface ExportOptions {
  /** Redact API keys, absolute file paths, and other sensitive data. */
  redact?: boolean;
}

export interface SessionExportData {
  messages: ExportMessage[];
  metadata?: ExportMetadata;
  /** Cost in USD, if tracked. */
  cost?: number;
  /** ISO timestamp of export. */
  exportedAt?: string;
}

// ── Sensitive-data redaction ──────────────────────────────────────────────────

/** Patterns that identify sensitive content — API keys and absolute paths. */
const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Generic API key patterns (sk-*, key-*, bearer tokens)
  { pattern: /\b(sk-[A-Za-z0-9_-]{20,})/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\b(key-[A-Za-z0-9_-]{16,})/g, replacement: '[REDACTED_API_KEY]' },
  // Bearer / Authorization header values
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, replacement: '$1[REDACTED_TOKEN]' },
  // GitHub tokens
  { pattern: /\b(ghp_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(gho_[A-Za-z0-9]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{36,})/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  // GitLab tokens
  { pattern: /\b(glpat-[A-Za-z0-9_-]{20,})/g, replacement: '[REDACTED_GITLAB_TOKEN]' },
  // Slack tokens
  { pattern: /\b(xoxb-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  { pattern: /\b(xoxp-[A-Za-z0-9-]{24,})/g, replacement: '[REDACTED_SLACK_TOKEN]' },
  // AWS access keys
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // Absolute Unix paths starting from home (e.g. /home/alice/projects/...)
  { pattern: /\/home\/[A-Za-z0-9_.-]+/g, replacement: '/home/[REDACTED]' },
  // Absolute Unix paths in /Users (macOS)
  { pattern: /\/Users\/[A-Za-z0-9_.-]+/g, replacement: '/Users/[REDACTED]' },
  // Windows user paths (C:\Users\username\...)
  { pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+/g, replacement: 'C:\\Users\\[REDACTED]' },
];

export function redactSensitiveData(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ── Message redaction helper ─────────────────────────────────────────────────

/**
 * redactMessage - Deep-clone a message and redact all string fields that may
 * contain sensitive data (content, reasoning, tool arguments).
 */
export function redactMessage(msg: ExportMessage): ExportMessage {
  const clone = structuredClone(msg) as ExportMessage;
  if (typeof clone.content === 'string') {
    clone.content = redactSensitiveData(clone.content);
  } else if (Array.isArray(clone.content)) {
    clone.content = (clone.content as ContentPart[]).map(part => {
      if (part.type === 'text') {
        return { ...part, text: redactSensitiveData(part.text) };
      }
      return part;
    });
  }
  if (clone.reasoningContent) clone.reasoningContent = redactSensitiveData(clone.reasoningContent);
  if (clone.reasoningSummary) clone.reasoningSummary = redactSensitiveData(clone.reasoningSummary);
  if (clone.toolCalls) {
    clone.toolCalls = clone.toolCalls.map(tc => ({
      ...tc,
      arguments: redactArgs(tc.arguments),
    }));
  }
  return clone;
}

// ── JSON export ───────────────────────────────────────────────────────────────

/**
 * exportToJSON - Serialize a session to machine-readable JSON.
 *
 * Output includes metadata (model, provider, session ID, timestamp, token
 * usage totals, cost), then the full message array with all fields preserved.
 */
export function exportToJSON(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
  options: ExportOptions & { cost?: number } = {},
): string {
  const { redact = false, cost } = options;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  const processedMessages = messages.map(msg => {
    if (msg.usage) {
      totalInput     += msg.usage.inputTokens  ?? 0;
      totalOutput    += msg.usage.outputTokens ?? 0;
      totalCacheRead  += msg.usage.cacheReadTokens  ?? 0;
      totalCacheWrite += msg.usage.cacheWriteTokens ?? 0;
    }

    if (!redact) return msg;
    return redactMessage(msg);
  });

  const usage = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    ...(totalCacheRead  > 0 ? { cacheReadTokens: totalCacheRead }   : {}),
    ...(totalCacheWrite > 0 ? { cacheWriteTokens: totalCacheWrite } : {}),
  };

  const payload: Record<string, unknown> = {
    version: 1,
    exportedAt: new Date().toISOString(),
    redacted: redact,
    metadata: {
      ...(metadata ?? {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    },
    tokenUsage: usage,
    messages: processedMessages,
  };

  return JSON.stringify(payload, null, 2);
}

/** Recursively redact string values inside tool arguments. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      out[k] = redactSensitiveData(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map(item => typeof item === 'string' ? redactSensitiveData(item) : (item !== null && typeof item === 'object' && !Array.isArray(item)) ? redactArgs(item as Record<string, unknown>) : item);
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactArgs(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Markdown export (extended wrapper) ───────────────────────────────────────

/**
 * exportToMarkdownExtended - Wrapper around markdown.ts exportToMarkdown that
 * adds cost information and optional redaction.
 */
export function exportToMarkdownExtended(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
  options: ExportOptions & { cost?: number } = {},
): string {
  const { redact = false, cost } = options;

  const processedMessages = redact ? messages.map(redactMessage) : messages;

  const md = exportToMarkdown(processedMessages, metadata);

  // Append cost if provided
  if (cost !== undefined && cost > 0) {
    const costLines: string[] = [
      '',
      '## Cost',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Estimated cost | $${cost.toFixed(6)} USD |`,
      '',
    ];
    return md + costLines.join('\n');
  }

  return md;
}

// ── HTML export ───────────────────────────────────────────────────────────────

/** Maximum characters of tool result content to include in the HTML export. */
const MAX_TOOL_RESULT_LENGTH = 4000;

/**
 * exportToHTML - Generate a self-contained, styled HTML document from a
 * conversation. Features:
 *
 * - Embedded CSS (dark theme, readable typography)
 * - Syntax-highlighted fenced code blocks (language class on <code>)
 * - Collapsible <details> sections for tool calls and tool results
 * - Metadata table in the header
 * - Token usage and cost summary at the foot
 */
export function exportToHTML(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
  options: ExportOptions & { cost?: number } = {},
): string {
  const { redact = false, cost } = options;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const title = metadata?.title || metadata?.sessionId || 'Conversation';

  const sections: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // skip system messages in HTML

    if (msg.role === 'user') {
      const rawContent = extractText(msg.content);
      const content = redact ? redactSensitiveData(rawContent) : rawContent;
      const images: Array<{ type: 'image'; data: string; mediaType: string }> = Array.isArray(msg.content)
        ? (msg.content as ContentPart[]).filter((p): p is { type: 'image'; data: string; mediaType: string } => p.type === 'image')
        : [];

      let html = `<div class="message user">`;
      html += `<div class="message-header"><span class="role">User</span></div>`;
      html += `<div class="message-body">${renderMarkdownToHtml(content)}</div>`;
      if (images.length > 0) {
        html += `<div class="attachments">`;
        for (const img of images) {
          html += `<img src="data:${escapeHtml(img.mediaType)};base64,${img.data}" alt="attachment" class="attachment-image" />`;
        }
        html += `</div>`;
      }
      html += `</div>`;
      sections.push(html);
      continue;
    }

    if (msg.role === 'assistant') {
      const rawContent = extractText(msg.content);
      const content = redact ? redactSensitiveData(rawContent) : rawContent;

      if (msg.usage) {
        totalInput     += msg.usage.inputTokens  ?? 0;
        totalOutput    += msg.usage.outputTokens ?? 0;
        totalCacheRead  += msg.usage.cacheReadTokens  ?? 0;
        totalCacheWrite += msg.usage.cacheWriteTokens ?? 0;
      }

      let html = `<div class="message assistant">`;
      html += `<div class="message-header"><span class="role">Assistant</span></div>`;
      html += `<div class="message-body">`;

      if (msg.reasoningSummary) {
        const summary = redact ? redactSensitiveData(msg.reasoningSummary) : msg.reasoningSummary;
        html += `<details class="reasoning">`;
        html += `<summary>Reasoning summary</summary>`;
        html += `<div class="details-body">${escapeHtml(summary)}</div>`;
        html += `</details>`;
      }

      if (content.trim()) {
        html += renderMarkdownToHtml(content);
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          let args: string;
          try {
            const processedArgs = redact ? redactArgs(tc.arguments) : tc.arguments;
            args = JSON.stringify(processedArgs, null, 2);
          } catch {
            args = String(tc.arguments);
          }
          html += `<details class="tool-call">`;
          html += `<summary>Tool call: <code>${escapeHtml(tc.name)}</code></summary>`;
          html += `<div class="details-body"><pre><code class="language-json">${escapeHtml(args)}</code></pre></div>`;
          html += `</details>`;
        }
      }

      html += `</div></div>`;
      sections.push(html);
      continue;
    }

    if (msg.role === 'tool') {
      const rawContent = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      const content = redact ? redactSensitiveData(rawContent) : rawContent;
      const toolLabel = msg.toolName ? `Tool result: ${escapeHtml(msg.toolName)}` : 'Tool result';
      const truncated = content.length > MAX_TOOL_RESULT_LENGTH ? content.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n...(truncated)' : content;

      let html = `<div class="message tool">`;
      html += `<details class="tool-result">`;
      html += `<summary>${toolLabel}</summary>`;
      html += `<div class="details-body"><pre><code>${escapeHtml(truncated)}</code></pre></div>`;
      html += `</details>`;
      html += `</div>`;
      sections.push(html);
      continue;
    }
  }

  // Build metadata rows
  const metaRows: string[] = [
    `<tr><th>Date</th><td>${escapeHtml(dateStr)}</td></tr>`,
  ];
  if (metadata?.model)     metaRows.push(`<tr><th>Model</th><td>${escapeHtml(metadata.model)}</td></tr>`);
  if (metadata?.provider)  metaRows.push(`<tr><th>Provider</th><td>${escapeHtml(metadata.provider)}</td></tr>`);
  if (metadata?.sessionId) metaRows.push(`<tr><th>Session</th><td>${escapeHtml(metadata.sessionId)}</td></tr>`);
  if (redact)              metaRows.push(`<tr><th>Redacted</th><td>Yes</td></tr>`);

  // Build usage rows
  const usageRows: string[] = [];
  if (totalInput > 0 || totalOutput > 0) {
    usageRows.push(
      `<tr><th>Input tokens</th><td>${totalInput.toLocaleString()}</td></tr>`,
      `<tr><th>Output tokens</th><td>${totalOutput.toLocaleString()}</td></tr>`,
    );
    if (totalCacheRead  > 0) usageRows.push(`<tr><th>Cache read tokens</th><td>${totalCacheRead.toLocaleString()}</td></tr>`);
    if (totalCacheWrite > 0) usageRows.push(`<tr><th>Cache write tokens</th><td>${totalCacheWrite.toLocaleString()}</td></tr>`);
  }
  if (cost !== undefined && cost > 0) {
    usageRows.push(`<tr><th>Estimated cost</th><td>$${cost.toFixed(6)} USD</td></tr>`);
  }

  const usageSection = usageRows.length > 0
    ? `<section class="usage"><h2>Usage</h2><table>${usageRows.join('')}</table></section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<article class="session">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <table class="meta">${metaRows.join('')}</table>
  </header>
  <div class="messages">
${sections.map(s => '    ' + s).join('\n')}
  </div>
${usageSection}
</article>
</body>
</html>`;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Escape characters that are special in HTML. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** Minimal Markdown-to-HTML renderer (bold, italic, code, fenced blocks, headers, paragraphs). */
function renderMarkdownToHtml(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  let fenceLines: string[] = [];
  let inParagraph = false;

  const flushParagraph = () => {
    if (inParagraph) {
      out.push('</p>');
      inParagraph = false;
    }
  };

  const flushFence = () => {
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
    out.push(`<pre><code${langClass}>${fenceLines.map(escapeHtml).join('\n')}</code></pre>`);
    fenceLines = [];
    fenceLang = '';
    inFence = false;
  };

  for (const line of lines) {
    if (inFence) {
      if (line.trimStart().startsWith('```')) {
        flushParagraph();
        flushFence();
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    // Fenced code block start
    const fenceMatch = line.match(/^(`{3,})(\w*)/);
    if (fenceMatch) {
      flushParagraph();
      inFence = true;
      fenceLang = fenceMatch[2] ?? '';
      continue;
    }

    // ATX headings
    const h3 = line.match(/^#{3,6}\s+(.*)/);
    if (h3) { flushParagraph(); out.push(`<h3>${inlineMarkdown(h3[1])}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) { flushParagraph(); out.push(`<h2>${inlineMarkdown(h2[1])}</h2>`); continue; }
    const h1 = line.match(/^#\s+(.*)/);
    if (h1) { flushParagraph(); out.push(`<h1>${inlineMarkdown(h1[1])}</h1>`); continue; }

    // Blank line ends paragraph
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Inline content — wrap in paragraph
    if (!inParagraph) {
      out.push('<p>');
      inParagraph = true;
    } else {
      out.push('<br />');
    }
    out.push(inlineMarkdown(line));
  }

  if (inFence) flushFence();
  flushParagraph();

  return out.join('\n');
}

/** Apply inline Markdown: bold, italic, inline code. */
function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    // Bold before italic so **word** is processed before *word*
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}



// ── Embedded CSS ──────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  background: #0d1117;
  color: #c9d1d9;
  margin: 0;
  padding: 24px 16px;
}

article.session {
  max-width: 860px;
  margin: 0 auto;
}

header h1 {
  font-size: 1.4em;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0 0 12px;
}

table.meta, table {
  border-collapse: collapse;
  margin-bottom: 24px;
  width: 100%;
}

table.meta th, table.meta td,
table th, table td {
  padding: 6px 12px;
  border: 1px solid #30363d;
  text-align: left;
}

table.meta th, table th {
  color: #8b949e;
  font-weight: normal;
  background: #161b22;
  width: 140px;
}

.messages { display: flex; flex-direction: column; gap: 16px; }

.message {
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #30363d;
}

.message.user { border-color: #1f6feb; }
.message.assistant { border-color: #388bfd33; }
.message.tool { border-color: #30363d; }

.message-header {
  padding: 6px 14px;
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.message.user    .message-header { background: #1f6feb22; color: #58a6ff; }
.message.assistant .message-header { background: #388bfd11; color: #79c0ff; }

.message-body { padding: 14px; }

p { margin: 0 0 10px; }
p:last-child { margin-bottom: 0; }

pre {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 14px;
  overflow-x: auto;
  margin: 10px 0;
}

code {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.875em;
}

pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
  color: #e6edf3;
}

:not(pre) > code {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 1px 6px;
  color: #e6edf3;
}

details {
  margin: 8px 0;
  border: 1px solid #30363d;
  border-radius: 6px;
  overflow: hidden;
}

details summary {
  padding: 8px 14px;
  cursor: pointer;
  background: #161b22;
  color: #8b949e;
  font-size: 0.85em;
  user-select: none;
  list-style: none;
}

details summary:hover { background: #1c2128; color: #c9d1d9; }
details[open] summary { border-bottom: 1px solid #30363d; color: #c9d1d9; }

details.reasoning summary { color: #7ee787; }
details.tool-call  summary code { color: #d2a8ff; }

.details-body { padding: 12px 14px; background: #0d1117; }
.details-body pre { margin: 0; }

.attachment-image {
  max-width: 100%;
  border-radius: 6px;
  margin-top: 10px;
  border: 1px solid #30363d;
}

section.usage {
  margin-top: 32px;
  border-top: 1px solid #30363d;
  padding-top: 16px;
}

section.usage h2 {
  font-size: 1em;
  font-weight: 600;
  color: #8b949e;
  margin: 0 0 10px;
}

h1 { font-size: 1.25em; color: #f0f6fc; }
h2 { font-size: 1.1em;  color: #f0f6fc; margin: 16px 0 8px; }
h3 { font-size: 1em;   color: #f0f6fc; margin: 14px 0 6px; }

strong { color: #f0f6fc; }
em { color: #a5d6ff; font-style: italic; }
`.trim();

// ── Default export path ───────────────────────────────────────────────────────

/**
 * defaultExportPath - Build the default output path for a share export.
 *
 * Format: ~/goodvibes-exports/session-<timestamp>.<ext>
 */
export function defaultExportPath(format: 'html' | 'json' | 'md'): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(homedir(), 'goodvibes-exports', `session-${ts}.${format}`);
}
