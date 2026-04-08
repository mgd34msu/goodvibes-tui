import { describe, expect, test } from 'bun:test';
import { renderConversationNotice, renderConversationKeyValueRow, renderConversationFragment } from '../../renderer/conversation-surface.ts';
import { lineToString } from '../setup.ts';

describe('conversation surface', () => {
  test('renders a wrapped notice with a stable left marker', () => {
    const lines = renderConversationNotice(
      'This is a long system-style notice that should wrap cleanly inside the conversation lane.',
      40,
      { accent: '#00ffff', text: '#cbd5e1', dim: true },
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lineToString(lines[0])).toContain('▌');
  });

  test('renders a key/value row with right-aligned status text', () => {
    const line = renderConversationKeyValueRow(
      50,
      '  read  src/demo.ts',
      '120ms',
      { leftFg: '#e2e8f0', rightFg: '#64748b' },
    );
    const text = lineToString(line);
    expect(text).toContain('read  src/demo.ts');
    expect(text).toContain('120ms');
  });

  test('supports italic notices for thinking-style transcript blocks', () => {
    const lines = renderConversationNotice(
      'Reasoning in progress',
      60,
      { accent: '#a855f7', text: '#64748b', dim: true, italic: true },
    );
    const italicCell = lines[0]?.find((cell, index) => index >= 5 && cell.char.trim().length > 0);
    expect(italicCell?.italic).toBe(true);
  });

  test('renders message fragments with half-height top and bottom borders', () => {
    const lines = renderConversationFragment('hello', 40, {
      prefix: ' › ',
      prefixFg: '135',
      text: '252',
      bodyBg: '#2a2a2a',
    });
    expect(lineToString(lines[0])).toContain('▄');
    expect(lineToString(lines[lines.length - 1]!)).toContain('▀');
  });

  test('status line defaults to unicode gutter marker', () => {
    const lines = renderConversationNotice(
      'Status row test',
      40,
      { accent: '#00ffff', text: '#cbd5e1', dim: true },
    );
    expect(lineToString(lines[0])).toContain('▌');
  });
});
