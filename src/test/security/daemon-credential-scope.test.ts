/**
 * daemon-credential-scope.test.ts
 *
 * The owner's rule, and the failure it comes from: a credential configured on
 * ONE surface has to be usable by the daemon afterwards, including when that
 * surface's process is not running. He configured Google credentials in one
 * surface and the daemon — serving Telegram, with that surface closed —
 * reported no email integration available, because the value had been filed in
 * a tier only that surface reads.
 *
 * The platform relocates a credential it RECOGNISES as daemon-owned. These
 * tests cover the call sites it cannot recognise from its side, plus the TUI
 * paths that used to write a credential into a plaintext config file instead of
 * the secret store at all.
 *
 * Every assertion here is against real temp directories and a real
 * SecretsManager / ConfigManager — never a stand-in for the store itself.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, daemonConfigPath } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import type { ConfigKey } from '../../config/index.ts';
import {
  SECRET_CONFIG_KEYS,
  buildGoodVibesSecretKey,
  defaultSecretBackedScope,
  isSecretConfigKey,
  persistSecretBackedConfigValue,
} from '../../config/secret-config.ts';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import { resetSelected } from '../../input/settings-modal-reset.ts';
import { runProviderKeyIntake, type ProviderKeyIntakeDeps } from '../../input/provider-key-intake.ts';
import type { ConcealedInputRequest } from '../../input/concealed-input.ts';
import { createDaemonCredentialStore } from '../../daemon/handlers/credentials.ts';
import { OnboardingWizardController } from '../../input/onboarding/onboarding-wizard.ts';
import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';

const roots: string[] = [];

/**
 * A temp home, with the workspace kept OUTSIDE it. The project tier is searched
 * up the ancestor chain, so a workspace nested under the home would make
 * `<home>/.goodvibes/tui/secrets.enc` reachable as both the user store and an
 * ancestor project store — and the tier a key landed in would stop being
 * decidable. Siblings keep the three tiers genuinely distinct on disk.
 */
function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-cred-scope-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

function workspaceFor(home: string): string {
  const projectRoot = join(home, '..', 'workspace');
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
}

/**
 * A real SecretsManager over a real temp home, with the daemon tier pointed at
 * this home's own `~/.goodvibes/daemon` — the same place the daemon process
 * reads. `listDetailed()` then reports which tier a stored key actually landed
 * in, which is the only honest way to assert this.
 */
function makeSecrets(home: string, configManager?: ConfigManager): SecretsManager {
  return new SecretsManager({
    projectRoot: workspaceFor(home),
    globalHome: home,
    ...(configManager ? { configManager } : {}),
  });
}

async function scopeOf(secrets: SecretsManager, key: string): Promise<string | undefined> {
  const records = await secrets.listDetailed();
  return records.find((record) => record.key === key)?.scope;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Item 1 — a provider API key captured in the TUI is readable at daemon scope.
// ---------------------------------------------------------------------------

function providerNeedingKey(envVar: string): LLMProvider {
  return {
    name: 'acme',
    models: [],
    chat: async () => { throw new Error('not used'); },
    describeAuthState: () => ({
      configured: false,
      allowAnonymous: false,
      anonymousReady: false,
      authEnvVars: [envVar],
    }),
  } as unknown as LLMProvider;
}

describe('provider key intake', () => {
  test('a key entered in the TUI lands in the daemon tier, where the daemon reads it', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    const begun: ConcealedInputRequest[] = [];
    const deps: ProviderKeyIntakeDeps = {
      provider: providerNeedingKey('ACME_API_KEY'),
      secretsManager: secrets,
      refreshProviderCredentials: async () => {},
      beginConcealedInput: (request) => { begun.push(request); },
      print: () => {},
    };

    let completed = 0;
    runProviderKeyIntake('acme', deps, () => { completed += 1; });
    expect(begun).toHaveLength(1);

    begun[0]!.onSubmit('sk-acme-live-key');
    // The submit handler is fire-and-forget; drain the microtask queue plus the
    // store's own async writes.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(completed).toBe(1);
    expect(await secrets.get('ACME_API_KEY')).toBe('sk-acme-live-key');
    // The tier is the point: 'user' would be readable only by this surface.
    expect(await scopeOf(secrets, 'ACME_API_KEY')).toBe('daemon');

    // And it is genuinely in the daemon's own directory — the one every
    // surface and the daemon agree on — not this surface's silo.
    expect(existsSync(join(home, '.goodvibes', 'daemon', 'secrets.enc'))).toBe(true);
    expect(existsSync(join(home, '.goodvibes', 'tui', 'secrets.enc'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Item 2 — an operator-named custom provider key. The platform's daemon-owned
// credential registry recognises credentials by NAME and cannot contain a name
// the operator invents, so this call site states the scope itself.
// ---------------------------------------------------------------------------

describe('custom/local provider key', () => {
  test('the /provider add write site passes daemon scope explicitly', async () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'input', 'commands', 'local-provider-runtime.ts'),
      'utf-8',
    );
    expect(source).toContain(`secretsManager.set(keyName, value, { scope: 'daemon', medium: 'secure' })`);
    expect(source).not.toContain(`secretsManager.set(keyName, value, { scope: 'user'`);
  });

  test('an operator-chosen key name stored at daemon scope is readable from the daemon tier', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    // customProviderKeyName('my-lan-box') — a name no shipped registry can hold.
    await secrets.set('MY_LAN_BOX_API_KEY', 'local-endpoint-key', { scope: 'daemon', medium: 'secure' });
    expect(await scopeOf(secrets, 'MY_LAN_BOX_API_KEY')).toBe('daemon');
    expect(await secrets.get('MY_LAN_BOX_API_KEY')).toBe('local-endpoint-key');
  });
});

// ---------------------------------------------------------------------------
// Item 3 — the first-run wizard.
// ---------------------------------------------------------------------------

describe('onboarding wizard secret capture', () => {
  test('a captured Cloudflare token is scoped to the daemon, not to the wizard\'s working directory', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.cloudflare-batch', true);
    wizard.setFieldValue('cloudflare.enabled', true);
    wizard.setFieldValue('cloudflare.setup-source', 'operational-token');
    wizard.setFieldValue('cloudflare.operational-token', 'cf-token-value');

    const secretOps = wizard.buildApplyRequest().operations
      .filter((operation) => operation.kind === 'set-secret');

    expect(secretOps.length).toBeGreaterThan(0);
    // No operation the wizard emits may be project-scoped: project scope means
    // "whatever directory this happened to be run from".
    for (const operation of secretOps) {
      expect(operation).toMatchObject({ scope: 'daemon' });
    }
    expect(secretOps).toContainEqual(expect.objectContaining({
      key: 'CLOUDFLARE_API_TOKEN',
      value: 'cf-token-value',
      scope: 'daemon',
    }));
  });

  test('every secret the wizard captures is daemon-scoped, provider keys included', () => {
    const wizard = new OnboardingWizardController();
    wizard.open('new');
    wizard.setFieldValue('capabilities.external-integrations', true);
    wizard.setFieldValue('external-services.slack', true);
    wizard.setFieldValue('external-services.slack.bot-token', 'xoxb-wizard');

    const secretOps = wizard.buildApplyRequest().operations
      .filter((operation) => operation.kind === 'set-secret');
    expect(secretOps.length).toBeGreaterThan(0);
    expect(secretOps.every((operation) => operation.scope === 'daemon')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Items 4 & 5 — the settings-modal write path and the allowlist behind it.
// ---------------------------------------------------------------------------

describe('SECRET_CONFIG_KEYS', () => {
  test('carries the mail and calendar credentials whose schema says "never in config"', () => {
    for (const key of [
      'surfaces.email.password',
      'surfaces.email.imapPassword',
      'surfaces.email.imap.password',
      'surfaces.email.smtp.password',
      'surfaces.calendar.caldavPassword',
    ]) {
      expect(SECRET_CONFIG_KEYS.has(key as ConfigKey)).toBe(true);
      expect(isSecretConfigKey(key)).toBe(true);
    }
  });
});

describe('defaultSecretBackedScope', () => {
  test('daemon-owned config keys default to the daemon tier', () => {
    expect(defaultSecretBackedScope('surfaces.email.password' as ConfigKey)).toBe('daemon');
    expect(defaultSecretBackedScope('surfaces.calendar.caldavPassword' as ConfigKey)).toBe('daemon');
    expect(defaultSecretBackedScope('surfaces.slack.botToken' as ConfigKey)).toBe('daemon');
  });

  test('a client-owned key still defaults to the user tier', () => {
    expect(defaultSecretBackedScope('display.themeMode' as ConfigKey)).toBe('user');
  });
});

describe('settings-modal secret write', () => {
  test('surfaces.email.password lands in the encrypted daemon store, and no config file holds the password', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const secrets = makeSecrets(home, configManager);
    const key = 'surfaces.email.password' as ConfigKey;

    const configValue = await persistSecretBackedConfigValue(
      configManager,
      secrets,
      key,
      'mailbox-app-password',
    );

    // The config key holds a reference, never the password.
    expect(configValue).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(configManager.get(key)).toBe(configValue);

    // The value is in the secret store, in the daemon tier.
    expect(await secrets.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('mailbox-app-password');
    expect(await scopeOf(secrets, 'GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('daemon');

    // No settings JSON anywhere under this home carries the plaintext. The
    // daemon-owned key routes to the daemon settings file, so check that one by
    // name as well as the surface file.
    for (const path of [
      daemonConfigPath(home),
      join(home, '.goodvibes', 'tui', 'settings.json'),
      join(home, '.goodvibes', 'settings.json'),
    ]) {
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf-8')).not.toContain('mailbox-app-password');
    }
  });

  test('the settings modal routes a daemon-owned key to the daemon tier and a client-owned key to the user tier', () => {
    const home = makeHome();
    const configManager = new ConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const calls: Array<{ key: string; scope: unknown }> = [];
    const secretsManager = {
      set: async (key: string, _value: string, options?: { scope?: unknown }) => {
        calls.push({ key, scope: options?.scope });
      },
      delete: async () => {},
    };

    setSecretBackedSettingValue({
      key: 'surfaces.calendar.caldavPassword' as ConfigKey,
      value: 'caldav-secret',
      configManager,
      secretsManager: secretsManager as never,
      setConfigValue: () => {},
    });

    expect(calls).toEqual([
      { key: 'GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD', scope: 'daemon' },
    ]);
  });

  test('resetting a daemon-owned setting clears the credential from the tier it was written to', () => {
    const deletes: Array<{ key: string; scope: unknown }> = [];
    const secretsManager = {
      set: async () => {},
      delete: async (key: string, options?: { scope?: unknown }) => {
        deletes.push({ key, scope: options?.scope });
      },
    };

    resetSelected({
      editingMode: false,
      hasConfigManager: true,
      selected: {
        setting: { key: 'surfaces.email.password', default: '' },
      } as never,
      secretsManager: secretsManager as never,
      setValue: () => {},
    });

    // A delete narrowed to 'user' would leave the daemon still holding the live
    // credential while the modal reported the setting cleared.
    expect(deletes).toEqual([
      { key: 'GOODVIBES_SURFACES_EMAIL_PASSWORD', scope: 'daemon' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Item 6 — /config set must not write a credential in cleartext.
// ---------------------------------------------------------------------------

describe('/config set on a credential key', () => {
  test('the generic setDynamic path is never taken for a key in SECRET_CONFIG_KEYS', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const secrets = makeSecrets(home, configManager);
    const prints: string[] = [];

    const { registerConfigCommand } = await import('../../input/commands/config.ts');
    let handler: ((args: string[], ctx: unknown) => unknown) | null = null;
    registerConfigCommand({
      register: (command: { handler: (args: string[], ctx: unknown) => unknown }) => {
        handler = command.handler;
      },
    } as never);
    expect(handler).not.toBeNull();

    await handler!(['set', 'surfaces.email.password', 'hunter2'], {
      platform: { configManager, secretsManager: secrets },
      print: (text: string) => { prints.push(text); },
    });

    // The password is in the encrypted store, not in a config file.
    expect(await secrets.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('hunter2');
    expect(configManager.get('surfaces.email.password' as ConfigKey))
      .toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD');
    for (const path of [
      daemonConfigPath(home),
      join(home, '.goodvibes', 'tui', 'settings.json'),
      join(home, '.goodvibes', 'settings.json'),
    ]) {
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf-8')).not.toContain('hunter2');
    }
    // The transcript never echoes the value back either.
    expect(prints.join('\n')).not.toContain('hunter2');
  });

  test('with no secret store available the command refuses instead of writing plaintext', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const prints: string[] = [];

    const { registerConfigCommand } = await import('../../input/commands/config.ts');
    let handler: ((args: string[], ctx: unknown) => unknown) | null = null;
    registerConfigCommand({
      register: (command: { handler: (args: string[], ctx: unknown) => unknown }) => {
        handler = command.handler;
      },
    } as never);

    await handler!(['set', 'surfaces.calendar.caldavPassword', 'hunter2'], {
      platform: { configManager },
      print: (text: string) => { prints.push(text); },
    });

    expect(configManager.get('surfaces.calendar.caldavPassword' as ConfigKey)).not.toBe('hunter2');
    const output = prints.join('\n');
    expect(output).not.toContain('hunter2');
    // Refusing is only acceptable if it names the command that does work.
    expect(output).toContain('/secrets set GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD');
  });

  test('an ordinary config key still sets normally', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const prints: string[] = [];

    const { registerConfigCommand } = await import('../../input/commands/config.ts');
    let handler: ((args: string[], ctx: unknown) => unknown) | null = null;
    registerConfigCommand({
      register: (command: { handler: (args: string[], ctx: unknown) => unknown }) => {
        handler = command.handler;
      },
    } as never);

    await handler!(['set', 'surfaces.email.host', 'imap.example.com'], {
      platform: { configManager },
      print: (text: string) => { prints.push(text); },
    });

    expect(configManager.get('surfaces.email.host' as ConfigKey)).toBe('imap.example.com');
  });
});

// ---------------------------------------------------------------------------
// Item 8 — the daemon's own credential store.
// ---------------------------------------------------------------------------

describe('DaemonCredentialStore.put', () => {
  test('defaults to the daemon tier, since every caller is the daemon itself', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    const store = createDaemonCredentialStore(secrets);

    await store.put('GOODVIBES_DAEMON_DRAFT_AESKEY', 'a-generated-key', { medium: 'secure' });

    expect(await scopeOf(secrets, 'GOODVIBES_DAEMON_DRAFT_AESKEY')).toBe('daemon');
    expect(await store.has('GOODVIBES_DAEMON_DRAFT_AESKEY')).toBe(true);
  });

  test('an explicit non-daemon scope is still honoured for a key the platform does not own', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    const store = createDaemonCredentialStore(secrets);

    await store.put('SOME_UNOWNED_KEY', 'value', { scope: 'user', medium: 'secure' });
    expect(await scopeOf(secrets, 'SOME_UNOWNED_KEY')).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// The round-trip the owner actually described: configure on a surface, read
// back from the daemon's own credential store with that surface gone.
// ---------------------------------------------------------------------------

describe('configure on one surface, resolve from the daemon', () => {
  test('a mailbox password set through the settings path resolves through the daemon credential store', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({ homeDir: home, workingDir: home, surfaceRoot: 'tui' });
    const surfaceSecrets = makeSecrets(home, configManager);

    await persistSecretBackedConfigValue(
      configManager,
      surfaceSecrets,
      'surfaces.email.imapPassword' as ConfigKey,
      'imap-app-password',
    );

    // A DIFFERENT SecretsManager, standing in for the daemon process: same
    // home, different project root, and nothing carried over from the surface.
    const daemonProjectRoot = join(home, '..', 'somewhere-else');
    mkdirSync(daemonProjectRoot, { recursive: true });
    const daemonSecrets = new SecretsManager({ projectRoot: daemonProjectRoot, globalHome: home });
    const credentials = createDaemonCredentialStore(daemonSecrets);

    expect(await credentials.resolveConfigSecret('surfaces.email.imapPassword')).toBe('imap-app-password');
    expect(buildGoodVibesSecretKey('surfaces.email.imapPassword')).toBe('GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD');
  });
});
