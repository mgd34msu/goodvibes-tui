import { describe, test, expect } from 'bun:test';
import {
  redactMessage,
  exportToJSON,
  exportToHTML,
  exportToMarkdownExtended,
  defaultExportPath,
} from '@pellux/goodvibes-sdk/platform/export/session-export';
import { redactSensitiveData } from '@pellux/goodvibes-sdk/platform/utils/redaction';
import type { ExportMessage, ExportMetadata } from '@pellux/goodvibes-sdk/platform/export/session-export';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const userMsg = (content: string): ExportMessage => ({ role: 'user', content });
const assistantMsg = (content: string, usage?: ExportMessage['usage']): ExportMessage => ({
  role: 'assistant',
  content,
  ...(usage ? { usage } : {}),
});
const toolMsg = (content: string, toolName = 'bash'): ExportMessage => ({
  role: 'tool',
  content,
  toolName,
});

const basicMeta: ExportMetadata = {
  model: 'gpt-4',
  provider: 'openai',
  sessionId: 'sess-abc123',
};

const HOME_ROOT = '/tmp';

// ── redactSensitiveData ───────────────────────────────────────────────────────

describe('redactSensitiveData', () => {
  test('redacts generic sk- API keys', () => {
    const result = redactSensitiveData('key=sk-abcdefghijklmnopqrst12345');
    expect(result).toContain('[REDACTED_API_KEY]');
    expect(result).not.toContain('sk-abcdefghijklmnopqrst12345');
  });

  test('redacts key- tokens', () => {
    const result = redactSensitiveData('token: key-1234567890abcdef');
    expect(result).toContain('[REDACTED_API_KEY]');
  });

  test('redacts Bearer tokens', () => {
    const result = redactSensitiveData('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig');
    expect(result).toContain('Bearer [REDACTED_TOKEN]');
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });

  test('redacts GitHub ghp_ tokens', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    expect(redactSensitiveData(`token=${token}`)).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  test('redacts GitHub gho_ tokens', () => {
    const token = 'gho_' + 'B'.repeat(36);
    expect(redactSensitiveData(token)).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  test('redacts github_pat_ tokens', () => {
    const token = 'github_pat_' + 'C'.repeat(36);
    expect(redactSensitiveData(token)).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  test('redacts GitLab glpat- tokens', () => {
    const token = 'glpat-' + 'D'.repeat(20);
    expect(redactSensitiveData(token)).toContain('[REDACTED_GITLAB_TOKEN]');
  });

  test('redacts Slack xoxb- tokens', () => {
    const token = 'xoxb-' + '1'.repeat(24);
    expect(redactSensitiveData(token)).toContain('[REDACTED_SLACK_TOKEN]');
  });

  test('redacts Slack xoxp- tokens', () => {
    const token = 'xoxp-' + '2'.repeat(24);
    expect(redactSensitiveData(token)).toContain('[REDACTED_SLACK_TOKEN]');
  });

  test('redacts AWS AKIA access key IDs', () => {
    // Must be exactly AKIA + 16 uppercase alphanums
    const key = 'AKIA' + 'A1B2C3D4E5F6G7H8';
    expect(redactSensitiveData(key)).toContain('[REDACTED_AWS_KEY]');
  });

  test('redacts Linux /home/ paths', () => {
    const result = redactSensitiveData('file at /home/alice/projects/foo.ts');
    expect(result).toContain('/home/[REDACTED]');
    expect(result).not.toContain('/home/alice');
  });

  test('redacts macOS /Users/ paths', () => {
    const result = redactSensitiveData('reading /Users/bob/Documents/secret.key');
    expect(result).toContain('/Users/[REDACTED]');
    expect(result).not.toContain('/Users/bob');
  });

  test('redacts Windows C:\\Users\\ paths', () => {
    const result = redactSensitiveData('path C:\\Users\\carol\\AppData\\secret');
    expect(result).toContain('C:\\Users\\[REDACTED]');
    expect(result).not.toContain('carol');
  });

  test('leaves clean text unchanged', () => {
    const clean = 'Hello, world! No secrets here.';
    expect(redactSensitiveData(clean)).toBe(clean);
  });

  test('handles empty string', () => {
    expect(redactSensitiveData('')).toBe('');
  });

  test('does not redact short sk- patterns (bypass attempt)', () => {
    // Keys shorter than 20 chars after the prefix must NOT be redacted
    const short = 'sk-short';
    expect(redactSensitiveData(short)).toBe(short);
  });

  test('does not redact AKIA keys shorter than 16 chars (bypass attempt)', () => {
    const short = 'AKIA123'; // only 7 alphanums after AKIA
    expect(redactSensitiveData(short)).toBe(short);
  });
});

// ── redactMessage ─────────────────────────────────────────────────────────────

describe('redactMessage', () => {
  test('redacts string content', () => {
    const msg = userMsg('my key is sk-' + 'x'.repeat(20));
    const out = redactMessage(msg);
    expect(typeof out.content).toBe('string');
    expect(out.content as string).toContain('[REDACTED_API_KEY]');
  });

  test('redacts ContentPart text parts', () => {
    const msg: ExportMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'path is /home/alice/file.ts' },
        { type: 'image', data: 'abc', mediaType: 'image/png' },
      ],
    };
    const out = redactMessage(msg);
    const parts = out.content as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain('/home/[REDACTED]');
    // Image parts are untouched
    expect((parts[1] as { type: string; data: string }).data).toBe('abc');
  });

  test('redacts reasoningContent', () => {
    const msg: ExportMessage = {
      role: 'assistant',
      content: 'ok',
      reasoningContent: 'using key sk-' + 'y'.repeat(20),
    };
    const out = redactMessage(msg);
    expect(out.reasoningContent).toContain('[REDACTED_API_KEY]');
  });

  test('redacts reasoningSummary', () => {
    const msg: ExportMessage = {
      role: 'assistant',
      content: 'done',
      reasoningSummary: 'Bearer abc.def.ghi',
    };
    const out = redactMessage(msg);
    expect(out.reasoningSummary).toContain('[REDACTED_TOKEN]');
  });

  test('redacts toolCall arguments', () => {
    const msg: ExportMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'tc1',
        name: 'bash',
        arguments: { cmd: 'cat /home/eve/secrets.txt', env: { KEY: 'sk-' + 'k'.repeat(20) } },
      }],
    };
    const out = redactMessage(msg);
    const args = out.toolCalls![0].arguments;
    expect(args.cmd).toContain('/home/[REDACTED]');
    expect((args.env as { KEY: string }).KEY).toContain('[REDACTED_API_KEY]');
  });

  test('does not mutate the original message', () => {
    const original = 'sk-' + 'o'.repeat(20);
    const msg = userMsg(original);
    redactMessage(msg);
    expect(msg.content).toBe(original);
  });
});

// ── exportToJSON ──────────────────────────────────────────────────────────────

describe('exportToJSON', () => {
  test('produces valid JSON', () => {
    const json = exportToJSON([userMsg('hello')], basicMeta);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('output structure has expected top-level keys', () => {
    const payload = JSON.parse(exportToJSON([userMsg('hi')], basicMeta));
    expect(payload).toHaveProperty('version', 1);
    expect(payload).toHaveProperty('exportedAt');
    expect(payload).toHaveProperty('redacted', false);
    expect(payload).toHaveProperty('metadata');
    expect(payload).toHaveProperty('tokenUsage');
    expect(payload).toHaveProperty('messages');
  });

  test('sums token usage across messages', () => {
    const msgs: ExportMessage[] = [
      assistantMsg('a', { inputTokens: 10, outputTokens: 5 }),
      assistantMsg('b', { inputTokens: 20, outputTokens: 15 }),
    ];
    const payload = JSON.parse(exportToJSON(msgs, basicMeta));
    expect(payload.tokenUsage.inputTokens).toBe(30);
    expect(payload.tokenUsage.outputTokens).toBe(20);
  });

  test('sums cache token fields when present', () => {
    const msgs: ExportMessage[] = [
      assistantMsg('x', { inputTokens: 5, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 200 }),
      assistantMsg('y', { inputTokens: 5, outputTokens: 5, cacheReadTokens: 50, cacheWriteTokens: 25 }),
    ];
    const payload = JSON.parse(exportToJSON(msgs, basicMeta));
    expect(payload.tokenUsage.cacheReadTokens).toBe(150);
    expect(payload.tokenUsage.cacheWriteTokens).toBe(225);
  });

  test('omits cache keys when totals are zero', () => {
    const msgs: ExportMessage[] = [assistantMsg('x', { inputTokens: 1, outputTokens: 1 })];
    const payload = JSON.parse(exportToJSON(msgs, basicMeta));
    expect(payload.tokenUsage).not.toHaveProperty('cacheReadTokens');
    expect(payload.tokenUsage).not.toHaveProperty('cacheWriteTokens');
  });

  test('embeds cost in metadata when provided', () => {
    const payload = JSON.parse(exportToJSON([userMsg('hi')], basicMeta, { cost: 0.005 }));
    expect(payload.metadata.costUsd).toBeCloseTo(0.005);
  });

  test('redacts content when redact=true', () => {
    const secret = 'sk-' + 's'.repeat(20);
    const payload = JSON.parse(exportToJSON([userMsg(`key: ${secret}`)], basicMeta, { redact: true }));
    expect(payload.redacted).toBe(true);
    expect(JSON.stringify(payload.messages)).not.toContain(secret);
    expect(JSON.stringify(payload.messages)).toContain('[REDACTED_API_KEY]');
  });

  test('does not redact when redact=false (default)', () => {
    const secret = 'sk-' + 't'.repeat(20);
    const payload = JSON.parse(exportToJSON([userMsg(`key: ${secret}`)], basicMeta));
    expect(payload.redacted).toBe(false);
    expect(JSON.stringify(payload.messages)).toContain(secret);
  });

  test('preserves messages order', () => {
    const msgs = [userMsg('first'), assistantMsg('second'), toolMsg('third')];
    const payload = JSON.parse(exportToJSON(msgs, basicMeta));
    expect(payload.messages[0].content).toBe('first');
    expect(payload.messages[2].content).toBe('third');
  });
});

// ── exportToHTML ──────────────────────────────────────────────────────────────

describe('exportToHTML', () => {
  const xssPayload = '<script>alert(1)</script>';

  test('produces a complete HTML document', () => {
    const html = exportToHTML([userMsg('hello')], basicMeta);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  test('escapes XSS in user message content', () => {
    const html = exportToHTML([userMsg(xssPayload)], basicMeta);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes XSS in assistant message content', () => {
    const html = exportToHTML([assistantMsg(xssPayload)], basicMeta);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes XSS in tool result content', () => {
    const html = exportToHTML([toolMsg(xssPayload)], basicMeta);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes XSS in tool call name', () => {
    const msg: ExportMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'x', name: '<img onerror=alert(1)>', arguments: {} }],
    };
    const html = exportToHTML([msg], basicMeta);
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;img');
  });

  test('escapes XSS in reasoning summary', () => {
    const msg: ExportMessage = { role: 'assistant', content: '', reasoningSummary: xssPayload };
    const html = exportToHTML([msg], basicMeta);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes XSS in metadata fields (title)', () => {
    const html = exportToHTML([userMsg('hi')], { ...basicMeta, title: xssPayload });
    expect(html).not.toContain('<script>');
  });

  test('escapes mediaType in image data URI', () => {
    const msg: ExportMessage = {
      role: 'user',
      content: [{ type: 'image', data: 'abc', mediaType: 'image/png"><script>alert(1)</script>' }],
    };
    const html = exportToHTML([msg], basicMeta);
    expect(html).not.toContain('<script>');
  });

  test('truncates long tool results', () => {
    const longContent = 'x'.repeat(5000);
    const html = exportToHTML([toolMsg(longContent)], basicMeta);
    expect(html).toContain('(truncated)');
  });

  test('skips system messages', () => {
    const msgs: ExportMessage[] = [
      { role: 'system', content: 'you are a helpful assistant' },
      userMsg('hi'),
    ];
    const html = exportToHTML(msgs, basicMeta);
    expect(html).not.toContain('you are a helpful assistant');
  });

  test('includes cost in usage section when provided', () => {
    const html = exportToHTML([userMsg('hi')], basicMeta, { cost: 0.001234 });
    expect(html).toContain('0.001234');
  });

  test('applies redaction to user content when redact=true', () => {
    const secret = 'sk-' + 'r'.repeat(20);
    const html = exportToHTML([userMsg(`key: ${secret}`)], basicMeta, { redact: true });
    expect(html).not.toContain(secret);
    expect(html).toContain('[REDACTED_API_KEY]');
  });
});

// ── exportToMarkdownExtended ──────────────────────────────────────────────────

describe('exportToMarkdownExtended', () => {
  test('returns a non-empty string', () => {
    const md = exportToMarkdownExtended([userMsg('hello')], basicMeta);
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(0);
  });

  test('appends cost section when cost > 0', () => {
    const md = exportToMarkdownExtended([userMsg('hi')], basicMeta, { cost: 0.002 });
    expect(md).toContain('## Cost');
    expect(md).toContain('0.002000');
  });

  test('does not append cost section when cost is zero', () => {
    const md = exportToMarkdownExtended([userMsg('hi')], basicMeta, { cost: 0 });
    expect(md).not.toContain('## Cost');
  });

  test('does not append cost section when cost is undefined', () => {
    const md = exportToMarkdownExtended([userMsg('hi')], basicMeta);
    expect(md).not.toContain('## Cost');
  });

  test('passes redaction through to messages', () => {
    const secret = 'sk-' + 'm'.repeat(20);
    const md = exportToMarkdownExtended([userMsg(`key=${secret}`)], basicMeta, { redact: true });
    expect(md).not.toContain(secret);
    expect(md).toContain('[REDACTED_API_KEY]');
  });

  test('does not redact when redact=false', () => {
    const secret = 'sk-' + 'n'.repeat(20);
    const md = exportToMarkdownExtended([userMsg(`key=${secret}`)], basicMeta, { redact: false });
    expect(md).toContain(secret);
  });
});

// ── renderMarkdownToHtml (via exportToHTML) ───────────────────────────────────

describe('renderMarkdownToHtml (via exportToHTML)', () => {
  const render = (md: string): string => exportToHTML([userMsg(md)], basicMeta);

  test('renders H1 headings', () => {
    const html = render('# My Title');
    expect(html).toContain('<h1>');
    expect(html).toContain('My Title');
  });

  test('renders H2 headings', () => {
    const html = render('## Section');
    expect(html).toContain('<h2>');
  });

  test('renders H3 headings for H3-H6', () => {
    const html = render('### Sub');
    expect(html).toContain('<h3>');
  });

  test('renders fenced code blocks', () => {
    const html = render('```ts\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  test('applies language class to fenced code blocks', () => {
    const html = render('```python\nprint(1)\n```');
    expect(html).toContain('language-python');
  });

  test('handles unclosed fenced block gracefully (flushes at end)', () => {
    const html = render('```ts\nconst y = 2;');
    expect(html).toContain('const y = 2;');
    // Should not throw and should contain the content
  });

  test('handles nested triple-backtick patterns inside fence', () => {
    // Inner ``` on a non-start of line is just content
    const html = render('```\nsome ``` content\n```');
    expect(html).toContain('<pre>');
  });

  test('renders paragraphs for plain text', () => {
    const html = render('Hello world');
    expect(html).toContain('<p>');
    expect(html).toContain('Hello world');
  });

  test('blank line separates paragraphs', () => {
    const html = render('First para\n\nSecond para');
    const count = (html.match(/<p>/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('renders bold inline markdown', () => {
    const html = render('**bold text**');
    expect(html).toContain('<strong>');
  });

  test('renders italic inline markdown', () => {
    const html = render('*italic text*');
    expect(html).toContain('<em>');
  });

  test('renders inline code', () => {
    const html = render('use `myFunc()` here');
    expect(html).toContain('<code>');
    expect(html).toContain('myFunc()');
  });

  test('escapes HTML entities in inline markdown', () => {
    const html = render('1 < 2 and 3 > 2');
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).not.toContain('1 < 2');
  });
});

// ── defaultExportPath ─────────────────────────────────────────────────────────

describe('defaultExportPath', () => {
  test('returns a string path', () => {
    const p = defaultExportPath('html', HOME_ROOT);
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  test('uses correct extension for html', () => {
    expect(defaultExportPath('html', HOME_ROOT)).toMatch(/\.html$/);
  });

  test('uses correct extension for json', () => {
    expect(defaultExportPath('json', HOME_ROOT)).toMatch(/\.json$/);
  });

  test('uses correct extension for md', () => {
    expect(defaultExportPath('md', HOME_ROOT)).toMatch(/\.md$/);
  });

  test('includes session- prefix in filename', () => {
    expect(defaultExportPath('html', HOME_ROOT)).toContain('session-');
  });

  test('path contains timestamp in ISO-ish format', () => {
    // Format: session-YYYY-MM-DDTHH-MM-SS.html (colons replaced with dashes)
    const p = defaultExportPath('html', HOME_ROOT);
    expect(p).toMatch(/session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.html/);
  });

  test('is under goodvibes-exports directory', () => {
    expect(defaultExportPath('json', HOME_ROOT)).toContain('goodvibes-exports');
  });

  test('is an absolute path', () => {
    expect(defaultExportPath('md', HOME_ROOT)).toMatch(/^\//);
  });
});
