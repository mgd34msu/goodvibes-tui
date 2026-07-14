import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SecretsManager } from '../config/secrets.ts';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@pellux/goodvibes-sdk/platform/config';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config';
import { inspectProviderAuth } from '@/runtime/index.ts';
import { generateQrMatrix, renderQrToString, PAIRING_HANDOFF_OFFER_KINDS, type PairingHandoffOfferKind } from '@pellux/goodvibes-sdk/platform/pairing';
import { ensurePublicBaseUrl } from '../core/pairing-origin.ts';
import { formatPairingOffers, PAIRING_HTTP_LAN_POSTURE } from '../core/pairing-offers.ts';
import { defaultPairingTokenName } from '../core/pairing-handoff.ts';
import { stableUrlHostForBindHost } from '../core/stable-host.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import { classifyBindPosture, isNetworkFacing } from './network-posture.ts';
import type { CliCommandRuntime } from './types.ts';
import { extractAuthorizationCode, formatJsonOrText, hasCommandFlag, openBrowser, probeTcp, readAuthPaths, readOptionValue, runNonInteractiveAgent, withRuntimeServices, yesNo } from './management-utils.ts';

export async function renderSubscriptions(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const subscriptions = services.subscriptionManager.list();
    const pending = services.subscriptionManager.listPending();
    const available = listAvailableSubscriptionProviders(services.serviceRegistry.getAll());
    if (sub === 'providers') {
      return formatJsonOrText(runtime.cli)(available, [
        'GoodVibes subscription providers',
        ...available.map((provider) => `  ${provider.provider} source=${provider.source} redirect=${provider.oauth.redirectUri}`),
      ].join('\n'));
    }
    if (sub === 'inspect' || sub === 'show') {
      const provider = rest[0];
      if (!provider) return 'Usage: goodvibes subscription inspect <provider>';
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved && !services.subscriptionManager.get(provider) && !services.subscriptionManager.getPending(provider)) {
        return `No stored or available subscription provider named ${provider}.`;
      }
      const inspection = await inspectProviderAuth(provider, {
        serviceRegistry: services.serviceRegistry,
        subscriptionManager: services.subscriptionManager,
        secretsManager: services.secretsManager,
      });
      const stored = services.subscriptionManager.get(provider);
      return formatJsonOrText(runtime.cli)({ provider, resolved, inspection, stored }, [
        `GoodVibes subscription ${provider}`,
        `  configured: ${yesNo(inspection.configured)}`,
        `  freshness: ${inspection.freshness}`,
        `  callbackMode: ${inspection.callbackMode}`,
        ...(resolved ? [
          `  source: ${resolved.source}`,
          `  redirectUri: ${resolved.oauth.redirectUri}`,
        ] : []),
        ...(stored ? [
          `  tokenType: ${stored.tokenType}`,
          `  expiresAt: ${stored.expiresAt ? new Date(stored.expiresAt).toISOString() : 'n/a'}`,
          `  refreshToken: ${stored.refreshToken ? 'present' : 'absent'}`,
          `  overrideAmbient: ${yesNo(stored.overrideAmbientApiKeys)}`,
        ] : ['  stored: no']),
        ...inspection.issues.map((issue) => `  issue: ${issue}`),
        ...inspection.nextActions.map((action) => `  next: ${action}`),
      ].join('\n'));
    }
    if (sub === 'login' || sub === 'start') {
      const provider = sub === 'start' ? rest[0] : rest[0];
      const mode = sub === 'start' ? 'start' : rest[1]?.toLowerCase();
      if (!provider || mode !== 'start') return 'Usage: goodvibes subscription login <provider> start [--open]';
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved) return `No subscription provider found: ${provider}`;
      if (provider === 'openai' && resolved.source === 'builtin') {
        const started = await beginOpenAICodexLogin();
        services.subscriptionManager.savePending({
          provider,
          state: started.state,
          verifier: started.verifier,
          redirectUri: started.redirectUri,
          createdAt: Date.now(),
        });
        const openResult = runtime.cli.flags.open || hasCommandFlag(rest, '--open') ? openBrowser(started.authorizationUrl) : null;
        return [
          `Subscription OAuth started: ${provider}`,
          `  source: ${resolved.source}`,
          `  state: ${started.state}`,
          `  redirectUri: ${started.redirectUri}`,
          ...(openResult ? [`  open: ${openResult}`] : []),
          `  next: goodvibes subscription login ${provider} finish <code-or-url>`,
          '  authorizationUrl:',
          `  ${started.authorizationUrl}`,
        ].join('\n');
      }
      const started = await services.subscriptionManager.beginOAuthLogin(provider, resolved.oauth);
      const openResult = runtime.cli.flags.open || hasCommandFlag(rest, '--open') ? openBrowser(started.authorizationUrl) : null;
      return [
        `Subscription OAuth started: ${provider}`,
        `  source: ${resolved.source}`,
        `  state: ${started.pending.state}`,
        `  redirectUri: ${started.pending.redirectUri}`,
        ...(openResult ? [`  open: ${openResult}`] : []),
        `  next: goodvibes subscription login ${provider} finish <code-or-url>`,
        '  authorizationUrl:',
        `  ${started.authorizationUrl}`,
      ].join('\n');
    }
    if (sub === 'finish' || (sub === 'login' && rest[1]?.toLowerCase() === 'finish')) {
      const provider = sub === 'finish' ? rest[0] : rest[0];
      const codeInput = sub === 'finish' ? rest[1] : rest[2];
      if (!provider || !codeInput) return 'Usage: goodvibes subscription login <provider> finish <code-or-url>';
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved) return `No subscription provider found: ${provider}`;
      const code = extractAuthorizationCode(codeInput);
      if (provider === 'openai' && resolved.source === 'builtin') {
        const pendingLogin = services.subscriptionManager.getPending(provider);
        if (!pendingLogin) return `No pending OAuth login for ${provider}.`;
        const token = await exchangeOpenAICodexCode(code, pendingLogin.verifier);
        const now = Date.now();
        const record = services.subscriptionManager.saveSubscription({
          provider,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          tokenType: token.tokenType,
          expiresAt: token.expiresAt,
          ...(token.scopes ? { scopes: token.scopes } : {}),
          authMode: 'oauth',
          overrideAmbientApiKeys: false,
          createdAt: services.subscriptionManager.get(provider)?.createdAt ?? now,
          updatedAt: now,
        });
        return `Subscription stored: ${provider} token=${record.tokenType} expires=${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`;
      }
      const record = await services.subscriptionManager.completeOAuthLogin(provider, resolved.oauth, code);
      return `Subscription stored: ${provider} token=${record.tokenType} expires=${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`;
    }
    if (sub === 'refresh') {
      const provider = rest[0];
      if (!provider) return 'Usage: goodvibes subscription refresh <provider>';
      const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
      if (!resolved) return `No subscription provider found: ${provider}`;
      const record = await services.subscriptionManager.refreshOAuthToken(provider, resolved.oauth);
      return `Subscription refreshed: ${provider} expires=${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`;
    }
    if (sub === 'logout' || sub === 'remove') {
      const provider = rest[0];
      if (!provider) return 'Usage: goodvibes subscription logout <provider>';
      const removed = services.subscriptionManager.logout(provider);
      return removed ? `Subscription removed: ${provider}` : `No stored subscription session existed for ${provider}.`;
    }
    if (sub !== 'list' && sub !== 'status' && sub !== 'review') {
      return 'Usage: goodvibes subscription [list|providers|inspect <provider>|login <provider> start|finish <code-or-url>|refresh <provider>|logout <provider>]';
    }
    const value = {
      subscriptions: subscriptions.map((sub) => ({
        provider: sub.provider,
        tokenType: sub.tokenType,
        expiresAt: sub.expiresAt ?? null,
        overrideAmbientApiKeys: sub.overrideAmbientApiKeys,
      })),
      pending: pending.map((sub) => ({ provider: sub.provider, createdAt: sub.createdAt })),
    };
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes subscriptions',
      subscriptions.length === 0 ? '  active: none' : '  active:',
      ...subscriptions.map((sub) => `    ${sub.provider} token=${sub.tokenType} expires=${sub.expiresAt ? new Date(sub.expiresAt).toISOString() : 'n/a'} overrideAmbient=${yesNo(sub.overrideAmbientApiKeys)}`),
      pending.length === 0 ? '  pending: none' : '  pending:',
      ...pending.map((sub) => `    ${sub.provider} created=${new Date(sub.createdAt).toISOString()}`),
    ].join('\n'));
  });
}

export async function handleSecrets(runtime: CliCommandRuntime): Promise<string> {
  const secrets = new SecretsManager({
    projectRoot: runtime.workingDirectory,
    globalHome: runtime.homeDirectory,
    configManager: runtime.configManager,
  });
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  if (sub === 'providers') {
    const value = { providers: BUILTIN_SECRET_PROVIDER_SOURCES };
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes secret providers',
      ...BUILTIN_SECRET_PROVIDER_SOURCES.map((provider) => `  ${provider}`),
      '',
      'Secret refs use goodvibes://secrets/<source>/... and never embed secret values.',
    ].join('\n'));
  }
  if (sub === 'test') {
    const ref = rest.join(' ').trim();
    if (!ref || !ref.startsWith('goodvibes://secrets/') || !isSecretRefInput(ref)) {
      return 'Usage: goodvibes secrets test goodvibes://secrets/<source>/...';
    }
    const resolved = await resolveSecretRef(ref, { resolveLocalSecret: (key) => secrets.get(key) });
    const value = { ref: describeSecretRef(ref), resolved: Boolean(resolved.value) };
    return formatJsonOrText(runtime.cli)(value, `[secrets] ${value.ref}: ${value.resolved ? 'resolved <redacted>' : 'missing'}`);
  }
  if (sub === 'set' || sub === 'link') {
    const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
    const values = rest.filter((arg) => !arg.startsWith('--'));
    const [key, ...rawValueParts] = values;
    const value = rawValueParts.join(' ');
    if (!key || !value) return `Usage: goodvibes secrets ${sub} <KEY> <value> [--user|--project] [--secure|--plaintext]`;
    if (sub === 'link' && (!value.startsWith('goodvibes://secrets/') || !isSecretRefInput(value))) {
      return 'Invalid secret reference. Use goodvibes://secrets/<source>/...';
    }
    await secrets.set(key, value, {
      scope: flags.has('--user') ? 'user' : 'project',
      medium: flags.has('--plaintext') ? 'plaintext' : 'secure',
    });
    return `[secrets] ${sub === 'link' ? 'Linked' : 'Stored'}: ${key}`;
  }
  if (sub === 'delete') {
    const key = rest.find((arg) => !arg.startsWith('--'));
    if (!key) return 'Usage: goodvibes secrets delete <KEY> [--user|--project] [--secure|--plaintext]';
    const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
    await secrets.delete(key, {
      scope: flags.has('--user') ? 'user' : flags.has('--project') ? 'project' : undefined,
      medium: flags.has('--secure') ? 'secure' : flags.has('--plaintext') ? 'plaintext' : undefined,
    });
    return `[secrets] Deleted: ${key}`;
  }
  const [records, review] = await Promise.all([secrets.listDetailed(), secrets.inspect()]);
  const stored = records.filter((record) => record.source !== 'env');
  const value = { policy: review.policy, records: stored, warnings: review.warnings };
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes secrets',
    `  policy: ${review.policy}`,
    `  secure available: ${yesNo(review.secureAvailable)}`,
    `  stored keys: ${stored.length}`,
    ...stored.map((record) => `    ${record.key} (${record.source}${record.refSource ? `, ref:${record.refSource}` : ''}${record.overriddenByEnv ? ', env override' : ''})`),
    ...review.warnings.map((warning) => `  warning: ${warning}`),
  ].join('\n'));
}

export async function handleSessions(runtime: CliCommandRuntime): Promise<string | null> {
  return await withRuntimeServices(runtime, (services) => {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const sessions = services.sessionManager.list();
    if (sub === 'list') {
      const value = sessions;
      return formatJsonOrText(runtime.cli)(value, [
        `GoodVibes sessions (${sessions.length})`,
        ...sessions.slice(0, 50).map((session) => `  ${session.name}  messages=${session.messageCount}  ${new Date(session.timestamp).toISOString()}  ${session.title || '(untitled)'}`),
      ].join('\n'));
    }
    if (sub === 'show' || sub === 'info') {
      const target = rest.join(' ').trim();
      if (!target) return 'Usage: goodvibes sessions show <id|name>';
      const found = sessions.find((session) => session.name === target || session.name.startsWith(target) || session.title.toLowerCase() === target.toLowerCase());
      if (!found) return `Session not found: ${target}`;
      return formatJsonOrText(runtime.cli)(found, [
        `Session ${found.name}`,
        `  title: ${found.title || '(untitled)'}`,
        `  messages: ${found.messageCount}`,
        `  provider/model: ${found.provider}/${found.model}`,
        `  updated: ${new Date(found.timestamp).toISOString()}`,
        `  file: ${found.filePath}`,
      ].join('\n'));
    }
    if (sub === 'export') {
      const target = rest[0];
      const outputPath = rest[1];
      if (!target) return 'Usage: goodvibes sessions export <id|name> [path]';
      const found = sessions.find((session) => session.name === target || session.name.startsWith(target) || session.title.toLowerCase() === target.toLowerCase());
      if (!found) return `Session not found: ${target}`;
      const data = services.sessionManager.load(found.name);
      const text = JSON.stringify({ name: found.name, ...data }, null, 2) + '\n';
      if (outputPath) {
        const targetPath = services.shellPaths.resolveWorkspacePath(outputPath);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, text, 'utf-8');
        return `Session exported: ${targetPath}`;
      }
      return text.trimEnd();
    }
    if (sub === 'resume') {
      const target = rest.join(' ').trim();
      return target ? null : 'Usage: goodvibes sessions resume <id|name>';
    }
    return 'Usage: goodvibes sessions list|show <id>|export <id> [path]|resume <id>';
  });
}

export async function handleTasks(runtime: CliCommandRuntime): Promise<string> {
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  if (sub === 'submit') {
    const prompt = rest.join(' ').trim();
    if (!prompt) return 'Usage: goodvibes tasks submit <prompt>';
    const runCli = {
      ...runtime.cli,
      command: 'run' as const,
      flags: { ...runtime.cli.flags, prompt },
      positionals: [prompt],
    };
    const code = await runNonInteractiveAgent({ ...runtime, cli: runCli });
    return code === 0 ? '' : `Task submit failed with exit code ${code}`;
  }
  return await withRuntimeServices(runtime, (services) => {
    const tasks = [...services.runtimeStore.getState().tasks.tasks.values()];
    if (sub === 'list') {
      return tasks.length === 0
        ? 'GoodVibes tasks\n  No in-process runtime tasks are currently recorded.'
        : ['GoodVibes tasks', ...tasks.map((task) => `  ${task.id} ${task.status} ${task.kind} ${task.title}`)].join('\n');
    }
    if (sub === 'show') {
      if (!rest[0]) return 'Usage: goodvibes tasks show <taskId>';
      const task = tasks.find((candidate) => candidate.id === rest[0]);
      return task ? JSON.stringify(task, null, 2) : `Unknown task: ${rest[0] ?? ''}`;
    }
    return 'Usage: goodvibes tasks list|show <taskId>|submit <prompt>';
  });
}

export interface ControlPlaneStatusResult {
  readonly enabled: unknown;
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  readonly posture: ReturnType<typeof classifyBindPosture>;
  readonly reachable: boolean;
  readonly auth: ReturnType<typeof readAuthPaths>;
  readonly service: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
  };
  readonly issues: readonly string[];
}

export async function buildControlPlaneStatusResult(runtime: CliCommandRuntime): Promise<ControlPlaneStatusResult> {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const enabled = runtime.configManager.get('controlPlane.enabled');
  const reachable = enabled === true ? await probeTcp(binding.host, binding.port) : false;
  const auth = readAuthPaths(runtime);
  const service = {
    enabled: runtime.configManager.get('service.enabled'),
    autostart: runtime.configManager.get('service.autostart'),
    restartOnFailure: runtime.configManager.get('service.restartOnFailure'),
  };
  const issues: string[] = [];
  if (enabled === true && !reachable) issues.push(`Control plane is enabled but not reachable on ${binding.host}:${binding.port}.`);
  if (enabled === true && service.enabled !== true) issues.push('Control plane is enabled but service mode is off.');
  if (enabled === true && service.autostart !== true) issues.push('Control plane is enabled but service autostart is off.');
  if (enabled === true && service.restartOnFailure !== true) issues.push('Control plane is enabled but service restart-on-failure is off.');
  if (isNetworkFacing(enabled, binding) && !auth.userStorePresent) issues.push('Network-facing control plane has no local auth user store.');
  if (isNetworkFacing(enabled, binding) && auth.bootstrapCredentialPresent) issues.push('Network-facing control plane still has a bootstrap credential file.');
  return {
    enabled,
    ...binding,
    posture: classifyBindPosture(binding),
    reachable,
    auth,
    service,
    issues,
  };
}

export function formatControlPlaneStatus(runtime: CliCommandRuntime, value: ControlPlaneStatusResult): string {
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes control-plane status',
    `  enabled: ${yesNo(value.enabled)}`,
    `  bind: ${value.hostMode} ${value.host}:${value.port}`,
    `  bind posture: ${value.posture.label}`,
    `  reachable: ${yesNo(value.reachable)}`,
    `  service: enabled=${yesNo(value.service.enabled)} autostart=${yesNo(value.service.autostart)} restartOnFailure=${yesNo(value.service.restartOnFailure)}`,
    `  local auth users: ${value.auth.userStorePresent ? 'present' : 'missing'}`,
    `  bootstrap credential: ${value.auth.bootstrapCredentialPresent ? 'present' : 'missing'}`,
    `  operator tokens: ${value.auth.operatorTokenPresent ? 'present' : 'missing'}`,
    value.issues.length === 0 ? '  readiness: ready' : '  readiness: needs attention',
    ...value.issues.map((issue) => `    - ${issue}`),
  ].join('\n'));
}

export async function renderControlPlaneStatus(runtime: CliCommandRuntime): Promise<string> {
  return formatControlPlaneStatus(runtime, await buildControlPlaneStatusResult(runtime));
}

interface PairingHandoffCreateResult {
  readonly token: { readonly id: string; readonly name: string; readonly token: string };
  readonly offers: readonly { readonly kind: PairingHandoffOfferKind }[];
  readonly fragment: string;
  readonly deepLink?: string | undefined;
}

export async function renderPairing(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    // Freeze a stable web origin once (never clobbering a user-set value) so the
    // printed link and the daemon's own handoff origin agree and survive a DHCP
    // lease change where a stable name exists.
    const webOrigin = ensurePublicBaseUrl(runtime.configManager);
    const name = readOptionValue(runtime.cli.commandArgs, 'name') ?? defaultPairingTokenName();
    // Mint through the canonical hand-off verb: it mints a fresh per-device token
    // and returns the exact `#pair=<token>` deep link the web app consumes. The
    // daemon filters the requested offer set down to what it can actually satisfy.
    const result = (await services.gatewayMethods.invoke('pairing.handoff.create', {
      body: { name, offers: [...PAIRING_HANDOFF_OFFER_KINDS] },
      context: { principalId: 'admin', principalKind: 'user', admin: true },
    })) as PairingHandoffCreateResult;
    const link = result.deepLink ?? result.fragment;
    const qr = renderQrToString(generateQrMatrix(link));
    const lines: string[] = [
      'Scan to pair a device — the QR opens the web app already signed in:',
      '',
      `  ${link}`,
      `  Token name: ${result.token.name}  (rename or revoke later in /settings → security → devices)`,
    ];
    if (result.offers.length > 0) {
      lines.push('', 'Offers carried in this pairing (each declinable in the web app):', ...formatPairingOffers(result.offers.map((o) => o.kind)));
    }
    if (webOrigin.httpOnLan) lines.push('', PAIRING_HTTP_LAN_POSTURE);
    lines.push('', qr);
    return lines.join('\n');
  });
}

export async function renderRemote(runtime: CliCommandRuntime, label: 'remote' | 'bridge'): Promise<string> {
  return await withRuntimeServices(runtime, (services) => {
    const pools = services.remoteRunnerRegistry.listPools?.() ?? [];
    const contracts = services.remoteRunnerRegistry.listContracts();
    const artifacts = services.remoteRunnerRegistry.listArtifacts();
    const value = {
      pools: pools.length,
      contracts: contracts.length,
      artifacts: artifacts.length,
      remoteFetchPrivateHosts: runtime.configManager.get('network.remoteFetch.allowPrivateHosts'),
    };
    return formatJsonOrText(runtime.cli)(value, [
      `GoodVibes ${label} status`,
      `  runner pools: ${value.pools}`,
      `  contracts: ${value.contracts}`,
      `  review artifacts: ${value.artifacts}`,
      `  private-host remote fetch: ${yesNo(value.remoteFetchPrivateHosts)}`,
    ].join('\n'));
  });
}

export function renderWeb(runtime: CliCommandRuntime): string {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'web');
  const publicBaseUrl = String(runtime.configManager.get('web.publicBaseUrl') ?? '');
  const hasEndpointOverride = runtime.cli.flags.hostname !== undefined || runtime.cli.flags.port !== undefined;
  // Prefer the stable-name resolution over the raw first-non-internal IPv4 so the
  // printed URL survives a DHCP lease change where a stable name exists.
  const url = !hasEndpointOverride && publicBaseUrl
    ? publicBaseUrl
    : `http://${stableUrlHostForBindHost(binding.host).host}:${binding.port}`;
  const value = {
    enabled: runtime.configManager.get('web.enabled'),
    ...binding,
    url,
  };
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes web',
    `  enabled: ${yesNo(value.enabled)}`,
    `  bind: ${value.hostMode} ${value.host}:${value.port}`,
    `  url: ${value.url}`,
    ...(runtime.cli.flags.open ? [`  open: ${openBrowser(value.url)}`] : []),
  ].join('\n'));
}
