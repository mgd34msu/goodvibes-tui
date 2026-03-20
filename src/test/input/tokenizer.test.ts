import { describe, test, expect, beforeEach } from 'bun:test';
import { InputTokenizer } from '../../core/tokenizer.ts';
import type { InputToken } from '../../core/tokenizer.ts';

describe('InputTokenizer', () => {
  let tokenizer: InputTokenizer;

  beforeEach(() => {
    tokenizer = new InputTokenizer();
  });

  describe('plain text', () => {
    test('single printable char produces text token', () => {
      const tokens = tokenizer.feed('a');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('text');
      expect((tokens[0] as Extract<InputToken, { type: 'text' }>).value).toBe('a');
    });

    test('multiple printable chars produce individual text tokens', () => {
      const tokens = tokenizer.feed('hi');
      expect(tokens).toHaveLength(2);
      expect(tokens[0].type).toBe('text');
      expect(tokens[1].type).toBe('text');
    });

    test('space is a text token', () => {
      const tokens = tokenizer.feed(' ');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('text');
      expect((tokens[0] as Extract<InputToken, { type: 'text' }>).value).toBe(' ');
    });
  });

  describe('control keys', () => {
    test('Enter (\\r) produces key token with logicalName=enter', () => {
      const tokens = tokenizer.feed('\r');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('enter');
    });

    test('Ctrl+C (\\x03) produces key with logicalName=c and ctrl=true', () => {
      const tokens = tokenizer.feed('\x03');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('c');
      expect(t.ctrl).toBe(true);
    });

    test('Backspace (127) produces key with logicalName=backspace', () => {
      const tokens = tokenizer.feed('\x7f');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('backspace');
    });

    test('newline (\\n) produces key token with logicalName=enter', () => {
      const tokens = tokenizer.feed('\n');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('enter');
    });

    test('Ctrl+A produces key with ctrl=true', () => {
      const tokens = tokenizer.feed('\x01'); // SOH
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.ctrl).toBe(true);
    });
  });

  describe('escape sequences', () => {
    test('focus-in sequence produces focus token', () => {
      const tokens = tokenizer.feed('\x1b[I');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
      expect(t.type).toBe('focus');
      expect(t.action).toBe('in');
    });

    test('focus-out sequence produces focus token', () => {
      const tokens = tokenizer.feed('\x1b[O');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
      expect(t.type).toBe('focus');
      expect(t.action).toBe('out');
    });

    test('up arrow (\\x1b[A) produces key token with logicalName=up', () => {
      const tokens = tokenizer.feed('\x1b[A');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('up');
    });

    test('down arrow (\\x1b[B) produces key token with logicalName=down', () => {
      const tokens = tokenizer.feed('\x1b[B');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('down');
    });

    test('mouse press sequence produces mouse token', () => {
      // SGR mouse: ESC[<0;10;5M  (button=0, col=10-1=9, row=5-1=4, press)
      const tokens = tokenizer.feed('\x1b[<0;10;5M');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'mouse' }>;
      expect(t.type).toBe('mouse');
      expect(t.button).toBe(0);
      expect(t.col).toBe(9);
      expect(t.row).toBe(4);
      expect(t.action).toBe('press');
    });

    test('mouse release sequence produces mouse token with action=release', () => {
      const tokens = tokenizer.feed('\x1b[<0;1;1m');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'mouse' }>;
      expect(t.type).toBe('mouse');
      expect(t.action).toBe('release');
    });
  });

  describe('bracketed paste', () => {
    test('bracketed paste produces a single text token with full content', () => {
      const tokens = tokenizer.feed('\x1b[200~hello world\x1b[201~');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'text' }>;
      expect(t.type).toBe('text');
      expect(t.value).toBe('hello world');
    });

    test('bracketed paste with newlines is treated as single token', () => {
      const tokens = tokenizer.feed('\x1b[200~line1\nline2\x1b[201~');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'text' }>;
      expect(t.value).toContain('line1');
      expect(t.value).toContain('line2');
    });

    test('partial paste buffers until end marker arrives', () => {
      // Feed start and content without end marker
      const partial = tokenizer.feed('\x1b[200~hello');
      expect(partial).toHaveLength(0); // still buffering

      // Feed end marker
      const complete = tokenizer.feed('\x1b[201~');
      expect(complete).toHaveLength(1);
      const t = complete[0] as Extract<InputToken, { type: 'text' }>;
      expect(t.value).toBe('hello');
    });
  });

  describe('buffer safety', () => {
    test('oversized buffer is discarded and returns empty array', () => {
      const big = 'a'.repeat(1024 * 101);
      const tokens = tokenizer.feed(big);
      expect(tokens).toEqual([]);
    });

    test('can process input after buffer reset from overflow', () => {
      tokenizer.feed('a'.repeat(1024 * 101)); // overflow, resets
      const tokens = tokenizer.feed('x');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('text');
    });
  });

  describe('panel control codes', () => {
    test('0x1c (Ctrl+\\\\) produces key with logicalName="|" and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1c');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('|');
      expect(t.ctrl).toBe(true);
    });

    test('0x1d (Ctrl+]) produces key with logicalName="}" and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1d');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('}');
      expect(t.ctrl).toBe(true);
    });

    test('0x1e (Ctrl+^) produces key with logicalName="~" and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1e');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('~');
      expect(t.ctrl).toBe(true);
    });
  });

  describe('sequential feed calls', () => {
    test('bare escape emits escape key token', () => {
      const t1 = tokenizer.feed('\x1b');
      expect(t1).toHaveLength(1);
      expect(t1[0].type).toBe('key');
      if (t1[0].type === 'key') {
        expect(t1[0].logicalName).toBe('escape');
      }
    });

    test('multiple text chars feed sequentially produce all tokens', () => {
      const t1 = tokenizer.feed('a');
      const t2 = tokenizer.feed('b');
      expect(t1[0].type).toBe('text');
      expect(t2[0].type).toBe('text');
    });
  });
});
