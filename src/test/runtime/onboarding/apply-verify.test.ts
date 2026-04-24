import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { createShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import { SecretsManager } from '../../../config/secrets.ts';
import {
  applyOnboardingRequest,
  collectOnboardingSnapshot,
  deriveReopenEditAcknowledgementState,
  readOnboardingCheckMarker,
  verifyOnboardingRequest,
} from '../../../runtime/onboarding/index.ts';

describe('onboarding apply and verify helpers', () => {
  let root: string;
  let configManager: ConfigManager;
  let shellPaths: ReturnType<typeof createShellPathService>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-onboarding-apply-'));
    shellPaths = createShellPathService({
      workingDirectory: join(root, 'workspace'),
      homeDirectory: join(root, 'home'),
    });
    configManager = new ConfigManager({
      surfaceRoot: 'tui',
      homeDir: join(root, 'home'),
      workingDir: join(root, 'workspace'),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('applies project onboarding settings and acknowledgements with verification', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
          scope: 'project' as const,
        },
        {
          kind: 'acknowledge' as const,
          target: 'providers' as const,
          acknowledged: true,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(applied.ok).toBe(true);
    expect(applied.errors).toEqual([]);
    expect(configManager.get('display.stream')).toBe(false);

    const projectSettingsPath = shellPaths.resolveProjectPath('tui', 'settings.json');
    const globalSettingsPath = shellPaths.resolveUserPath('tui', 'settings.json');
    const projectSettings = JSON.parse(readFileSync(projectSettingsPath, 'utf-8')) as Record<string, unknown>;

    expect(projectSettings).toMatchObject({
      display: {
        stream: false,
      },
    });
    expect(existsSync(globalSettingsPath)).toBe(false);

    const verification = await verifyOnboardingRequest(
      {
        clock: () => 200,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(verification.ok).toBe(true);
    expect(verification.items.map((item) => item.status)).toEqual(['pass', 'pass']);
  });

  test('prevalidates all config operations before mutating settings', async () => {
    const request = {
      mode: 'edit' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
        },
        {
          kind: 'set-config' as const,
          key: 'surfaces.webhook.timeoutMs' as const,
          value: 999,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('does not touch check markers when settings verification fails', async () => {
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
        },
      ],
    };
    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: {
          get: ((key: Parameters<ConfigManager['get']>[0]) => {
            if (key === 'display.stream') return true;
            throw new Error(`Unexpected config get in verification-failure test: ${key}`);
          }) as ConfigManager['get'],
          getRaw: configManager.getRaw.bind(configManager),
          load: configManager.load.bind(configManager),
          setDynamic: configManager.setDynamic.bind(configManager),
        },
        shellPaths,
        acknowledgementScope: 'project',
      },
      request,
    );

    const marker = readOnboardingCheckMarker(shellPaths, 'project');
    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(applied.errors.map((error) => error.message).join('\n')).toContain('verify config:display.stream');
    expect(marker.exists).toBe(false);
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('stores wizard secrets through SecretsManager and verifies local auth bootstrap', async () => {
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    const auth = new UserAuthManager({
      bootstrapFilePath: join(root, 'home', 'auth-bootstrap.json'),
      bootstrapCredentialPath: join(root, 'home', 'auth-bootstrap-password.txt'),
    });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'ensure-auth-user' as const,
          username: 'admin',
          password: 'admin-pass',
          roles: ['admin'],
          createSession: true,
        },
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_SURFACES_SLACK_BOT_TOKEN',
          value: 'xoxb-secret',
          scope: 'project' as const,
          medium: 'plaintext' as const,
        },
        {
          kind: 'set-config' as const,
          key: 'surfaces.slack.botToken' as const,
          value: 'goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN',
        },
      ],
    };

    const deps = {
      clock: () => 100,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project' as const,
      secrets,
      auth,
    };
    const applied = await applyOnboardingRequest(deps, request);
    const verification = await verifyOnboardingRequest(deps, request);

    expect(applied.ok).toBe(true);
    expect(verification.ok).toBe(true);
    expect(await secrets.get('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe('xoxb-secret');
    expect(configManager.get('surfaces.slack.botToken')).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_SLACK_BOT_TOKEN');
    expect(auth.inspect().userCount).toBe(1);
    expect(auth.inspect().sessionCount).toBe(1);
  });

  test('applies secret storage policy before secrets entered in the same wizard run', async () => {
    configManager.set('storage.secretPolicy', 'require_secure');
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_POLICY_ORDER_SECRET',
          value: 'secret-value',
          scope: 'project' as const,
          medium: 'plaintext' as const,
        },
        {
          kind: 'set-config' as const,
          key: 'storage.secretPolicy' as const,
          value: 'plaintext_allowed',
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
        secrets,
      },
      request,
    );

    expect(applied.ok).toBe(true);
    expect(await secrets.get('GOODVIBES_POLICY_ORDER_SECRET')).toBe('secret-value');
    expect(configManager.get('storage.secretPolicy')).toBe('plaintext_allowed');
  });

  test('verifies set-secret operations that store GoodVibes secret refs by resolution', async () => {
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    await secrets.set('GOODVIBES_INNER_SECRET', 'inner-value', { scope: 'project', medium: 'secure' });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_OUTER_SECRET',
          value: 'goodvibes://secrets/goodvibes/GOODVIBES_INNER_SECRET',
          scope: 'project' as const,
          medium: 'secure' as const,
        },
      ],
    };
    const deps = {
      clock: () => 100,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project' as const,
      secrets,
    };

    const applied = await applyOnboardingRequest(deps, request);
    const verification = await verifyOnboardingRequest(deps, request);

    expect(applied.ok).toBe(true);
    expect(verification.ok).toBe(true);
    expect(await secrets.get('GOODVIBES_OUTER_SECRET')).toBe('inner-value');
  });

  test('replaces SDK bootstrap credentials with wizard-created auth before server exposure', async () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: join(root, 'home', 'auth-bootstrap.json'),
      bootstrapCredentialPath: join(root, 'home', 'auth-bootstrap-password.txt'),
    });
    expect(auth.inspect().bootstrapCredentialPresent).toBe(true);

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
        auth,
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          {
            kind: 'ensure-auth-user',
            username: 'goodvibes-admin',
            password: 'wizard-pass',
            roles: ['admin'],
            createSession: true,
            retireBootstrapCredential: true,
          },
        ],
      },
    );

    const snapshot = auth.inspect();
    expect(applied.ok).toBe(true);
    expect(snapshot.bootstrapCredentialPresent).toBe(false);
    expect(snapshot.users.map((user) => user.username)).toEqual(['goodvibes-admin']);
    expect(snapshot.sessionCount).toBe(1);
  });

  test('replaces SDK bootstrap credentials while reusing an existing admin username', async () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: join(root, 'home', 'auth-bootstrap.json'),
      bootstrapCredentialPath: join(root, 'home', 'auth-bootstrap-password.txt'),
    });
    const originalBootstrap = readFileSync(join(root, 'home', 'auth-bootstrap-password.txt'), 'utf-8');
    const originalPassword = originalBootstrap.split('\n')
      .find((line) => line.startsWith('password='))
      ?.slice('password='.length) ?? '';
    expect(auth.inspect().users.map((user) => user.username)).toEqual(['admin']);
    expect(auth.inspect().bootstrapCredentialPresent).toBe(true);

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
        auth,
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          {
            kind: 'ensure-auth-user',
            username: 'admin',
            password: 'wizard-pass',
            roles: ['admin'],
            createSession: true,
            retireBootstrapCredential: true,
          },
        ],
      },
    );

    const snapshot = auth.inspect();
    expect(applied.ok).toBe(true);
    expect(snapshot.bootstrapCredentialPresent).toBe(false);
    expect(snapshot.users.map((user) => user.username)).toEqual(['admin']);
    expect(snapshot.sessionCount).toBe(1);
    expect(auth.authenticate('admin', 'wizard-pass')).not.toBeNull();
    expect(auth.authenticate('admin', originalPassword)).toBeNull();
  });

  test('rolls back bootstrap auth replacement when a later apply operation fails', async () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: join(root, 'home', 'auth-bootstrap.json'),
      bootstrapCredentialPath: join(root, 'home', 'auth-bootstrap-password.txt'),
    });

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: {
          get: configManager.get.bind(configManager),
          getRaw: configManager.getRaw.bind(configManager),
          load: configManager.load.bind(configManager),
          setDynamic: () => {
            throw new Error('simulated config write failure');
          },
        },
        shellPaths,
        acknowledgementScope: 'project',
        auth,
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          {
            kind: 'ensure-auth-user',
            username: 'goodvibes-admin',
            password: 'wizard-pass',
            roles: ['admin'],
            createSession: true,
            retireBootstrapCredential: true,
          },
          {
            kind: 'set-config',
            key: 'display.stream',
            value: false,
          },
        ],
      },
    );

    const snapshot = auth.inspect();
    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(snapshot.bootstrapCredentialPresent).toBe(true);
    expect(snapshot.users.map((user) => user.username)).toEqual(['admin']);
    expect(snapshot.sessionCount).toBe(0);
  });

  test('rolls back earlier secret writes when a later apply operation fails', async () => {
    const secrets = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    const request = {
      mode: 'new' as const,
      source: 'wizard',
      operations: [
        {
          kind: 'set-secret' as const,
          key: 'GOODVIBES_ROLLBACK_SECRET',
          value: 'secret-value',
          scope: 'project' as const,
          medium: 'plaintext' as const,
        },
        {
          kind: 'set-config' as const,
          key: 'display.stream' as const,
          value: false,
        },
      ],
    };

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: {
          get: configManager.get.bind(configManager),
          getRaw: configManager.getRaw.bind(configManager),
          load: configManager.load.bind(configManager),
          setDynamic: () => {
            throw new Error('simulated config write failure');
          },
        },
        shellPaths,
        acknowledgementScope: 'project',
        secrets,
      },
      request,
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(await secrets.get('GOODVIBES_ROLLBACK_SECRET')).toBeNull();
    expect(configManager.get('display.stream')).toBe(true);
  });

  test('prevalidates existing auth users that lack required admin role', async () => {
    const auth = new UserAuthManager({
      bootstrapFilePath: join(root, 'home', 'auth-bootstrap.json'),
      bootstrapCredentialPath: join(root, 'home', 'auth-bootstrap-password.txt'),
      users: [
        {
          username: 'operator',
          passwordHash: UserAuthManager.hashPassword('operator-pass'),
          roles: ['operator'],
        },
      ],
    });

    const applied = await applyOnboardingRequest(
      {
        clock: () => 100,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
        auth,
      },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          {
            kind: 'ensure-auth-user',
            username: 'operator',
            password: 'operator-pass',
            roles: ['admin'],
            createSession: true,
          },
        ],
      },
    );

    expect(applied.ok).toBe(false);
    expect(applied.applied).toEqual([]);
    expect(auth.inspect().sessionCount).toBe(0);
  });

  test('round-trips persisted acknowledgement state back into reopen hydration', async () => {
    await applyOnboardingRequest(
      {
        clock: () => 10,
        config: configManager,
        shellPaths,
        acknowledgementScope: 'project',
      },
      {
        mode: 'reopen',
        source: 'wizard',
        operations: [
          {
            kind: 'acknowledge',
            target: 'providers',
            acknowledged: true,
          },
        ],
      },
    );

    const snapshot = await collectOnboardingSnapshot({
      clock: () => 20,
      config: configManager,
      shellPaths,
      acknowledgementScope: 'project',
      subscriptions: {
        list: () => [],
        listPending: () => [],
        get: () => null,
        getPending: () => null,
      },
      secrets: {
        inspect: async () => ({
          policy: 'preferred_secure',
          secureAvailable: false,
          storedKeys: 1,
          envBackedKeys: 1,
          secureKeys: 0,
          plaintextKeys: 0,
          warnings: [],
          locations: [],
        }),
        listDetailed: async () => ([
          {
            key: 'OPENAI_API_KEY',
            source: 'env',
            scope: 'env',
            secure: false,
            overriddenByEnv: false,
          },
        ]),
      },
      auth: {
        inspect: () => ({
          userStorePath: '/tmp/auth-users.json',
          bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
          persisted: true,
          bootstrapCredentialPresent: false,
          userCount: 0,
          sessionCount: 0,
          users: [],
          sessions: [],
        }),
      },
      services: {
        getAll: () => ({
          openai: {
            name: 'openai',
            providerId: 'openai',
            authType: 'api-key',
            tokenKey: 'OPENAI_API_KEY',
          },
        }),
        inspect: async () => ({
          config: {
            name: 'openai',
            providerId: 'openai',
            authType: 'api-key',
            tokenKey: 'OPENAI_API_KEY',
          },
          hasPrimaryCredential: true,
          hasPasswordCredential: false,
          hasWebhookUrl: false,
          hasSigningSecret: false,
          hasPublicKey: false,
        }),
      },
    });

    expect(snapshot.acknowledgements.accepted.providers).toBe(true);

    expect(deriveReopenEditAcknowledgementState(snapshot).providers).toEqual({
      required: true,
      accepted: true,
      reason: 'configured-routing',
      detail: '1 provider auth path(s) are already configured.',
    });
  });
});
