import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { createOAuthLocalListener } from '@pellux/goodvibes-sdk/platform/config/oauth-local-listener';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config/openai-codex-auth';
import type { OAuthProviderConfig, ProviderSubscription } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '../../config/subscription-providers.ts';
import { inspectProviderAuth } from '../../runtime/auth/inspection.ts';
import { openExternalUrl } from '@pellux/goodvibes-sdk/platform/utils/open-external';
import { requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

interface SubscriptionBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly subscriptions: readonly ProviderSubscription[];
}

function buildReviewText(ctx: CommandContext): string {
  const subscriptions = requireSubscriptionManager(ctx).list();
  const available = listAvailableSubscriptionProviders(requireServiceRegistry(ctx).getAll());
  if (subscriptions.length === 0) {
    return [
      'Subscription Review',
      '  No provider subscriptions stored yet.',
      ...(available.length > 0 ? [`  available providers: ${available.map((entry) => entry.provider).join(', ')}`] : []),
    ].join('\n');
  }
  return [
    `Subscription Review`,
    ...subscriptions.map((subscription) => (
      `  ${subscription.provider}  ${subscription.authMode}  token=${subscription.tokenType}  expires=${subscription.expiresAt ? new Date(subscription.expiresAt).toISOString() : 'n/a'}`
    )),
  ].join('\n');
}

function inspectBundle(path: string): string {
  const bundle = JSON.parse(readFileSync(path, 'utf-8')) as SubscriptionBundle;
  return [
    'Subscription Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  subscriptions: ${bundle.subscriptions.length}`,
    ...bundle.subscriptions.map((subscription) => `  ${subscription.provider}  ${subscription.authMode}`),
  ].join('\n');
}

function extractAuthorizationCode(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.searchParams.get('code');
  } catch {
    return null;
  }
}

function resolveLoginConfig(config: OAuthProviderConfig, useLocalCallback: boolean): OAuthProviderConfig {
  if (!useLocalCallback || !config.localCallback) {
    return config.manualRedirectUri
      ? { ...config, redirectUri: config.manualRedirectUri }
      : config;
  }
  return config;
}

function describePrecedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
  return record.overrideAmbientApiKeys
    ? '  precedence: this now overrides ambient API keys for the provider'
    : '  precedence: stored for subscription-backed flows only; ambient API keys are unchanged';
}

export function registerSubscriptionRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'subscription',
    aliases: ['subs'],
    description: 'Manage provider subscription sessions and, when supported, let them override ambient API keys for matching providers',
    usage: '[review|list|providers|inspect <provider>|login <provider> start [--no-browser] [--manual]|finish <code-or-url>|logout <provider>|bundle export <path>|bundle inspect <path>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      if (args.length === 0 && ctx.openSubscriptionPanel) {
        ctx.openSubscriptionPanel();
        return;
      }
      const sub = (args[0] ?? 'review').toLowerCase();
      const manager = requireSubscriptionManager(ctx);
      const services = requireServiceRegistry(ctx);

      if (sub === 'review' || sub === 'list') {
        ctx.print(buildReviewText(ctx));
        return;
      }

      if (sub === 'providers') {
        const available = listAvailableSubscriptionProviders(services.getAll());
        if (available.length === 0) {
          ctx.print('No subscription-capable providers are currently configured or built in.');
          return;
        }
        ctx.print([
          'Available Subscription Providers',
          ...available.map((provider) => (
            `  ${provider.provider}  source=${provider.source}  redirect=${provider.oauth.redirectUri}`
          )),
        ].join('\n'));
        return;
      }

      if (sub === 'inspect') {
        const provider = args[1];
        if (!provider) {
          ctx.print('Usage: /subscription inspect <provider>');
          return;
        }
        const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
        if (!resolved && !manager.get(provider) && !manager.getPending(provider)) {
          ctx.print(`No stored or available subscription provider named ${provider}.`);
          return;
        }
        const inspection = await inspectProviderAuth(provider, {
          serviceRegistry: services,
          subscriptionManager: manager,
          secretsManager: requireSecretsManager(ctx),
        });
        ctx.print([
          `Subscription ${provider}`,
          `  configured: ${inspection.configured ? 'yes' : 'no'}`,
          `  freshness: ${inspection.freshness}`,
          `  callbackMode: ${inspection.callbackMode}`,
          ...(resolved ? [
            `  source: ${resolved.source}`,
            `  redirectUri: ${resolved.oauth.redirectUri}`,
            `  authUrl: ${resolved.oauth.authUrl}`,
            `  tokenUrl: ${resolved.oauth.tokenUrl}`,
            ...(inspection.localCallback ? [`  localCallback: ${inspection.localCallback}`] : []),
          ] : []),
          ...(inspection.activeSubscription ? [
            `  authMode: ${manager.get(provider)?.authMode ?? 'oauth'}`,
            `  tokenType: ${inspection.tokenType ?? 'n/a'}`,
            `  createdAt: ${manager.get(provider)?.createdAt ? new Date(manager.get(provider)!.createdAt).toISOString() : 'n/a'}`,
            `  updatedAt: ${manager.get(provider)?.updatedAt ? new Date(manager.get(provider)!.updatedAt).toISOString() : 'n/a'}`,
            `  expiresAt: ${inspection.expiresAt ? new Date(inspection.expiresAt).toISOString() : 'n/a'}`,
            `  refreshToken: ${manager.get(provider)?.refreshToken ? 'present' : 'absent'}`,
            describePrecedence(manager.get(provider)!),
          ] : [
            `  state: ${inspection.freshness === 'pending' ? 'pending login' : 'available for login'}`,
          ]),
          ...inspection.issues.map((issue) => `  issue: ${issue}`),
          ...inspection.nextActions.map((action) => `  next: ${action}`),
        ].join('\n'));
        return;
      }

      if (sub === 'login') {
        const provider = args[1];
        const mode = args[2]?.toLowerCase();
        if (!provider || !mode) {
          ctx.print('Usage: /subscription login <provider> start|finish <code>');
          return;
        }
        const service = services.get(provider);
        const resolved = getSubscriptionProviderConfig(provider, service);
        if (!resolved) {
          ctx.print([
            `OAuth is not configured for ${provider}.`,
            'Add an oauth block to .goodvibes/tui/services.json for that provider, for example:',
            `  { "name": "${provider}", "authType": "oauth", "tokenKey": "${provider.toUpperCase()}_API_KEY", "providerId": "${provider}", "oauth": { "authUrl": "...", "tokenUrl": "...", "clientId": "...", "redirectUri": "http://127.0.0.1/callback", "scopes": ["..."] } }`,
          ].join('\n'));
          return;
        }
        if (mode === 'start') {
          const flags = new Set(args.slice(3));
          const openBrowser = !flags.has('--no-browser');
          const useManualMode = flags.has('--manual');
          if (provider === 'openai' && resolved.source === 'builtin') {
            const started = beginOpenAICodexLogin();
            manager.savePending({
              provider,
              state: started.state,
              verifier: started.verifier,
              redirectUri: started.redirectUri,
              createdAt: Date.now(),
            });

            let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
            if (!useManualMode) {
              try {
                listener = await createOAuthLocalListener({
                  expectedState: started.state,
                  host: '127.0.0.1',
                  port: 1455,
                  path: '/auth/callback',
                }).catch(() => null);
              } catch {
                listener = null;
              }
            }

            const browserOpened = openBrowser
              ? await openExternalUrl(started.authorizationUrl)
              : false;

            if (listener && browserOpened) {
              try {
                const callback = await listener.waitForCode();
                const token = await exchangeOpenAICodexCode(callback.code, started.verifier);
                const now = Date.now();
                const record = manager.saveSubscription({
                  provider,
                  accessToken: token.accessToken,
                  refreshToken: token.refreshToken,
                  tokenType: token.tokenType,
                  expiresAt: token.expiresAt,
                  ...(token.scopes ? { scopes: token.scopes } : {}),
                  authMode: 'oauth',
                  overrideAmbientApiKeys: false,
                  createdAt: manager.get(provider)?.createdAt ?? now,
                  updatedAt: now,
                });
                ctx.print([
                  `Subscription OAuth Start: ${provider}`,
                  `  source: ${resolved.source}`,
                  `  state: ${started.state}`,
                  `  redirectUri: ${started.redirectUri}`,
                  `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                  '  authorizationUrl:',
                  `  ${started.authorizationUrl}`,
                  `Subscription OAuth Complete: ${provider}`,
                  `  tokenType: ${record.tokenType}`,
                  `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                  describePrecedence(record),
                ].join('\n'));
                return;
              } catch (error) {
                listener.close();
                ctx.print([
                  `Subscription OAuth Start: ${provider}`,
                  `  source: ${resolved.source}`,
                  `  state: ${started.state}`,
                  `  redirectUri: ${started.redirectUri}`,
                  `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                  `  next: /subscription login ${provider} finish <code-or-url>`,
                  `  listener: ${summarizeError(error)}`,
                  '  authorizationUrl:',
                  `  ${started.authorizationUrl}`,
                ].join('\n'));
                return;
              }
            }

            listener?.close();
            ctx.print([
              `Subscription OAuth Start: ${provider}`,
              `  source: ${resolved.source}`,
              `  state: ${started.state}`,
              `  redirectUri: ${started.redirectUri}`,
              `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
              `  next: /subscription login ${provider} finish <code-or-url>`,
              '  authorizationUrl:',
              `  ${started.authorizationUrl}`,
            ].join('\n'));
            return;
          }
          const useLocalCallback = Boolean(resolved.oauth.localCallback) && !flags.has('--manual');
          let activeConfig = resolveLoginConfig(resolved.oauth, useLocalCallback);
          let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;

          if (useLocalCallback && resolved.oauth.localCallback) {
            listener = await createOAuthLocalListener({
              expectedState: '',
              host: resolved.oauth.localCallback.host,
              port: resolved.oauth.localCallback.port,
              path: resolved.oauth.localCallback.path,
            }).catch(() => null);
          }

          if (listener) {
            activeConfig = { ...activeConfig, redirectUri: listener.redirectUri };
          }

          const started = manager.beginOAuthLogin(provider, activeConfig);
          if (listener) {
            listener.setExpectedState(started.pending.state);
          }

          const browserOpened = openBrowser
              ? await openExternalUrl(started.authorizationUrl)
              : false;

          const shouldAutoComplete = Boolean(listener) && (resolved.oauth.localCallback?.autoComplete ?? true) && browserOpened;

          if (shouldAutoComplete && listener) {
            try {
              const callback = await listener.waitForCode();
              const record = await manager.completeOAuthLogin(provider, activeConfig, callback.code);
              ctx.print([
                `Subscription OAuth Start: ${provider}`,
                `  source: ${resolved.source}`,
                `  state: ${started.pending.state}`,
                `  redirectUri: ${activeConfig.redirectUri}`,
                `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                '  authorizationUrl:',
                `  ${started.authorizationUrl}`,
                `Subscription OAuth Complete: ${provider}`,
                `  tokenType: ${record.tokenType}`,
                `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                describePrecedence(record),
              ].join('\n'));
              return;
            } catch (error) {
              listener.close();
              ctx.print([
                `Subscription OAuth Start: ${provider}`,
                `  source: ${resolved.source}`,
                `  state: ${started.pending.state}`,
                `  redirectUri: ${activeConfig.redirectUri}`,
                `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                `  next: /subscription login ${provider} finish <code-or-url>`,
                `  listener: ${summarizeError(error)}`,
                '  authorizationUrl:',
                `  ${started.authorizationUrl}`,
              ].join('\n'));
              return;
            }
          }

          listener?.close();

          ctx.print([
            `Subscription OAuth Start: ${provider}`,
            `  source: ${resolved.source}`,
            `  state: ${started.pending.state}`,
            `  redirectUri: ${activeConfig.redirectUri}`,
            `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
            `  next: /subscription login ${provider} finish <code-or-url>`,
            '  authorizationUrl:',
            `  ${started.authorizationUrl}`,
          ].join('\n'));
          return;
        }
        if (mode === 'finish') {
          const codeInput = args[3];
          if (!codeInput) {
            ctx.print(`Usage: /subscription login ${provider} finish <code-or-url>`);
            return;
          }
          const code = extractAuthorizationCode(codeInput) ?? codeInput;
          if (provider === 'openai' && resolved.source === 'builtin') {
            const pending = manager.getPending(provider);
            if (!pending) {
              ctx.print(`No pending OAuth login for ${provider}. Start with /subscription login ${provider} start.`);
              return;
            }
            const token = await exchangeOpenAICodexCode(code, pending.verifier);
            const now = Date.now();
            const record = manager.saveSubscription({
              provider,
              accessToken: token.accessToken,
              refreshToken: token.refreshToken,
              tokenType: token.tokenType,
              expiresAt: token.expiresAt,
              ...(token.scopes ? { scopes: token.scopes } : {}),
              authMode: 'oauth',
              overrideAmbientApiKeys: false,
              createdAt: manager.get(provider)?.createdAt ?? now,
              updatedAt: now,
            });
            ctx.print([
              `Stored subscription session for ${provider}.`,
              `  tokenType: ${record.tokenType}`,
              `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
              describePrecedence(record),
            ].join('\n'));
            return;
          }
          const activeConfig = resolveLoginConfig(resolved.oauth, false);
          const record = await manager.completeOAuthLogin(provider, activeConfig, code);
          ctx.print([
            `Stored subscription session for ${provider}.`,
            `  tokenType: ${record.tokenType}`,
            `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
            describePrecedence(record),
          ].join('\n'));
          return;
        }
        ctx.print('Usage: /subscription login <provider> start|finish <code-or-url>');
        return;
      }

      if (sub === 'logout') {
        const provider = args[1];
        if (!provider) {
          ctx.print('Usage: /subscription logout <provider>');
          return;
        }
        const removed = manager.logout(provider);
        ctx.print(removed
          ? `Logged out of ${provider}. Ambient API key resolution will apply again if configured.`
          : `No stored subscription session existed for ${provider}.`);
        return;
      }

      if (sub === 'bundle') {
        const mode = args[1]?.toLowerCase();
        const pathArg = args[2];
        if (!mode || !pathArg) {
          ctx.print('Usage: /subscription bundle <export|inspect> <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        if (mode === 'export') {
          const bundle: SubscriptionBundle = {
            version: 1,
            exportedAt: Date.now(),
            subscriptions: manager.list(),
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Subscription bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          ctx.print(inspectBundle(targetPath));
          return;
        }
        ctx.print('Usage: /subscription bundle <export|inspect> <path>');
        return;
      }

      ctx.print('Usage: /subscription [review|list|providers|inspect <provider>|login <provider> start [--no-browser] [--manual]|finish <code-or-url>|logout <provider>|bundle export <path>|bundle inspect <path>]');
    },
  });
}
