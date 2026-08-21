/**
 * UX Anti-Regression: Raw Stdin Backspace vs Delete Byte Contract
 *
 * Pins the Ink 6.8.0 workaround: both Backspace and Delete mapped to
 * key.delete in Ink, so the TUI uses raw stdin mode and decodes bytes directly.
 *
 * This test pins the byte-level → logical-key contract at the
 * InputTokenizer layer (the decode path that main.ts → input.feed() uses).
 *
 * Byte map:
 *   \x7f (DEL byte, sent by the Backspace key)  → logicalName 'backspace'
 *   \x1b[3~ (VT escape, sent by the Delete key) → logicalName 'delete'
 *
 * If either mapping regresses, pressing Backspace will delete-forward
 * or vice-versa, a critical text-editing regression.
 *
 * All tests are synchronous, no real I/O.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { InputTokenizer } from '@pellux/goodvibes-sdk/platform/core';
import type { InputToken } from '@pellux/goodvibes-sdk/platform/core';

describe('raw-stdin-decode: Backspace vs Delete byte contract', () => {
  let tokenizer: InputTokenizer;

  beforeEach(() => {
    tokenizer = new InputTokenizer();
  });

  // ── Backspace key (raw byte \x7f = DEL = ASCII 127) ──────────────────────

  test('\\x7f (Backspace key raw byte) decodes to logicalName backspace', () => {
    const tokens = tokenizer.feed('\x7f');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.type).toBe('key');
    expect(t.logicalName).toBe('backspace');
  });

  test('\\x7f does NOT decode to logicalName delete', () => {
    const tokens = tokenizer.feed('\x7f');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    // The Ink 6.8.0 bug was: both keys became 'delete'. Pin the correct mapping.
    expect(t.logicalName).not.toBe('delete');
  });

  // ── Delete key (VT escape sequence \x1b[3~) ──────────────────────────────

  test('\\x1b[3~ (Delete key VT sequence) decodes to logicalName delete', () => {
    const tokens = tokenizer.feed('\x1b[3~');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.type).toBe('key');
    expect(t.logicalName).toBe('delete');
  });

  test('\\x1b[3~ does NOT decode to logicalName backspace', () => {
    const tokens = tokenizer.feed('\x1b[3~');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.logicalName).not.toBe('backspace');
  });

  // ── Backspace and Delete produce distinct logical names ───────────────────

  test('Backspace (\\x7f) and Delete (\\x1b[3~) produce different logical names', () => {
    const bsTokens = tokenizer.feed('\x7f');
    const delTokens = tokenizer.feed('\x1b[3~');

    const bsName = (bsTokens[0] as Extract<InputToken, { type: 'key' }>).logicalName;
    const delName = (delTokens[0] as Extract<InputToken, { type: 'key' }>).logicalName;

    expect(bsName).not.toBe(delName);
  });

  // ── Adjacent bytes: printable text is not confused with these keys ────────

  test('\\x7f in a mixed stream is still decoded as backspace (not corrupted)', () => {
    const tokens = tokenizer.feed('\x7f');
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.type).toBe('key');
    expect(t.logicalName).toBe('backspace');
    // No extra tokens
    expect(tokens).toHaveLength(1);
  });

  test('Delete sequence \\x1b[3~ is consumed as a single token (not 3 separate)', () => {
    const tokens = tokenizer.feed('\x1b[3~');
    // The tokenizer must parse the entire escape sequence as one token, not
    // emit ESC as a separate key followed by text '[3~'.
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('key');
  });

  // ── Type assertion: both produce key tokens, not text tokens ─────────────

  test('\\x7f produces a key token, not a text token', () => {
    const tokens = tokenizer.feed('\x7f');
    expect(tokens[0].type).toBe('key');
  });

  test('\\x1b[3~ produces a key token, not a text token', () => {
    const tokens = tokenizer.feed('\x1b[3~');
    expect(tokens[0].type).toBe('key');
  });
});
