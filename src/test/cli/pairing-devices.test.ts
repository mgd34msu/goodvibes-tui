import { describe, test, expect } from 'bun:test';
import { formatLastSeen, formatCreated, formatDeviceLine, resolveTokenByIdPrefix, shortTokenId } from '../../core/pairing-devices.ts';
import type { PublicPairingToken } from '@pellux/goodvibes-sdk/platform/pairing';

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

describe('formatLastSeen', () => {
  test.each([
    [undefined, 'never'],
    [NOW - 30_000, 'just now'],
    [NOW - 5 * 60_000, '5m ago'],
    [NOW - 3 * 60 * 60_000, '3h ago'],
    [NOW - 2 * 24 * 60 * 60_000, '2d ago'],
  ])('%p -> %s', (ms, expected) => {
    expect(formatLastSeen(ms as number | undefined, NOW)).toBe(expected);
  });
});

test('formatCreated is a date', () => {
  expect(formatCreated(Date.UTC(2026, 6, 10, 9, 0, 0))).toBe('2026-07-10');
});

test('formatDeviceLine renders name · created · last-seen · short id', () => {
  const token: PublicPairingToken = { id: 'aaaa1111bbbb2222', name: 'my laptop', createdAt: Date.UTC(2026, 6, 10), lastSeenAt: NOW - 3 * 60_000 };
  const line = formatDeviceLine(token, NOW);
  expect(line).toContain('my laptop');
  expect(line).toContain('created 2026-07-10');
  expect(line).toContain('last seen 3m ago');
  expect(line).toContain(shortTokenId('aaaa1111bbbb2222'));
});

describe('resolveTokenByIdPrefix', () => {
  const tokens: PublicPairingToken[] = [
    { id: 'aaaa1111', name: 'a', createdAt: 0 },
    { id: 'aabb2222', name: 'b', createdAt: 0 },
    { id: 'cccc3333', name: 'c', createdAt: 0 },
  ];
  test('exact id', () => {
    const r = resolveTokenByIdPrefix(tokens, 'cccc3333');
    expect(r.ok && r.token.name).toBe('c');
  });
  test('unambiguous prefix', () => {
    const r = resolveTokenByIdPrefix(tokens, 'cc');
    expect(r.ok && r.token.name).toBe('c');
  });
  test('ambiguous prefix', () => {
    const r = resolveTokenByIdPrefix(tokens, 'aa');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe('ambiguous');
  });
  test('not found', () => {
    const r = resolveTokenByIdPrefix(tokens, 'zzz');
    expect(!r.ok && r.reason).toBe('not-found');
  });
});
