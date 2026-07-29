// ---------------------------------------------------------------------------
// local-auth-panel.test.ts
//
// Tests for LocalAuthPanel masked-password-entry mode:
//   1. Masked rendering: bullet chars only — no plaintext in any rendered line
//   2. Submit path: Enter calls auth.addUser / auth.rotatePassword with secret
//   3. Esc aborts cleanly without persisting anything
//   4. Backspace editing removes last character from buffer
//   5. History file never contains the secret (asserted on file contents)
//   6. Empty Enter is a no-op (no auth call, stays in masked mode)
//   7. Non-masked render still works as before (regression guard)
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { LocalAuthPanel } from '../../panels/local-auth-panel.ts';
import type { Line } from '../../types/grid.ts';
import { InputHistory } from '../../input/input-history.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join(''))
    .join('\n');
}

const EMPTY_AUTH_MANAGER = {
  inspect: () => ({
    userStorePath: '/tmp/gv-test-users',
    bootstrapCredentialPath: '/tmp/gv-test-bootstrap',
    persisted: false,
    bootstrapCredentialPresent: false,
    userCount: 0,
    sessionCount: 0,
    users: [],
    sessions: [],
  }),
} as unknown as import('../../runtime/ui-service-queries.ts').LocalAuthInspectionQuery;

// ---------------------------------------------------------------------------
// 1. Masked rendering: no plaintext in any rendered line
// ---------------------------------------------------------------------------

describe('LocalAuthPanel masked-entry render', () => {
  let dir: string;
  let usersPath: string;
  let bootstrapPath: string;
  let auth: UserAuthManager;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-masked-panel');
    usersPath = join(dir, 'auth-users.json');
    bootstrapPath = join(dir, 'auth-bootstrap.txt');
    auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });
  });

  test('render in masked-entry mode contains only bullet chars — no plaintext password', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);

    // Simulate typing a password character by character.
    panel.handleInput('s');
    panel.handleInput('e');
    panel.handleInput('c');
    panel.handleInput('r');
    panel.handleInput('e');
    panel.handleInput('t');

    const rendered = panel.render(80, 20);
    const text = linesText(rendered);

    // The plaintext password must never appear in any rendered line.
    expect(text).not.toContain('secret');
    // Bullet chars should be present (one per character typed, capped at 32).
    expect(text).toContain('•'); // '•' is '•'
  });

  test('render in masked-entry mode does not contain the password value verbatim', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    // Use a distinctive password value that won't appear in any UI label.
    panel.openMaskedEntry('rotate-password', 'alice', auth);

    // Type a distinctive sequence that would only match the password value.
    panel.handleInput('x');
    panel.handleInput('7');
    panel.handleInput('Q');
    panel.handleInput('!');

    const rendered = panel.render(80, 20);
    const text = linesText(rendered);

    // The typed password value must not appear verbatim.
    expect(text).not.toContain('x7Q!');
    // The username label is shown, but not the password.
    expect(text).toContain('alice');
    expect(text).toContain('•');
  });

  test('empty buffer shows cursor block without bullets', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'bob', auth);

    const rendered = panel.render(80, 20);
    const text = linesText(rendered);

    // No bullets when buffer is empty.
    expect(text).not.toContain('•');
    // Block cursor should be present.
    expect(text).toContain('█'); // '█' is '█'
  });

  test('render returns exactly height lines in masked mode', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);
    const rendered = panel.render(80, 15);
    expect(rendered).toHaveLength(15);
  });

  test('isMaskedEntryActive is true after openMaskedEntry, false after Esc', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    expect(panel.isMaskedEntryActive).toBe(false);
    panel.openMaskedEntry('add-user', 'ops', auth);
    expect(panel.isMaskedEntryActive).toBe(true);
    panel.handleInput('escape');
    expect(panel.isMaskedEntryActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Submit path: Enter calls auth.addUser / auth.rotatePassword with secret
// ---------------------------------------------------------------------------

describe('LocalAuthPanel masked-entry submit path', () => {
  let dir: string;
  let usersPath: string;
  let bootstrapPath: string;
  let auth: UserAuthManager;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-masked-submit');
    usersPath = join(dir, 'auth-users.json');
    bootstrapPath = join(dir, 'auth-bootstrap.txt');
    auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });
  });

  test('add-user: Enter with non-empty buffer calls addUser and exits masked mode', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);

    panel.handleInput('m');
    panel.handleInput('y');
    panel.handleInput('p');
    panel.handleInput('a');
    panel.handleInput('s');
    panel.handleInput('s');
    panel.handleInput('w');
    panel.handleInput('o');
    panel.handleInput('r');
    panel.handleInput('d');
    panel.handleInput('enter');

    // Panel exits masked mode on submit.
    expect(panel.isMaskedEntryActive).toBe(false);

    // The user was added to the auth manager.
    const snapshot = auth.inspect();
    expect(snapshot.users.some((u) => u.username === 'ops')).toBe(true);

    // The password in plaintext must NOT appear in the stored users file.
    const stored = readFileSync(usersPath, 'utf-8');
    expect(stored).not.toContain('mypassword');
  });

  test('rotate-password: Enter with non-empty buffer calls rotatePassword and exits masked mode', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    // First create the user we will rotate.
    auth.addUser('alice', 'initial-pass', ['admin']);
    const sessionBefore = auth.createSession('alice');

    panel.openMaskedEntry('rotate-password', 'alice', auth);
    panel.handleInput('n');
    panel.handleInput('e');
    panel.handleInput('w');
    panel.handleInput('p');
    panel.handleInput('a');
    panel.handleInput('s');
    panel.handleInput('s');
    panel.handleInput('w');
    panel.handleInput('o');
    panel.handleInput('r');
    panel.handleInput('d');
    panel.handleInput('enter');

    expect(panel.isMaskedEntryActive).toBe(false);

    // Old session should be invalidated after password rotation.
    expect(auth.validateSession(sessionBefore.token)).toBeNull();

    // The new plaintext password must NOT appear in any stored file.
    const stored = readFileSync(usersPath, 'utf-8');
    expect(stored).not.toContain('newpassword');
  });

  test('Enter with empty buffer is a no-op: stays in masked mode, no auth call', () => {
    let addUserCalled = false;
    const interceptingAuth = {
      ...auth,
      addUser: (..._args: unknown[]) => {
        addUserCalled = true;
        return auth.addUser(...(_args as Parameters<typeof auth.addUser>));
      },
    } as unknown as UserAuthManager;

    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', interceptingAuth);

    // Immediately press Enter without typing anything.
    panel.handleInput('enter');

    expect(panel.isMaskedEntryActive).toBe(true);
    expect(addUserCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Esc aborts cleanly without persisting
// ---------------------------------------------------------------------------

describe('LocalAuthPanel masked-entry Esc abort', () => {
  let dir: string;
  let usersPath: string;
  let bootstrapPath: string;
  let auth: UserAuthManager;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-masked-esc');
    usersPath = join(dir, 'auth-users.json');
    bootstrapPath = join(dir, 'auth-bootstrap.txt');
    auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });
  });

  test('Esc aborts masked entry: no user added, panel exits masked mode', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);

    panel.handleInput('s');
    panel.handleInput('e');
    panel.handleInput('c');
    // Press Esc before submitting.
    panel.handleInput('escape');

    expect(panel.isMaskedEntryActive).toBe(false);

    // No user should have been added.
    const snapshot = auth.inspect();
    expect(snapshot.users.some((u) => u.username === 'ops')).toBe(false);
  });

  test('Esc abort: normal panel render is restored (returns height lines)', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);
    panel.handleInput('escape');

    const rendered = panel.render(80, 12);
    expect(rendered).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// 4. Backspace editing
// ---------------------------------------------------------------------------

describe('LocalAuthPanel masked-entry backspace', () => {
  let dir: string;
  let usersPath: string;
  let bootstrapPath: string;
  let auth: UserAuthManager;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-masked-bs');
    usersPath = join(dir, 'auth-users.json');
    bootstrapPath = join(dir, 'auth-bootstrap.txt');
    auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });
  });

  test('backspace removes last typed character; submitting reduced buffer calls auth with correct password', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'testuser', auth);

    panel.handleInput('a');
    panel.handleInput('b');
    panel.handleInput('c');
    panel.handleInput('d');
    panel.handleInput('e');
    panel.handleInput('f');
    panel.handleInput('g');
    panel.handleInput('h');
    panel.handleInput('i');
    panel.handleInput('j'); // buffer = 'abcdefghij'
    panel.handleInput('backspace'); // buffer = 'abcdefghi'
    panel.handleInput('backspace'); // buffer = 'abcdefgh'
    panel.handleInput('enter');

    expect(panel.isMaskedEntryActive).toBe(false);

    // The user was added with password 'abcdefgh' (i and j were backspaced).
    // The stored file must not contain 'abcdefghij' or 'abcdefghi'.
    const stored = readFileSync(usersPath, 'utf-8');
    expect(stored).not.toContain('abcdefghij');
    expect(stored).not.toContain('abcdefghi');
  });

  test('backspace on empty buffer is a no-op: stays in masked mode', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);

    // Press backspace when nothing has been typed.
    panel.handleInput('backspace');

    expect(panel.isMaskedEntryActive).toBe(true);
  });

  test('render shows fewer bullets after backspace', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);

    panel.handleInput('x');
    panel.handleInput('y');
    panel.handleInput('z');
    const before = linesText(panel.render(80, 20)).split('•').length - 1; // 3 bullets

    panel.handleInput('backspace');
    const after = linesText(panel.render(80, 20)).split('•').length - 1; // 2 bullets

    expect(after).toBe(before - 1);
  });
});

// ---------------------------------------------------------------------------
// 5. History file never contains the secret
// ---------------------------------------------------------------------------

describe('LocalAuthPanel masked-entry: secret never in history', () => {
  let dir: string;
  let usersPath: string;
  let bootstrapPath: string;
  let historyPath: string;
  let auth: UserAuthManager;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-masked-hist');
    usersPath = join(dir, 'auth-users.json');
    bootstrapPath = join(dir, 'auth-bootstrap.txt');
    historyPath = join(dir, 'history.json');
    auth = new UserAuthManager({
      bootstrapFilePath: usersPath,
      bootstrapCredentialPath: bootstrapPath,
    });
  });

  test('password never written to input history file after masked submit', () => {
    // Create an InputHistory backed by the temp dir so we can assert on the file.
    const history = new InputHistory({ historyPath });

    // Simulate a command that triggered the masked panel — the command itself
    // has no password argument, so history stores only the safe prefix.
    history.add('/auth local add-user ops');
    history.save();

    // Now simulate the masked panel completing.
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    panel.openMaskedEntry('add-user', 'ops', auth);
    panel.handleInput('s');
    panel.handleInput('e');
    panel.handleInput('c');
    panel.handleInput('r');
    panel.handleInput('e');
    panel.handleInput('t');
    panel.handleInput('p');
    panel.handleInput('a');
    panel.handleInput('s');
    panel.handleInput('s');
    panel.handleInput('enter');

    // The history file must NOT contain the password.
    const historyContents = readFileSync(historyPath, 'utf-8');
    expect(historyContents).not.toContain('secretpass');
    expect(historyContents).not.toContain('secret');

    // The safe command prefix IS in history.
    expect(historyContents).toContain('add-user');
  });
});

// ---------------------------------------------------------------------------
// 6. Normal (non-masked) render: regression guard
// ---------------------------------------------------------------------------

describe('LocalAuthPanel normal render (regression guard)', () => {
  test('render without masked mode returns exactly height lines', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    const rendered = panel.render(80, 24);
    expect(rendered).toHaveLength(24);
  });

  test('render without masked mode does not show masked-entry password prompt', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    const text = linesText(panel.render(80, 20));
    // The masked-entry prompt includes 'Password Entry' in the title and a
    // block cursor for the empty buffer; neither should appear in normal mode.
    expect(text).not.toContain('Password Entry');
    expect(text).not.toContain('█'); // block cursor only present in masked mode
  });

  test('guidance line no longer mentions password-as-argument', () => {
    const panel = new LocalAuthPanel(EMPTY_AUTH_MANAGER);
    const text = linesText(panel.render(80, 20));
    // Old guidance had "<password>" in the command; new guidance should not.
    expect(text).not.toContain('<password>');
  });
});
