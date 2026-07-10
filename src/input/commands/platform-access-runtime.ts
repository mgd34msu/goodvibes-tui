import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { VERSION } from '../../version.ts';
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import { handleLocalAuthCommand } from './local-auth-runtime.ts';
import { registerUpdateCommand } from './update-runtime.ts';
import { buildAuthInspectionSnapshot, inspectProviderAuth } from '@/runtime/index.ts';
import { requireProfileManager, requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';

interface InstallBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly appVersion: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly profileCount: number;
  readonly secretKeyCount: number;
  readonly setupLinks: readonly string[];
}

interface AuthReviewBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly daemonLoginUrl: string;
  readonly listenerLoginUrl: string;
  readonly secretKeys: readonly string[];
  readonly activeSubscriptions: readonly string[];
  readonly pendingSubscriptions: readonly string[];
}

function buildSetupLink(surface: string, target?: string): string {
  const params = target ? `?target=${encodeURIComponent(target)}` : '';
  return `goodvibes://open/${surface}${params}`;
}

function inspectInstallBundle(bundle: InstallBundle): string {
  return [
    'Install Bundle Review',
    `  appVersion: ${bundle.appVersion}`,
    `  workingDirectory: ${bundle.workingDirectory}`,
    `  profileCount: ${bundle.profileCount}`,
    `  secretKeys: ${bundle.secretKeyCount}`,
    `  setupLinks: ${bundle.setupLinks.length}`,
  ].join('\n');
}

function inspectAuthBundle(bundle: AuthReviewBundle): string {
  return [
    'Auth Review Bundle',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  daemonLoginUrl: ${bundle.daemonLoginUrl}`,
    `  listenerLoginUrl: ${bundle.listenerLoginUrl}`,
    `  stored secrets: ${bundle.secretKeys.length}`,
    `  active subscriptions: ${bundle.activeSubscriptions.length}`,
    `  pending subscriptions: ${bundle.pendingSubscriptions.length}`,
  ].join('\n');
}

export function registerPlatformAccessRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'login',
    description: 'Front-door login flow for provider subscriptions and local service sessions',
    usage: '[provider <name> start|finish <code>|service <daemon|listener> <baseUrl> <username> <password> [secretKey]]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const target = (args[0] ?? '').toLowerCase();
      if (target === 'provider') {
        const provider = args[1];
        const mode = args[2]?.toLowerCase();
        if (!provider || !mode) {
          ctx.print('Usage: /login provider <name> start|finish <code>');
          return;
        }
        if (ctx.executeCommand) {
          await ctx.executeCommand('subscription', ['login', provider, mode, ...args.slice(3)]);
          return;
        }
        ctx.print(`Use /subscription login ${provider} ${mode}${args[3] ? ` ${args[3]}` : ''}`);
        return;
      }
      if (target === 'service') {
        if (ctx.executeCommand) {
          await ctx.executeCommand('auth', ['login', ...args.slice(1)]);
          return;
        }
        ctx.print('Use /auth login <daemon|listener> <baseUrl> <username> <password> [secretKey]');
        return;
      }
      ctx.print('Usage: /login [provider <name> start|finish <code>|service <daemon|listener> <baseUrl> <username> <password> [secretKey]]');
    },
  });

  registry.register({
    name: 'logout',
    description: 'Front-door logout flow for provider subscription sessions and supported overrides',
    usage: 'provider <name>',
    async handler(args, ctx) {
      const target = (args[0] ?? '').toLowerCase();
      if (target !== 'provider' || !args[1]) {
        ctx.print('Usage: /logout provider <name>');
        return;
      }
      if (ctx.executeCommand) {
        await ctx.executeCommand('subscription', ['logout', args[1]]);
        return;
      }
      ctx.print(`Use /subscription logout ${args[1]}`);
    },
  });

  registry.register({
    name: 'install',
    description: 'Review install posture and export portable install bundles',
    usage: '[review|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      if (sub === 'review') {
        const profiles = requireProfileManager(ctx).list();
        const secretKeys = await requireSecretsManager(ctx).list();
        ctx.print([
          'Install Review',
          `  version: ${VERSION}`,
          `  profiles: ${profiles.length}`,
          `  secret keys: ${secretKeys.length}`,
          `  setup links: 4`,
        ].join('\n'));
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /install bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const profiles = requireProfileManager(ctx).list();
          const secretKeys = await requireSecretsManager(ctx).list();
          const bundle: InstallBundle = {
            version: 1,
            exportedAt: Date.now(),
            appVersion: VERSION,
            workingDirectory: shellPaths.workingDirectory,
            homeDirectory: shellPaths.homeDirectory,
            profileCount: profiles.length,
            secretKeyCount: secretKeys.length,
            setupLinks: [
              buildSetupLink('cockpit'),
              buildSetupLink('security'),
              buildSetupLink('remote'),
              buildSetupLink('knowledge'),
            ],
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Install bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as InstallBundle;
          ctx.print(inspectInstallBundle(bundle));
          return;
        }
      }
      ctx.print('Usage: /install [review|bundle export <path>|bundle inspect <path>]');
    },
  });

  registerUpdateCommand(registry);

  registry.register({
    name: 'auth',
    description: 'Review auth posture and exchange session login tokens with local services',
    usage: '[review|show <provider>|repair <provider>|bundle export <path>|bundle inspect <path>|login <daemon|listener> <baseUrl> <username> <password> [secretKey]|local <review|panel|add-user|delete-user|rotate-password|revoke-session|clear-bootstrap-file>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'review';
      const subscriptions = requireSubscriptionManager(ctx);
      const serviceRegistry = requireServiceRegistry(ctx);
      const secretsManager = requireSecretsManager(ctx);
      if (sub === 'local') {
        handleLocalAuthCommand(args.slice(1), ctx);
        return;
      }
      if (sub === 'review') {
        const snapshot = await buildAuthInspectionSnapshot({
          serviceRegistry,
          subscriptionManager: subscriptions,
          secretsManager,
        });
        const builtinProviders = listBuiltinSubscriptionProviders().map((entry) => entry.provider);
        ctx.print([
          'Auth Review',
          '  daemon login route: /login',
          '  listener login route: /login',
          `  stored secrets: ${snapshot.secretKeyCount}`,
          `  built-in providers: ${builtinProviders.length}${builtinProviders.length > 0 ? ` (${builtinProviders.join(', ')})` : ''}`,
          `  active subscriptions: ${snapshot.activeSubscriptions}${snapshot.activeSubscriptions > 0 ? ` (${snapshot.providers.filter((provider) => provider.activeSubscription).map((provider) => provider.provider).join(', ')})` : ''}`,
          `  pending subscriptions: ${snapshot.pendingSubscriptions}${snapshot.pendingSubscriptions > 0 ? ` (${snapshot.providers.filter((provider) => provider.pendingLogin).map((provider) => provider.provider).join(', ')})` : ''}`,
          ...snapshot.providers.map((provider) => `  ${provider.provider}  freshness=${provider.freshness}  mode=${provider.callbackMode}  configured=${provider.configured ? 'yes' : 'no'}`),
        ].join('\n'));
        return;
      }

      if (sub === 'show') {
        const provider = args[1];
        if (!provider) {
          ctx.print('Usage: /auth show <provider>');
          return;
        }
        const inspection = await inspectProviderAuth(provider, {
          serviceRegistry,
          subscriptionManager: subscriptions,
          secretsManager,
        });
        ctx.print([
          `Auth Provider ${provider}`,
          `  configured: ${inspection.configured ? 'yes' : 'no'}`,
          ...(inspection.source ? [`  source: ${inspection.source}`] : []),
          `  freshness: ${inspection.freshness}`,
          `  callbackMode: ${inspection.callbackMode}`,
          ...(inspection.redirectUri ? [`  redirectUri: ${inspection.redirectUri}`] : []),
          ...(inspection.localCallback ? [`  localCallback: ${inspection.localCallback}`] : []),
          `  activeSubscription: ${inspection.activeSubscription ? 'yes' : 'no'}`,
          `  pendingLogin: ${inspection.pendingLogin ? 'yes' : 'no'}`,
          `  overrideAmbientApiKeys: ${inspection.overrideAmbientApiKeys ? 'yes' : 'no'}`,
          ...(inspection.tokenType ? [`  tokenType: ${inspection.tokenType}`] : []),
          ...(inspection.expiresAt ? [`  expiresAt: ${new Date(inspection.expiresAt).toISOString()}`] : []),
          ...inspection.issues.map((issue) => `  issue: ${issue}`),
          ...inspection.nextActions.map((action) => `  next: ${action}`),
        ].join('\n'));
        return;
      }

      if (sub === 'repair') {
        const provider = args[1];
        if (!provider) {
          ctx.print('Usage: /auth repair <provider>');
          return;
        }
        const inspection = await inspectProviderAuth(provider, {
          serviceRegistry,
          subscriptionManager: subscriptions,
          secretsManager,
        });
        ctx.print([
          `Auth Repair ${provider}`,
          `  configured: ${inspection.configured ? 'yes' : 'no'}`,
          `  freshness: ${inspection.freshness}`,
          `  callbackMode: ${inspection.callbackMode}`,
          ...inspection.issues.map((issue) => `  issue: ${issue}`),
          ...(inspection.nextActions.length > 0
            ? ['  next:', ...inspection.nextActions.map((action) => `    ${action}`)]
            : ['  No active repair actions suggested.']),
        ].join('\n'));
        return;
      }

      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /auth bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const secretKeys = await secretsManager.list();
          const bundle: AuthReviewBundle = {
            version: 1,
            exportedAt: Date.now(),
            daemonLoginUrl: 'http://127.0.0.1:3421/login',
            listenerLoginUrl: 'http://127.0.0.1:3422/login',
            secretKeys,
            activeSubscriptions: subscriptions.list().map((entry) => entry.provider),
            pendingSubscriptions: subscriptions.listPending().map((entry) => entry.provider),
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Auth review bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as AuthReviewBundle;
          ctx.print(inspectAuthBundle(bundle));
          return;
        }
      }

      if (sub === 'login') {
        const target = args[1];
        const baseUrl = args[2];
        const username = args[3];
        const password = args[4];
        const secretKey = args[5] ?? `${target?.toUpperCase() ?? 'SERVICE'}_SESSION_TOKEN`;
        if ((target !== 'daemon' && target !== 'listener') || !baseUrl || !username || !password) {
          ctx.print('Usage: /auth login <daemon|listener> <baseUrl> <username> <password> [secretKey]');
          return;
        }
        const url = new URL('/login', baseUrl).toString();
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (!response.ok) {
          const body = await response.text();
          ctx.print(`Auth login failed (${response.status}): ${body}`);
          return;
        }
        const body = await response.json() as { token?: unknown };
        if (typeof body.token !== 'string') {
          ctx.print('Auth login response did not include a session token.');
          return;
        }
        await requireSecretsManager(ctx).set(secretKey, body.token);
        ctx.print(`Stored ${target} session token in secure storage as ${secretKey}.`);
        return;
      }

      ctx.print('Usage: /auth [review|show <provider>|bundle export <path>|bundle inspect <path>|login <daemon|listener> <baseUrl> <username> <password> [secretKey]|local <review|panel|add-user|delete-user|rotate-password|revoke-session|clear-bootstrap-file>]');
    },
  });
}
