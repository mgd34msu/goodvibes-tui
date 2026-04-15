import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectMarkdownReferences,
  extractMarkdownPreview,
  materializeMarkdownBody,
  parseMarkdownFrontmatter,
  readMarkdownDisclosure,
} from '@pellux/goodvibes-sdk/platform/utils/markdown-disclosure';

describe('markdown disclosure', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gv-markdown-disclosure-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('parses frontmatter and preserves body', () => {
    const parsed = parseMarkdownFrontmatter([
      '---',
      'name: demo',
      'triggers:',
      '  - /demo',
      '  - /test',
      '---',
      '',
      'Body text.',
    ].join('\n'));

    expect(parsed.metadata.name).toBe('demo');
    expect(parsed.metadata.triggers).toEqual(['/demo', '/test']);
    expect(parsed.body).toContain('Body text.');
  });

  test('collects @ references and preview text', () => {
    const body = '# Heading\n\n@part.md\n\nThis is the useful preview text.\n';
    expect(collectMarkdownReferences(body)).toEqual(['part.md']);
    expect(extractMarkdownPreview(body)).toContain('This is the useful preview text.');
  });

  test('materializes @ references lazily from the body', () => {
    writeFileSync(join(dir, 'part.md'), 'Included body.', 'utf-8');
    const main = join(dir, 'main.md');
    writeFileSync(main, ['---', 'name: main', '---', '', 'Before', '@part.md', 'After'].join('\n'), 'utf-8');

    const disclosure = readMarkdownDisclosure(main);
    expect(disclosure.includes).toEqual(['part.md']);
    expect(materializeMarkdownBody(main, disclosure.body)).toContain('Included body.');
  });
});
