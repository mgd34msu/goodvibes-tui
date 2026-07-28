/**
 * Behavior verification for the daemon's own mailbox and calendar settings.
 *
 * `surfaces.email.*` and `surfaces.calendar.*` were read by the daemon's mail
 * and calendar handlers long before they were declared anywhere. The settings
 * modal renders from `CONFIG_SCHEMA`, so the handlers' own error messages —
 * "CalDAV is not configured. Set surfaces.calendar.caldavUrl and
 * surfaces.calendar.caldavUser." — named keys the UI that told an operator to
 * set them could not display. Declaring the 25 of them fixed that, and grew the
 * settings inventory the verification ledger counts (`total`) with no matching
 * local behavior coverage, pushing `localBehaviorPercent` below its floor.
 *
 * These tests supply that coverage HONESTLY, to exactly the standard the ledger
 * already uses for a settings key (see device-and-trigger-settings-persistence.test.ts):
 * for every key in DAEMON_MAILBOX_LOCAL_SETTINGS they exercise the real
 * persistence contract end to end — schema default exposure, `set()` write
 * through the validator to disk, reload into a fresh ConfigManager, read-back
 * equality, and reset-to-default — through the actual ConfigManager, not a mock.
 *
 * What this claims beyond persistence: all 25 have a LIVE consumer. That is why
 * they were declared at all — the SDK's mail and calendar gateway compositions
 * resolve every one of them when the daemon serves `email.*` and `calendar.*`.
 * The evidence list beside DAEMON_MAILBOX_LOCAL_SETTINGS records that.
 *
 * A note on the five password keys. They are declared so the settings surface
 * can offer them, but a secret VALUE never lives in config: each resolves
 * through the daemon secret tier by the platform name derivation. The
 * round-trip below therefore stores an ordinary string, which is exactly what
 * the key holds — a reference, not a credential. The write side is enforced in
 * src/test/security/daemon-credential-scope.test.ts: all five are in
 * SECRET_CONFIG_KEYS, so an entered value goes to the secret store and only the
 * reference reaches a settings file.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, CONFIG_SCHEMA } from '../../config/index.ts';
import type { ConfigKey } from '../../config/index.ts';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import {
  DAEMON_MAILBOX_LOCAL_SETTINGS,
  DEVICE_AND_TRIGGER_LOCAL_SETTINGS,
  FEATURE_KNOB_LOCAL_SETTINGS,
} from '../../verification/verification-ledger.ts';

/**
 * A valid alternate value (distinct from the schema default) for each key.
 * Hosts and mailbox names are realistic rather than arbitrary, so a failure
 * reads as a real configuration rather than as noise.
 */
const ALTERNATE_VALUE: Record<string, unknown> = {
  'surfaces.email.host': 'mail.example.com',
  'surfaces.email.user': 'operator@example.com',
  'surfaces.email.username': 'operator',
  'surfaces.email.from': 'GoodVibes <operator@example.com>',
  'surfaces.email.password': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD',
  'surfaces.email.imapHost': 'imap.example.com',
  'surfaces.email.imapPort': 143,
  'surfaces.email.imapUser': 'operator@example.com',
  'surfaces.email.imapPassword': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD',
  'surfaces.email.imap.host': 'imap.example.com',
  'surfaces.email.imap.port': 143,
  'surfaces.email.imap.user': 'operator@example.com',
  'surfaces.email.imap.password': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD',
  'surfaces.email.imap.secure': false,
  'surfaces.email.imap.mailbox': 'Archive',
  'surfaces.email.imap.draftsMailbox': '[Gmail]/Drafts',
  'surfaces.email.smtp.host': 'smtp.example.com',
  'surfaces.email.smtp.port': 587,
  'surfaces.email.smtp.password': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_SMTP_PASSWORD',
  'surfaces.email.smtp.secure': false,
  'surfaces.calendar.caldavUrl': 'https://caldav.example.com/dav/',
  'surfaces.calendar.caldavUser': 'operator@example.com',
  'surfaces.calendar.caldavPassword': 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD',
  'surfaces.calendar.defaultCalendarId': 'personal',
  'surfaces.calendar.calendars': '{"personal":"/dav/calendars/operator/personal/"}',
};

const schemaByKey = new Map(CONFIG_SCHEMA.map((setting) => [setting.key as string, setting]));

function freshManager(): { manager: ConfigManager; root: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'gv-daemon-mailbox-settings-'));
  const configDir = join(root, 'config');
  const manager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
  manager.load();
  return { manager, root, configDir };
}

describe('daemon mailbox settings — the counted list is honest', () => {
  test('every counted key is a live CONFIG_SCHEMA key with a declared default', () => {
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      const schema = schemaByKey.get(key);
      expect(schema, `${key} must be a live CONFIG_SCHEMA key`).toBeDefined();
      expect(schema!.default, `${key} must declare a default`).toBeDefined();
    }
  });

  test('the ledger counts each key exactly once — no overlap with the other counted sets', () => {
    // Double-counting a key would inflate localBehaviorPercent without anyone
    // writing a line of coverage, which is the failure mode the ledger exists
    // to prevent.
    expect(new Set(DAEMON_MAILBOX_LOCAL_SETTINGS).size).toBe(DAEMON_MAILBOX_LOCAL_SETTINGS.length);

    const knobs = new Set<string>(FEATURE_KNOB_LOCAL_SETTINGS);
    const deviceTrigger = new Set<string>(DEVICE_AND_TRIGGER_LOCAL_SETTINGS);
    const enablementKeys = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key));
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      expect(knobs.has(key), `${key} is already counted as a feature-knob key`).toBe(false);
      expect(deviceTrigger.has(key), `${key} is already counted as a device/trigger key`).toBe(false);
      expect(enablementKeys.has(key), `${key} is already counted as an enablement key`).toBe(false);
    }
  });

  test('the list covers every surfaces.email.* and surfaces.calendar.* schema key', () => {
    // A key declared later and forgotten here would silently stop being
    // counted, which is how the floor drifts.
    const expected = CONFIG_SCHEMA
      .map((setting) => setting.key as string)
      .filter((key) => key.startsWith('surfaces.email.') || key.startsWith('surfaces.calendar.'));
    expect([...DAEMON_MAILBOX_LOCAL_SETTINGS].sort() as string[]).toEqual(expected.sort());
  });

  test('an alternate test value is defined for every key and genuinely differs from the default', () => {
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      expect(ALTERNATE_VALUE[key], `${key} needs an alternate value`).toBeDefined();
      expect(ALTERNATE_VALUE[key]).not.toEqual(schemaByKey.get(key)!.default);
    }
  });
});

describe('daemon mailbox settings — default exposure', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = freshManager().manager;
  });

  test('a fresh ConfigManager returns each key at its schema default', () => {
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} default`).toEqual(expected as never);
    }
  });

  test('no password key defaults to anything but empty — a credential is never a default', () => {
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS.filter((k) => /password/i.test(k))) {
      expect(schemaByKey.get(key)!.default, `${key} must default to empty`).toBe('');
    }
  });
});

describe('daemon mailbox settings — write/reload persistence round-trip', () => {
  test('each key persists to disk and reloads into a fresh ConfigManager', () => {
    const { manager, root, configDir } = freshManager();

    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      expect(manager.get(key as ConfigKey), `${key} in-memory after set`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reload`).toEqual(
        ALTERNATE_VALUE[key] as never,
      );
    }
  });

  test('both IMAP spellings persist independently, because both are genuinely read', () => {
    // The inbox provider reads the flat imapHost/imapPort/imapUser; the mail
    // settings resolver reads the nested imap.*. Declaring one and not the
    // other would strand whichever half a given machine used.
    const { manager, root, configDir } = freshManager();
    manager.set('surfaces.email.imapHost' as ConfigKey, 'flat.example.com' as never);
    manager.set('surfaces.email.imap.host' as ConfigKey, 'nested.example.com' as never);

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    expect(reloaded.get('surfaces.email.imapHost' as ConfigKey)).toBe('flat.example.com' as never);
    expect(reloaded.get('surfaces.email.imap.host' as ConfigKey)).toBe('nested.example.com' as never);
  });
});

describe('daemon mailbox settings — reset restores default', () => {
  test('reset returns each key to its schema default and persists that', () => {
    const { manager, root, configDir } = freshManager();

    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      manager.reset(key as ConfigKey);
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} after reset`).toEqual(expected as never);
    }

    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
    reloaded.load();
    for (const key of DAEMON_MAILBOX_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(reloaded.get(key as ConfigKey), `${key} default after reload`).toEqual(
        expected as never,
      );
    }
  });
});
