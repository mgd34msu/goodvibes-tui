import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { collectOnboardingSnapshot } from '../../../runtime/onboarding/index.ts';

function buildLocalAuthSnapshot() {
  return {
    userStorePath: '/tmp/auth-users.json',
    bootstrapCredentialPath: '/tmp/auth-bootstrap.txt',
    persisted: true,
    bootstrapCredentialPresent: false,
    userCount: 0,
    sessionCount: 0,
    users: [],
    sessions: [],
  };
}

describe('collectOnboardingSnapshot', () => {
  let root: string;
  let configManager: ConfigManager;
  let shellPaths: ReturnType<typeof createShellPathService>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-onboarding-snapshot-'));
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

  test('captures wizard-critical defaults and provider routing state', async () => {
    configManager.set('provider.reasoningEffort', 'high');
    configManager.set('permissions.mode', 'custom');
    configManager.set('behavior.saveHistory', false);
    configManager.set('display.showThinking', true);
    configManager.set('storage.secretPolicy', 'require_secure');
    configManager.set('surfaces.slack.enabled', true);

    const snapshot = await collectOnboardingSnapshot({
      clock: () => 123,
      config: configManager,
      shellPaths,
      subscriptions: {
        list: () => [],
        listPending: () => [],
        get: () => null,
        getPending: () => null,
      },
      secrets: {
        inspect: async () => ({
          policy: 'require_secure',
          secureAvailable: true,
          storedKeys: 2,
          envBackedKeys: 1,
          secureKeys: 2,
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
        inspect: () => buildLocalAuthSnapshot(),
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
          hasAppToken: false,
        }),
      },
      surfaces: {
        list: () => ([
          {
            id: 'surface:slack',
            kind: 'slack',
            label: 'Slack',
            enabled: true,
            state: 'healthy',
            capabilities: ['send'],
            metadata: {},
          },
        ]),
      },
      providerAccounts: {
        loadSnapshot: async () => ({
          capturedAt: 456,
          configuredCount: 1,
          issueCount: 0,
          providers: [
            {
              providerId: 'openai',
              configured: true,
              active: true,
              oauthReady: false,
              pendingLogin: false,
              availableRoutes: ['api-key'],
              activeRoute: 'api-key',
              authFreshness: 'healthy',
            },
          ],
        }),
      },
      legacyDaemon: {
        detect: () => ({ present: true, active: true, path: join(root, 'home', '.config/systemd/user/goodvibes-daemon.service') }),
      },
    });

    expect(snapshot.capturedAt).toBe(123);
    expect(snapshot.legacyDaemon).toEqual({
      present: true,
      active: true,
      path: join(root, 'home', '.config/systemd/user/goodvibes-daemon.service'),
    });
    expect(snapshot.providerRouting.primaryReasoningEffort).toBe('high');
    expect(snapshot.config.permissions.mode).toBe('custom');
    expect(snapshot.config.behavior.saveHistory).toBe(false);
    expect(snapshot.config.display.showThinking).toBe(true);
    expect(snapshot.config.storage.secretPolicy).toBe('require_secure');
    expect(snapshot.runtimeDefaults).toEqual({
      providerReasoningEffort: 'high',
      permissionsMode: 'custom',
      behavior: snapshot.config.behavior,
      display: snapshot.config.display,
      secretStoragePolicy: 'require_secure',
    });
    expect(snapshot.acknowledgements).toEqual({
      scope: 'project',
      exists: false,
      updatedAt: null,
      source: null,
      accepted: {},
    });
    expect(snapshot.surfaces.records).toHaveLength(1);
    expect(snapshot.providerAccounts?.providers[0]?.activeRoute).toBe('api-key');
    expect(snapshot.collectionIssues).toEqual([]);
  });

  test('degrades gracefully when optional surfaces and provider-account reads fail', async () => {
    const snapshot = await collectOnboardingSnapshot({
      clock: () => 789,
      config: configManager,
      shellPaths,
      subscriptions: {
        list: () => [],
        listPending: () => [],
        get: () => null,
        getPending: () => null,
      },
      secrets: {
        inspect: async () => ({
          policy: 'preferred_secure',
          secureAvailable: true,
          storedKeys: 0,
          envBackedKeys: 0,
          secureKeys: 0,
          plaintextKeys: 0,
          warnings: [],
          locations: [],
        }),
        listDetailed: async () => [],
      },
      auth: {
        inspect: () => buildLocalAuthSnapshot(),
      },
      services: {
        getAll: () => ({}),
        inspect: async () => null,
      },
      surfaces: {
        list: () => {
          throw new Error('surface registry unavailable');
        },
      },
      providerAccounts: {
        loadSnapshot: async () => {
          throw new Error('provider account query offline');
        },
      },
      legacyDaemon: {
        detect: () => {
          throw new Error('legacy unit detection unavailable');
        },
      },
    });

    expect(snapshot.capturedAt).toBe(789);
    expect(snapshot.surfaces.records).toEqual([]);
    expect(snapshot.providerAccounts).toBeNull();
    expect(snapshot.legacyDaemon).toEqual({ present: false, active: false, path: '' });
    expect(snapshot.collectionIssues).toEqual([
      {
        area: 'surfaces',
        message: 'surface registry unavailable',
      },
      {
        area: 'provider-accounts',
        message: 'provider account query offline',
      },
      {
        area: 'legacy-daemon',
        message: 'legacy unit detection unavailable',
      },
    ]);
  });

  test('defaults legacyDaemon to absent when no legacyDaemon dependency is supplied', async () => {
    const snapshot = await collectOnboardingSnapshot({
      clock: () => 1,
      config: configManager,
      shellPaths,
      subscriptions: { list: () => [], listPending: () => [], get: () => null, getPending: () => null },
      secrets: {
        inspect: async () => ({
          policy: 'preferred_secure',
          secureAvailable: true,
          storedKeys: 0,
          envBackedKeys: 0,
          secureKeys: 0,
          plaintextKeys: 0,
          warnings: [],
          locations: [],
        }),
        listDetailed: async () => [],
      },
      auth: { inspect: () => buildLocalAuthSnapshot() },
      services: { getAll: () => ({}), inspect: async () => null },
    });

    expect(snapshot.legacyDaemon).toEqual({ present: false, active: false, path: '' });
    expect(snapshot.collectionIssues.some((issue) => issue.area === 'legacy-daemon')).toBe(false);
  });

  test('degrades gracefully when core service and secret inspectors fail', async () => {
    const snapshot = await collectOnboardingSnapshot({
      clock: () => 999,
      config: configManager,
      shellPaths,
      subscriptions: {
        list: () => [],
        listPending: () => [],
        get: () => null,
        getPending: () => null,
      },
      secrets: {
        inspect: async () => {
          throw new Error('secret review unavailable');
        },
        listDetailed: async () => {
          throw new Error('secret inventory unavailable');
        },
      },
      auth: {
        inspect: () => buildLocalAuthSnapshot(),
      },
      services: {
        getAll: () => ({
          webhook: {
            name: 'webhook',
            providerId: 'webhook',
            authType: 'api-key',
            tokenKey: 'WEBHOOK_TOKEN',
            baseUrl: 'https://hooks.example.test',
          },
        }),
        inspect: async () => {
          throw new Error('service inspection unavailable');
        },
      },
    });

    expect(snapshot.capturedAt).toBe(999);
    expect(snapshot.services).toEqual({
      total: 1,
      oauthProviderIds: [],
      services: [
        {
          name: 'webhook',
          providerId: 'webhook',
          baseUrl: 'https://hooks.example.test',
          authType: 'api-key',
          tokenKey: 'WEBHOOK_TOKEN',
          oauthConfigured: false,
          hasPrimaryCredential: false,
          hasPasswordCredential: false,
          hasWebhookUrl: false,
          hasSigningSecret: false,
          hasPublicKey: false,
          hasAppToken: false,
        },
      ],
    });
    expect(snapshot.secrets.review).toEqual({
      policy: 'preferred_secure',
      secureAvailable: false,
      storedKeys: 0,
      envBackedKeys: 0,
      secureKeys: 0,
      plaintextKeys: 0,
      warnings: [],
      locations: [],
    });
    expect(snapshot.secrets.records).toEqual([]);
    expect(snapshot.collectionIssues).toEqual([
      {
        area: 'services',
        message: 'webhook: service inspection unavailable',
      },
      {
        area: 'secrets-review',
        message: 'secret review unavailable',
      },
      {
        area: 'secrets-records',
        message: 'secret inventory unavailable',
      },
    ]);
  });

  test('degrades gracefully when services, subscriptions, and auth readers fail before optional hydration', async () => {
    const snapshot = await collectOnboardingSnapshot({
      clock: () => 1111,
      config: configManager,
      shellPaths,
      subscriptions: {
        list: () => {
          throw new Error('active subscriptions unavailable');
        },
        listPending: () => {
          throw new Error('pending subscriptions unavailable');
        },
        get: () => null,
        getPending: () => null,
      },
      secrets: {
        inspect: async () => ({
          policy: 'preferred_secure',
          secureAvailable: true,
          storedKeys: 0,
          envBackedKeys: 0,
          secureKeys: 0,
          plaintextKeys: 0,
          warnings: [],
          locations: [],
        }),
        listDetailed: async () => [],
      },
      auth: {
        inspect: () => {
          throw new Error('auth inspection unavailable');
        },
      },
      services: {
        getAll: () => {
          throw new Error('service registry unavailable');
        },
        inspect: async () => null,
      },
    });

    expect(snapshot.capturedAt).toBe(1111);
    expect(snapshot.services).toEqual({
      total: 0,
      oauthProviderIds: [],
      services: [],
    });
    expect(snapshot.subscriptions).toEqual({
      active: [],
      pending: [],
      activeProviderIds: [],
      pendingProviderIds: [],
    });
    expect(snapshot.auth.snapshot).toEqual({
      userStorePath: '',
      bootstrapCredentialPath: '',
      persisted: false,
      bootstrapCredentialPresent: false,
      userCount: 0,
      sessionCount: 0,
      users: [],
      sessions: [],
    });
    expect(snapshot.collectionIssues).toEqual([
      {
        area: 'services',
        message: 'service registry unavailable',
      },
      {
        area: 'subscriptions-active',
        message: 'active subscriptions unavailable',
      },
      {
        area: 'subscriptions-pending',
        message: 'pending subscriptions unavailable',
      },
      {
        area: 'auth',
        message: 'auth inspection unavailable',
      },
    ]);
  });
});
