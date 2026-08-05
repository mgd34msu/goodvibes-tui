/**
 * Behavior verification for the connector settings platform runtime 2.0.8
 * declared: the daemon's Google-backed mail and calendar keys (`email.*`,
 * `calendar.*`, `google.*`), the connected-host dial switch, and the
 * hosted-turn routing switch.
 *
 * Before 2.0.8 the connector keys were cast onto the live config invisibly and
 * the settings surface answered "Unknown setting calendar.google.clientId" for
 * keys the daemon's own gateway compositions really resolve — the exact
 * discovery failure from the owner's 2026-08-05 Google session. Declaring them
 * fixed that, and grew the settings inventory the verification ledger counts
 * with no matching local behavior coverage, pushing `localBehaviorPercent`
 * below its floor — the same shape surfaces.email.* went through before
 * daemon-mailbox-settings-persistence.test.ts.
 *
 * These tests supply that coverage to exactly the standard the ledger already
 * uses for a settings key: for every key in CONNECTOR_LOCAL_SETTINGS they
 * exercise the real persistence contract end to end — schema default exposure,
 * `set()` write through the validator to disk, reload into a fresh
 * ConfigManager, read-back equality, and reset-to-default — through the actual
 * ConfigManager, not a mock.
 *
 * The three secret-valued keys (`email.passwordRef`, `email.smtpPasswordRef`,
 * `calendar.google.clientSecretRef`) and `google.oauth.refreshToken` hold
 * goodvibes://secrets/ references by design — a settings file never carries a
 * secret value. The round-trip below therefore stores a reference string,
 * which is exactly what the key holds.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import { FEATURE_SETTINGS } from '@pellux/goodvibes-sdk/platform/runtime/state';
import {
  CONNECTOR_LOCAL_SETTINGS,
  DAEMON_MAILBOX_LOCAL_SETTINGS,
  DEVICE_AND_TRIGGER_LOCAL_SETTINGS,
  FEATURE_KNOB_LOCAL_SETTINGS,
} from '../../verification/verification-ledger.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * A valid alternate value (distinct from the schema default) for each key.
 * Hosts and identifiers are realistic rather than arbitrary, so a failure
 * reads as a real configuration rather than as noise.
 */
const ALTERNATE_VALUE: Record<string, unknown> = {
  'email.enabled': true,
  'email.imapHost': 'imap.example.com',
  'email.imapPort': 143,
  'email.imapSecurity': 'plaintext',
  'email.smtpHost': 'smtp.example.com',
  'email.smtpPort': 465,
  'email.smtpSecurity': 'tls',
  'email.username': 'operator@example.com',
  'email.passwordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_PASSWORD',
  'email.smtpPasswordRef': 'goodvibes://secrets/goodvibes/GOODVIBES_EMAIL_SMTP_PASSWORD',
  'email.fromAddress': 'GoodVibes <operator@example.com>',
  'email.mailbox': 'INBOX/GoodVibes',
  'email.draftsMailbox': 'Drafts/GoodVibes',
  'calendar.google.clientId': '671877838105-example.apps.googleusercontent.com',
  'calendar.google.clientSecretRef': 'goodvibes://secrets/goodvibes/GOODVIBES_CALENDAR_GOOGLE_CLIENT_SECRET_REF',
  'calendar.google.icsUrl': 'https://calendar.google.com/calendar/ical/example/basic.ics',
  'calendar.microsoft.clientId': '00000000-1111-2222-3333-444444444444',
  'calendar.microsoft.clientSecretRef': 'goodvibes://secrets/goodvibes/GOODVIBES_CALENDAR_MICROSOFT_CLIENT_SECRET_REF',
  'google.oauth.projectId': 'goodvibes-owner-project',
  'google.oauth.publishingStatus': 'testing',
  'google.oauth.refreshToken': 'goodvibes://secrets/goodvibes/GOODVIBES_GOOGLE_OAUTH_REFRESH_TOKEN',
  'google.credentials.migratedFrom': '/home/operator/.gmail-mcp/gcp-oauth.keys.json',
  'daemon.connectedHost.enabled': false,
  'hostedSessions.routeConversationTurns': false,
};

const schemaByKey = new Map(CONFIG_SCHEMA.map((setting) => [setting.key as string, setting]));

function freshManager(): { manager: ConfigManager; configDir: string } {
  const root = makeProjectTempDir('gv-connector-settings');
  const configDir = join(root, 'config');
  const manager = new ConfigManager({ surfaceRoot: 'tui', workingDir: root, configDir });
  manager.load();
  return { manager, configDir };
}

describe('connector settings — the counted list is honest', () => {
  test('every counted key is a live CONFIG_SCHEMA key with a declared default', () => {
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      const schema = schemaByKey.get(key);
      expect(schema, `${key} must be a live CONFIG_SCHEMA key`).toBeDefined();
      expect(schema!.default, `${key} must declare a default`).toBeDefined();
    }
  });

  test('the ledger counts each key exactly once — no overlap with the other counted sets', () => {
    expect(new Set(CONNECTOR_LOCAL_SETTINGS).size).toBe(CONNECTOR_LOCAL_SETTINGS.length);
    const knobs = new Set<string>(FEATURE_KNOB_LOCAL_SETTINGS);
    const deviceTrigger = new Set<string>(DEVICE_AND_TRIGGER_LOCAL_SETTINGS);
    const mailbox = new Set<string>(DAEMON_MAILBOX_LOCAL_SETTINGS);
    const enablementKeys = new Set(FEATURE_SETTINGS.map((feature) => feature.enablement.key));
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      expect(knobs.has(key), `${key} is already counted as a feature-knob key`).toBe(false);
      expect(deviceTrigger.has(key), `${key} is already counted as a device/trigger key`).toBe(false);
      expect(mailbox.has(key), `${key} is already counted as a daemon-mailbox key`).toBe(false);
      expect(enablementKeys.has(key), `${key} is already counted as an enablement key`).toBe(false);
    }
  });

  test('the list covers every email.*, calendar.* and google.* schema key plus the two switches', () => {
    // A key declared later and forgotten here would silently stop being
    // counted, which is how the floor drifts.
    const expected = CONFIG_SCHEMA
      .map((setting) => setting.key as string)
      .filter((key) =>
        key.startsWith('email.')
        || key.startsWith('calendar.')
        || key.startsWith('google.')
        || key === 'daemon.connectedHost.enabled'
        || key === 'hostedSessions.routeConversationTurns');
    expect(([...CONNECTOR_LOCAL_SETTINGS] as string[]).sort()).toEqual(expected.sort());
  });

  test('every key has a distinct, schema-valid alternate value for the round-trip', () => {
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      // Not toHaveProperty: these keys carry dots, which it reads as paths.
      expect(key in ALTERNATE_VALUE, `${key} needs an alternate value`).toBe(true);
      expect(ALTERNATE_VALUE[key], `${key} alternate must differ from its default`)
        .not.toEqual(schemaByKey.get(key)!.default);
    }
  });
});

describe('connector settings — default exposure', () => {
  let manager: ConfigManager;

  beforeEach(() => {
    manager = freshManager().manager;
  });

  test('a fresh ConfigManager returns each key at its schema default', () => {
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      const expected = schemaByKey.get(key)!.default;
      expect(manager.get(key as ConfigKey), `${key} default`).toEqual(expected as never);
    }
  });
});

describe('connector settings — set, persist, reload, read back, reset', () => {
  test('each key round-trips its alternate value through disk into a fresh manager', () => {
    const { manager, configDir } = freshManager();
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
    }
    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: join(configDir, '..'), configDir });
    reloaded.load();
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reload`).toEqual(ALTERNATE_VALUE[key] as never);
    }
  });

  test('reset returns each key to its schema default, persistently', () => {
    const { manager, configDir } = freshManager();
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      manager.set(key as ConfigKey, ALTERNATE_VALUE[key] as never);
      manager.reset(key as ConfigKey);
    }
    const reloaded = new ConfigManager({ surfaceRoot: 'tui', workingDir: join(configDir, '..'), configDir });
    reloaded.load();
    for (const key of CONNECTOR_LOCAL_SETTINGS) {
      expect(reloaded.get(key as ConfigKey), `${key} after reset+reload`)
        .toEqual(schemaByKey.get(key)!.default as never);
    }
  });
});
