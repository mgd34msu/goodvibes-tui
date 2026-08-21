/**
 * markdown-inline.ts, inline markdown tokenizer (bold, italic, inline code,
 * links, bare URLs, absolute file paths).
 *
 * Extracted from markdown.ts so both the block renderer (markdown.ts) and the
 * table renderer (markdown-table.ts) can tokenize cell/line text without the
 * two modules importing each other. markdown.ts re-exports
 * renderInlineMarkdown so existing importers are unaffected.
 */

import type { Cell } from '@pellux/goodvibes-sdk/platform/types';

/** Module-level set of inline markdown special characters (hoisted out of hot loop). */
const INLINE_SPECIAL_CHARS = new Set(['[', '`', '*', '_', '~']);

/**
 * Inline markdown token types.
 */
export type InlineToken =
  | { type: 'text'; text: string; style: Partial<Cell> }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string };

/**
 * renderInlineMarkdown - Parse inline markdown (bold, italic, inline code, links)
 * and return a flat array of tokens with style info.
 */
export function renderInlineMarkdown(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < text.length) {
    // Link: [text](url)
    if (text[i] === '[') {
      const closeB = text.indexOf(']', i);
      if (closeB !== -1 && text[closeB + 1] === '(') {
        const closeP = text.indexOf(')', closeB + 2);
        if (closeP !== -1) {
          const linkText = text.slice(i + 1, closeB);
          const url = text.slice(closeB + 2, closeP);
          tokens.push({ type: 'link', text: linkText, url });
          i = closeP + 1;
          continue;
        }
      }
    }

    // Inline code: `code`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        tokens.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Bold+italic: ***text***
    if (text.slice(i, i + 3) === '***') {
      const end = text.indexOf('***', i + 3);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 3, end), style: { bold: true, italic: true } });
        i = end + 3;
        continue;
      }
      // No closing *** found, emit the leading * as plain text so the ** bold
      // check can handle the remaining ** on the next iteration.
      tokens.push({ type: 'text', text: '*', style: {} });
      i += 1;
      continue;
    }

    // Bold: **text**
    if (text.slice(i, i + 2) === '**') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 2, end), style: { bold: true } });
        i = end + 2;
        continue;
      }
    }

    // Italic: *text* or _text_
    // Guard: text[i - 1] !== '*' prevents the second * of ** from starting italic.
    // Guard: text[i + 1] !== text[i] prevents the first * of ** (or _ of __) from
    // starting italic when bold/underscore-bold detection failed (e.g. unclosed **).
    if (
      (text[i] === '*' || text[i] === '_') &&
      text[i - 1] !== text[i] &&
      text[i + 1] !== text[i]
    ) {
      const closer = text[i];
      const end = text.indexOf(closer, i + 1);
      if (end !== -1 && end > i + 1) {
        tokens.push({ type: 'text', text: text.slice(i + 1, end), style: { italic: true } });
        i = end + 1;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text.slice(i, i + 2) === '~~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'text', text: text.slice(i + 2, end), style: { strikethrough: true, fg: '244' } });
        i = end + 2;
        continue;
      }
    }

    // Plain text, accumulate until next special char, detect bare URLs and file paths
    let end = i + 1;
    while (end < text.length && !INLINE_SPECIAL_CHARS.has(text[end])) {
      const code = text.charCodeAt(end);
      end += (code >= 0xD800 && code <= 0xDBFF) ? 2 : 1;
    }
    const plainText = text.slice(i, end);

    // Detect http/https URLs in plain text
    const urlMatch = plainText.match(/^(https?:\/\/[^\s,)>"]+)/);
    if (urlMatch) {
      const url = urlMatch[1];
      tokens.push({ type: 'link', text: url, url });
      i += url.length;
      continue;
    }

    // Detect absolute file paths in plain text (require at least one directory separator)
    const fileMatch = plainText.match(/^(\/[^\s,)>"]+\/[^\s,)>"]+(?:\.[a-zA-Z0-9]+)?)/);
    if (fileMatch) {
      const filePath = fileMatch[1];
      const fileUrl = `file://${filePath}`;
      tokens.push({ type: 'link', text: filePath, url: fileUrl });
      i += filePath.length;
      continue;
    }

    tokens.push({ type: 'text', text: plainText, style: {} });
    i = end;
  }

  return tokens;
}
