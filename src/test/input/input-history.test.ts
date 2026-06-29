import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { InputHistory } from '../../input/input-history.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpPath(): string {
  return join(tmpDir, 'input-history.json');
}

function makeHistory(path?: string): InputHistory {
  return new InputHistory({ historyPath: path ?? makeTmpPath(), persist: true });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = join(tmpdir(), `gv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// add()
// ===========================================================================

describe('InputHistory.add', () => {
  test('ignores empty string', () => {
    const h = makeHistory();
    h.add('');
    expect(h.up('')).toBeNull();
  });

  test('ignores whitespace-only string', () => {
    const h = makeHistory();
    h.add('   ');
    h.add('\t');
    expect(h.up('')).toBeNull();
  });

  test('adds trimmed entry', () => {
    const h = makeHistory();
    h.add('  hello  ');
    expect(h.up('')).toBe('hello');
  });

  test('deduplicates consecutive identical entries', () => {
    const h = makeHistory();
    h.add('foo');
    h.add('foo');
    expect(h.up('')).toBe('foo');
    expect(h.up('foo')).toBeNull(); // only one entry
  });

  test('allows non-consecutive duplicates', () => {
    const h = makeHistory();
    h.add('foo');
    h.add('bar');
    h.add('foo');
    expect(h.up('')).toBe('foo');
    expect(h.up('foo')).toBe('bar');
    expect(h.up('bar')).toBe('foo');
  });

  test('caps at maxEntries (500)', () => {
    // persist:false on purpose — this verifies the IN-MEMORY cap only. With
    // persist:true, add() does a synchronous full-file write per call, so 510
    // adds = 510 growing-file writes, which can exceed bun's 5s per-test timeout
    // under full-suite load (flaky). On-disk capping is covered separately by the
    // load() cap test ('caps loaded entries at maxEntries (500)').
    const h = new InputHistory({ historyPath: makeTmpPath(), persist: false });
    for (let i = 0; i < 510; i++) {
      h.add(`entry ${i}`);
    }
    // Navigate to end — should stop at 500
    let count = 0;
    let result: string | null = '';
    while ((result = h.up(result ?? '')) !== null) {
      count++;
      if (count > 510) break; // safety
    }
    expect(count).toBe(500);
  });

  test('resets browsing position after add', () => {
    const h = makeHistory();
    h.add('first');
    h.up(''); // start browsing
    h.add('second');
    // After add, down() should return null (not browsing)
    expect(h.down()).toBeNull();
  });
});

// ===========================================================================
// up()
// ===========================================================================

describe('InputHistory.up', () => {
  test('returns null when history is empty', () => {
    const h = makeHistory();
    expect(h.up('')).toBeNull();
  });

  test('saves draft on first navigation', () => {
    const h = makeHistory();
    h.add('entry');
    h.up('my draft');
    expect(h.down()).toBe('my draft'); // draft restored when going back down
  });

  test('navigates through entries oldest-first', () => {
    const h = makeHistory();
    h.add('first');
    h.add('second');
    h.add('third');
    expect(h.up('')).toBe('third');
    expect(h.up('third')).toBe('second');
    expect(h.up('second')).toBe('first');
  });

  test('returns null at oldest boundary', () => {
    const h = makeHistory();
    h.add('only');
    h.up('');
    expect(h.up('only')).toBeNull();
  });

  test('recalls multiline entries', () => {
    const h = makeHistory();
    h.add('single line');
    h.add('line1\nline2');
    h.add('another single');
    expect(h.up('')).toBe('another single');
    expect(h.up('another single')).toBe('line1\nline2');
    expect(h.up('line1\nline2')).toBe('single line');
  });

  test('restores persisted paste marker history as the original multiline content', () => {
    const h = makeHistory();
    const pasted = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9';
    h.add('[TEXT: p1, 9 lines]', { recallText: pasted });

    expect(h.up('')).toBe(pasted);
  });
});

// ===========================================================================
// down()
// ===========================================================================

describe('InputHistory.down', () => {
  test('returns null when not browsing', () => {
    const h = makeHistory();
    h.add('entry');
    expect(h.down()).toBeNull();
  });

  test('returns draft when at most-recent entry', () => {
    const h = makeHistory();
    h.add('entry');
    h.up('draft text');
    expect(h.down()).toBe('draft text');
  });

  test('navigates forward through entries', () => {
    const h = makeHistory();
    h.add('a');
    h.add('b');
    h.add('c');
    h.up(''); // c
    h.up('c'); // b
    h.up('b'); // a
    expect(h.down()).toBe('b');
    expect(h.down()).toBe('c');
    expect(h.down()).toBe(''); // back to draft
  });

  test('returns null after reaching draft (not browsing anymore)', () => {
    const h = makeHistory();
    h.add('entry');
    h.up('');
    h.down(); // back to draft, position = -1
    expect(h.down()).toBeNull();
  });

  test('recalls multiline entries when navigating down', () => {
    const h = makeHistory();
    h.add('single');
    h.add('multi\nline');
    h.add('top');
    h.up(''); // top
    h.up('top'); // multiline
    h.up('multi\nline'); // single
    expect(h.down()).toBe('multi\nline');
    expect(h.down()).toBe('top');
  });
});

// ===========================================================================
// resetPosition()
// ===========================================================================

describe('InputHistory.resetPosition', () => {
  test('clears browsing state', () => {
    const h = makeHistory();
    h.add('entry');
    h.up('draft');
    expect(h.isBrowsing).toBe(true);
    h.resetPosition();
    expect(h.isBrowsing).toBe(false);
    expect(h.down()).toBeNull();
  });

  test('clears saved draft', () => {
    const h = makeHistory();
    h.add('a');
    h.up('saved draft');
    h.resetPosition();
    h.add('b');
    h.up(''); // new navigation
    expect(h.down()).toBe(''); // draft is now '', not 'saved draft'
  });
});

// ===========================================================================
// isBrowsing
// ===========================================================================

describe('InputHistory.isBrowsing', () => {
  test('false when not navigating', () => {
    const h = makeHistory();
    expect(h.isBrowsing).toBe(false);
  });

  test('true after up()', () => {
    const h = makeHistory();
    h.add('entry');
    h.up('');
    expect(h.isBrowsing).toBe(true);
  });

  test('false after navigating back to draft', () => {
    const h = makeHistory();
    h.add('entry');
    h.up('');
    h.down();
    expect(h.isBrowsing).toBe(false);
  });
});

// ===========================================================================
// save() / load() — persistence round-trip
// ===========================================================================

describe('InputHistory persistence', () => {
  test('round-trip: entries survive save+load', () => {
    const path = makeTmpPath();
    const h1 = new InputHistory({ historyPath: path, persist: true });
    h1.add('alpha');
    h1.add('beta');
    h1.add('gamma');

    const h2 = new InputHistory({ historyPath: path, persist: true });
    expect(h2.up('')).toBe('gamma');
    expect(h2.up('gamma')).toBe('beta');
    expect(h2.up('beta')).toBe('alpha');
  });

  test('round-trip: paste marker recall content survives save+load', () => {
    const path = makeTmpPath();
    const pasted = 'first pasted line\nsecond pasted line\nthird pasted line';
    const h1 = new InputHistory({ historyPath: path, persist: true });
    h1.add('[TEXT: p1, 3 lines]', { recallText: pasted });

    const h2 = new InputHistory({ historyPath: path, persist: true });
    expect(h2.up('')).toBe(pasted);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    expect(raw).toEqual([{ text: '[TEXT: p1, 3 lines]', recallText: pasted }]);
  });

  test('creates missing directory on save', () => {
    const nestedPath = join(tmpDir, 'a', 'b', 'c', 'history.json');
    const h = new InputHistory({ historyPath: nestedPath, persist: true });
    h.add('test entry');
    // Save is called automatically by add(); verify the file exists
    expect(existsSync(nestedPath)).toBe(true);
  });

  test('handles corrupted JSON gracefully (starts empty)', () => {
    const path = makeTmpPath();
    writeFileSync(path, '{not valid json{{', 'utf-8');
    const h = new InputHistory({ historyPath: path, persist: true });
    expect(h.up('')).toBeNull();
  });

  test('handles non-array JSON gracefully (starts empty)', () => {
    const path = makeTmpPath();
    writeFileSync(path, JSON.stringify({ entries: ['a', 'b'] }), 'utf-8');
    const h = new InputHistory({ historyPath: path, persist: true });
    expect(h.up('')).toBeNull();
  });

  test('filters non-string entries on load', () => {
    const path = makeTmpPath();
    writeFileSync(path, JSON.stringify(['valid', 42, null, 'also valid', true]), 'utf-8');
    const h = new InputHistory({ historyPath: path, persist: true });
    expect(h.up('')).toBe('valid');
    expect(h.up('valid')).toBe('also valid');
    expect(h.up('also valid')).toBeNull();
  });

  test('caps loaded entries at maxEntries (500)', () => {
    const path = makeTmpPath();
    const entries = Array.from({ length: 600 }, (_, i) => `entry ${i}`);
    writeFileSync(path, JSON.stringify(entries), 'utf-8');
    const h = new InputHistory({ historyPath: path, persist: true });
    let count = 0;
    let result: string | null = '';
    while ((result = h.up(result ?? '')) !== null) {
      count++;
      if (count > 600) break;
    }
    expect(count).toBe(500);
  });

  test('no-persist mode: does not read or write file', () => {
    const path = makeTmpPath();
    writeFileSync(path, JSON.stringify(['should not load']), 'utf-8');
    const h = new InputHistory({ historyPath: path, persist: false });
    expect(h.up('')).toBeNull();
    h.add('new entry');
    // File should still have the old content
    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content).toEqual(['should not load']);
  });
});

// ===========================================================================
// Redaction — built-in rules for local-auth password commands
// ===========================================================================

describe('InputHistory redaction', () => {
  test('redacts password in /auth local add-user before storing', () => {
    const h = makeHistory();
    h.add('/auth local add-user alice s3cr3t');
    expect(h.up('')).toBe('/auth local add-user alice <redacted>');
  });

  test('redacted add-user entry does not appear on disk with cleartext password', () => {
    const path = makeTmpPath();
    const h = new InputHistory({ historyPath: path, persist: true });
    h.add('/auth local add-user alice s3cr3t');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown[];
    expect(JSON.stringify(raw)).not.toContain('s3cr3t');
    expect(JSON.stringify(raw)).toContain('<redacted>');
  });

  test('redacts password in /auth local rotate-password before storing', () => {
    const h = makeHistory();
    h.add('/auth local rotate-password bob newpass123');
    expect(h.up('')).toBe('/auth local rotate-password bob <redacted>');
  });

  test('redacted rotate-password entry does not appear on disk with cleartext password', () => {
    const path = makeTmpPath();
    const h = new InputHistory({ historyPath: path, persist: true });
    h.add('/auth local rotate-password bob newpass123');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown[];
    expect(JSON.stringify(raw)).not.toContain('newpass123');
    expect(JSON.stringify(raw)).toContain('<redacted>');
  });

  test('redacts password in recallText option as well', () => {
    const h = makeHistory();
    h.add('[TEXT: p1, 1 lines]', { recallText: '/auth local add-user alice s3cr3t' });
    expect(h.up('')).toBe('/auth local add-user alice <redacted>');
  });

  test('non-sensitive commands are stored unchanged', () => {
    const h = makeHistory();
    h.add('/model list');
    expect(h.up('')).toBe('/model list');
  });

  test('add-user without password is stored unchanged (no false positive)', () => {
    const h = makeHistory();
    h.add('/auth local add-user alice');
    expect(h.up('')).toBe('/auth local add-user alice');
  });

  test('custom redaction rule applied in addition to built-in rules', () => {
    const h = new InputHistory({
      historyPath: makeTmpPath(),
      persist: false,
      redactionRules: [
        { pattern: /SECRET_TOKEN=(\S+)/i, replacement: 'SECRET_TOKEN=<redacted>' },
      ],
    });
    h.add('/run SECRET_TOKEN=mytoken123');
    expect(h.up('')).toBe('/run SECRET_TOKEN=<redacted>');
  });

  test('redacts cleartext password in entry loaded from disk (pre-fix persistence)', () => {
    // Simulate a history file written before redaction was deployed — cleartext password on disk.
    const path = makeTmpPath();
    writeFileSync(
      path,
      JSON.stringify(['/auth local add-user alice s3cr3t', '/auth local rotate-password bob oldpass']),
      'utf-8',
    );
    const h = new InputHistory({ historyPath: path, persist: true });
    // Both entries must be scrubbed in memory after load().
    // Entries load in array order: index 0 (add-user) is most recent, index 1 (rotate-password) is older.
    expect(h.up('')).toBe('/auth local add-user alice <redacted>');
    expect(h.up('/auth local add-user alice <redacted>')).toBe('/auth local rotate-password bob <redacted>');
    // Saving must not re-persist the cleartext passwords.
    h.save();
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown[];
    expect(JSON.stringify(raw)).not.toContain('s3cr3t');
    expect(JSON.stringify(raw)).not.toContain('oldpass');
    expect(JSON.stringify(raw)).toContain('<redacted>');
  });
});

// ===========================================================================
// handleLocalAuthCommand — warning and panel routing
// ===========================================================================

import { handleLocalAuthCommand } from '../../input/commands/local-auth-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';

function makeAuthContext(overrides: Partial<{
  addUser: (username: string, password: string, roles: string[]) => { username: string; roles: string[] };
  rotatePassword: (username: string, password: string) => void;
  showPanel: (panelId: string) => void;
  openLocalAuthMaskedEntry: (kind: 'add-user' | 'rotate-password', username: string) => void;
}>): { ctx: CommandContext; printed: string[] } {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    exit: () => {},
    showPanel: overrides.showPanel ?? (() => {}),
    session: {} as CommandContext['session'],
    provider: {} as CommandContext['provider'],
    workspace: {} as CommandContext['workspace'],
    platform: {
      config: {} as CommandContext['platform']['config'],
      configManager: {} as CommandContext['platform']['configManager'],
      localUserAuthManager: {
        addUser: overrides.addUser ?? (() => ({ username: 'alice', roles: ['admin'] })),
        rotatePassword: overrides.rotatePassword ?? (() => {}),
        deleteUser: () => true,
        revokeSession: () => true,
        clearBootstrapCredentialFile: () => true,
        inspect: () => ({ users: [], sessions: [], userCount: 0, sessionCount: 0, bootstrapCredentialPresent: false, userStorePath: '', bootstrapCredentialPath: '' }),
      },
    } as unknown as CommandContext['platform'],
    ops: {} as CommandContext['ops'],
    extensions: {} as CommandContext['extensions'],
    openLocalAuthMaskedEntry: overrides.openLocalAuthMaskedEntry,
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('handleLocalAuthCommand — add-user password safety', () => {
  test('emits warning when password supplied as argv', () => {
    const { ctx, printed } = makeAuthContext({});
    handleLocalAuthCommand(['add-user', 'alice', 's3cr3t'], ctx);
    expect(printed.some((line) => line.toLowerCase().includes('warning'))).toBe(true);
  });

  test('still executes add-user when password supplied as argv', () => {
    let calledWith: { username: string; password: string } | null = null;
    const { ctx } = makeAuthContext({
      addUser: (username, password) => {
        calledWith = { username, password };
        return { username, roles: ['admin'] };
      },
    });
    handleLocalAuthCommand(['add-user', 'alice', 's3cr3t'], ctx);
    expect(calledWith).toEqual({ username: 'alice', password: 's3cr3t' });
  });

  test('calls openLocalAuthMaskedEntry when no password supplied to add-user', () => {
    let maskedEntryArgs: { kind: string; username: string } | null = null;
    const { ctx } = makeAuthContext({
      openLocalAuthMaskedEntry: (kind, username) => { maskedEntryArgs = { kind, username }; },
    });
    handleLocalAuthCommand(['add-user', 'alice'], ctx);
    expect(maskedEntryArgs).toEqual({ kind: 'add-user', username: 'alice' });
  });

  test('prints fallback guidance when no password supplied and masked entry unavailable', () => {
    // No openLocalAuthMaskedEntry wired — fallback print path.
    const { ctx, printed } = makeAuthContext({});
    handleLocalAuthCommand(['add-user', 'alice'], ctx);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed[0]).toContain('Masked entry unavailable');
  });
});

describe('handleLocalAuthCommand — rotate-password safety', () => {
  test('emits warning when password supplied as argv', () => {
    const { ctx, printed } = makeAuthContext({});
    handleLocalAuthCommand(['rotate-password', 'alice', 'newpass'], ctx);
    expect(printed.some((line) => line.toLowerCase().includes('warning'))).toBe(true);
  });

  test('still executes rotate-password when password supplied as argv', () => {
    let calledWith: { username: string; password: string } | null = null;
    const { ctx } = makeAuthContext({
      rotatePassword: (username, password) => { calledWith = { username, password }; },
    });
    handleLocalAuthCommand(['rotate-password', 'alice', 'newpass'], ctx);
    expect(calledWith).toEqual({ username: 'alice', password: 'newpass' });
  });

  test('calls openLocalAuthMaskedEntry when no password supplied to rotate-password', () => {
    let maskedEntryArgs: { kind: string; username: string } | null = null;
    const { ctx } = makeAuthContext({
      openLocalAuthMaskedEntry: (kind, username) => { maskedEntryArgs = { kind, username }; },
    });
    handleLocalAuthCommand(['rotate-password', 'alice'], ctx);
    expect(maskedEntryArgs).toEqual({ kind: 'rotate-password', username: 'alice' });
  });

  test('prints fallback guidance when no password supplied to rotate-password and masked entry unavailable', () => {
    // No openLocalAuthMaskedEntry wired — fallback print path.
    const { ctx, printed } = makeAuthContext({});
    handleLocalAuthCommand(['rotate-password', 'alice'], ctx);
    expect(printed.length).toBeGreaterThan(0);
    expect(printed[0]).toContain('Masked entry unavailable');
  });
});
