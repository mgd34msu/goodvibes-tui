/**
 * settings-daemon-owned-writes.test.ts, a setting the DAEMON applies is
 * written where the daemon reads it.
 *
 * ── The failure this covers ───────────────────────────────────────────────
 *
 * The platform's oldest recurring defect, in its exact shape: a Telegram bot
 * token typed into a settings modal, saved with a confirmation, landing in
 * `~/.goodvibes/tui/settings.json`, and configuring nothing, because the
 * daemon is the process that answers Telegram and it reads a different file.
 * Nothing errors. The capability is simply dead, and the person who set it up
 * has a receipt saying it worked.
 *
 * While this app hosted the daemon that could not happen: one process, one
 * tree. As a client it is the default outcome unless the write is routed, so
 * these are the assertions that keep the routing honest.
 *
 * ── What is asserted, and what is deliberately not ────────────────────────
 *
 * The classification comes from the SDK's config-ownership tables and is not
 * re-listed here, a second copy of those lists is how the web UI's ownership
 * badge drifted. What is pinned is the ROUTING: a daemon-owned key reaches the
 * daemon writer, a surface-owned key does not, and a daemon that refuses is
 * reported rather than swallowed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigManager as RealConfigManager,
  daemonConfigPath,
  isDaemonOwnedConfigKey,
} from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigKey, ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { applySettingValue, type DaemonOwnedConfigWriter } from '../../input/settings-modal-mutations.ts';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function stubConfigManager(): ConfigManager & { readonly writes: [string, unknown][] } {
  const writes: [string, unknown][] = [];
  const values = new Map<string, unknown>();
  return {
    writes,
    get: (key: string) => values.get(key),
    setDynamic: (key: string, value: unknown) => { writes.push([key, value]); values.set(key, value); },
  } as unknown as ConfigManager & { readonly writes: [string, unknown][] };
}

function recordingDaemonWriter(behaviour: 'ok' | 'reject' = 'ok'): DaemonOwnedConfigWriter & { readonly sent: [string, unknown][] } {
  const sent: [string, unknown][] = [];
  return {
    sent,
    ownsKey: (key: string) => isDaemonOwnedConfigKey(key),
    set: async (key: string, value: unknown) => {
      sent.push([key, value]);
      if (behaviour === 'reject') throw new Error('the daemon is not reachable');
    },
  };
}

const noGroups = new Map();

describe('a setting the daemon applies is written where the daemon reads it', () => {
  test('a daemon-owned key is sent to the daemon', () => {
    const configManager = stubConfigManager();
    const daemonConfig = recordingDaemonWriter();
    // watchers.* is daemon-owned: the daemon runs the watcher framework, so a
    // watcher this surface saved into its own file would never fire.
    applySettingValue({
      key: 'watchers.enabled' as ConfigKey,
      value: false,
      configManager,
      groups: noGroups,
      onSettingApplied: null,
      refreshGroups: () => {},
      daemonConfig,
    });
    expect(daemonConfig.sent).toEqual([['watchers.enabled', false]]);
  });

  test('a surface-owned key is NOT sent to the daemon', () => {
    const configManager = stubConfigManager();
    const daemonConfig = recordingDaemonWriter();
    // A theme is this installation's, not the platform's. Sending it would make
    // one machine's appearance everyone's.
    applySettingValue({
      key: 'ui.theme' as ConfigKey,
      value: 'dark',
      configManager,
      groups: noGroups,
      onSettingApplied: null,
      refreshGroups: () => {},
      daemonConfig,
    });
    expect(daemonConfig.sent).toEqual([]);
    expect(configManager.writes).toEqual([['ui.theme', 'dark']]);
  });

  test('with no daemon writer every key stays local, which is right when there is no daemon', () => {
    const configManager = stubConfigManager();
    applySettingValue({
      key: 'watchers.enabled' as ConfigKey,
      value: true,
      configManager,
      groups: noGroups,
      onSettingApplied: null,
      refreshGroups: () => {},
    });
    expect(configManager.writes).toEqual([['watchers.enabled', true]]);
  });

  test('a daemon that refuses is reported, never swallowed', async () => {
    const configManager = stubConfigManager();
    const daemonConfig = recordingDaemonWriter('reject');
    const reported: string[] = [];
    applySettingValue({
      key: 'watchers.enabled' as ConfigKey,
      value: false,
      configManager,
      groups: noGroups,
      onSettingApplied: null,
      refreshGroups: () => {},
      daemonConfig,
      onAsyncError: (message) => { reported.push(message); },
    });
    // The write is fire-and-forget so a slow daemon never blocks the keystroke;
    // the rejection lands on the next turn of the loop.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('not reachable');
  });
});

describe('a credential the daemon spends is stored by the daemon, in one call', () => {
  test('a daemon-scoped credential never touches this surface\'s own secret store', () => {
    const configManager = stubConfigManager();
    const localWrites: string[] = [];
    const daemonWrites: [string, string][] = [];
    setSecretBackedSettingValue({
      key: 'surfaces.telegram.botToken' as ConfigKey,
      value: 'not-a-real-token',
      configManager,
      secretsManager: {
        set: async (key: string) => { localWrites.push(key); },
        delete: async (key: string) => { localWrites.push(key); },
      } as never,
      daemonCredentials: {
        set: async (key: string, value: string) => { daemonWrites.push([key, value]); },
        clear: async () => {},
      },
      setConfigValue: (key, value) => { configManager.setDynamic(key, value); },
    });
    // One call, to the daemon. Not a local secret write, and not a local config
    // write either: `credentials.set` replaces the config value with the
    // reference itself, after verifying the secret reads back.
    expect(daemonWrites).toEqual([['surfaces.telegram.botToken', 'not-a-real-token']]);
    expect(localWrites).toEqual([]);
    expect(configManager.writes).toEqual([]);
  });

  test('clearing a daemon-scoped credential clears it on the daemon', () => {
    const configManager = stubConfigManager();
    const cleared: string[] = [];
    setSecretBackedSettingValue({
      key: 'surfaces.telegram.botToken' as ConfigKey,
      value: '   ',
      configManager,
      secretsManager: { set: async () => {}, delete: async () => {} } as never,
      daemonCredentials: {
        set: async () => { throw new Error('an empty value must clear, never store'); },
        clear: async (key: string) => { cleared.push(key); },
      },
      setConfigValue: () => {},
    });
    expect(cleared).toEqual(['surfaces.telegram.botToken']);
  });

  test('without a daemon writer the historical local path is unchanged', () => {
    const configManager = stubConfigManager();
    const localWrites: string[] = [];
    setSecretBackedSettingValue({
      key: 'surfaces.telegram.botToken' as ConfigKey,
      value: 'not-a-real-token',
      configManager,
      secretsManager: {
        set: async (key: string) => { localWrites.push(key); },
        delete: async () => {},
      } as never,
      setConfigValue: (key, value) => { configManager.setDynamic(key, value); },
    });
    expect(localWrites).toEqual(['GOODVIBES_SURFACES_TELEGRAM_BOT_TOKEN']);
    expect(configManager.writes[0]?.[1]).toContain('goodvibes://secrets/');
  });
});

// ---------------------------------------------------------------------------
// The other way in. `/config set <key> <value>` sets the same keys the modal
// does, so it has to route a credential the same way, otherwise the two ways
// of setting one key disagree about where the value lands, and the command
// line is the one that puts a mailbox password in cleartext on disk.
//
// Real ConfigManager and real SecretsManager over real temp directories, never
// a stand-in for the store: what is asserted is WHERE a value ended up, and a
// fake store can only report where it was told to put it.
// ---------------------------------------------------------------------------

const credentialRoots: string[] = [];

afterEach(() => {
  for (const dir of credentialRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp home with the workspace kept OUTSIDE it. The project tier is searched
 * up the ancestor chain, so a workspace nested under the home would make
 * `<home>/.goodvibes/tui/secrets.enc` reachable as both the user store and an
 * ancestor project store, and which tier a key landed in would stop being
 * decidable. Siblings keep the tiers genuinely distinct on disk.
 */
function makeCredentialHome(): { home: string; projectRoot: string } {
  const root = makeProjectTempDir('gv-config-set-credential');
  credentialRoots.push(root);
  const home = join(root, 'home');
  const projectRoot = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { home, projectRoot };
}

/** Run `/config set <args>` through the registered command, as a caller does. */
async function runConfigSet(
  platform: Record<string, unknown>,
  args: readonly string[],
): Promise<string[]> {
  const printed: string[] = [];
  let handler: ((args: string[], ctx: unknown) => unknown) | null = null;
  registerConfigCommand({
    register: (command: { handler: (args: string[], ctx: unknown) => unknown }) => {
      handler = command.handler;
    },
  } as never);
  expect(handler, '/config registered a handler').not.toBeNull();
  await handler!(['set', ...args], { platform, print: (text: string) => { printed.push(text); } });
  return printed;
}

/** Every settings file this home could hold, for a plaintext sweep. */
function settingsFilesUnder(home: string): string[] {
  return [
    daemonConfigPath(home),
    join(home, '.goodvibes', 'tui', 'settings.json'),
    join(home, '.goodvibes', 'settings.json'),
  ].filter((path) => existsSync(path));
}

describe('/config set routes a credential key the same way the modal does', () => {
  test('the value reaches the encrypted daemon tier and no config file holds it', async () => {
    const { home, projectRoot } = makeCredentialHome();
    const configManager = new RealConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const secrets = new SecretsManager({ projectRoot, globalHome: home, configManager });

    const printed = await runConfigSet(
      { configManager, secretsManager: secrets },
      ['surfaces.email.password', 'not-a-real-password'],
    );

    // The generic setDynamic path would have put this literal in a JSON file.
    expect(await secrets.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('not-a-real-password');
    expect(configManager.get('surfaces.email.password' as ConfigKey))
      .toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD');
    // The daemon is the process that opens the mailbox, so the daemon's tier is
    // where the credential has to be readable from.
    const records = await secrets.listDetailed();
    expect(records.find((record) => record.key === 'GOODVIBES_SURFACES_EMAIL_PASSWORD')?.scope).toBe('daemon');

    for (const path of settingsFilesUnder(home)) {
      expect(readFileSync(path, 'utf-8'), path).not.toContain('not-a-real-password');
    }
    // The transcript is scrolled back through, pasted into support threads and
    // caught in screen recordings, so it gets the reference, never the value.
    expect(printed.join('\n')).not.toContain('not-a-real-password');
    expect(printed.join('\n')).toContain('GOODVIBES_SURFACES_EMAIL_PASSWORD');
  });

  test('with no secret store reachable it refuses, and names the command that works', async () => {
    const { home } = makeCredentialHome();
    const configManager = new RealConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });

    const printed = await runConfigSet(
      { configManager },
      ['surfaces.calendar.caldavPassword', 'not-a-real-password'],
    );

    // Refusing is only acceptable because it says what to do instead.
    const output = printed.join('\n');
    expect(configManager.get('surfaces.calendar.caldavPassword' as ConfigKey)).not.toBe('not-a-real-password');
    expect(output).not.toContain('not-a-real-password');
    expect(output).toContain('/secrets set GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD');
    for (const path of settingsFilesUnder(home)) {
      expect(readFileSync(path, 'utf-8'), path).not.toContain('not-a-real-password');
    }
  });

  test('an ordinary key still takes the generic path', async () => {
    const { home } = makeCredentialHome();
    const configManager = new RealConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });

    await runConfigSet({ configManager }, ['surfaces.email.host', 'imap.example.com']);

    expect(configManager.get('surfaces.email.host' as ConfigKey)).toBe('imap.example.com');
  });
});
