import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigKey, GoodVibesConfig } from '../config/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { SecretsManager } from '../config/secrets.ts';
import { createShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@pellux/goodvibes-sdk/platform/config/secret-refs';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config/subscription-providers';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config/openai-codex-auth';
import { inspectProviderAuth } from '@pellux/goodvibes-sdk/platform/runtime/auth/inspection';
import { getOrCreateCompanionToken, buildCompanionConnectionInfo, encodeConnectionPayload, formatConnectionBlock } from '@pellux/goodvibes-sdk/platform/pairing/index';
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing/qr-generator';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { CliCommandRuntime } from './management.ts';
import { applyTargetEndpointFlagsOrDefault, enableEndpointLanDefault, enableServicePosture, extractAuthorizationCode, formatJsonOrText, getNestedValue, hasCommandFlag, isPresentConfigValue, openBrowser, probeTcp, readAuthPaths, runNonInteractiveAgent, SURFACE_CONFIGS, urlHostForBindHost, withRuntimeServices, yesNo } from './management.ts';

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

export async function handleSurfaces(runtime: CliCommandRuntime): Promise<string> {
  const config = runtime.configManager;
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  const target = rest[0];
  if (sub === 'enable' || sub === 'disable') {
    if (!target) return `Usage: goodvibes surfaces ${sub} <web|listener|control-plane|surfaceId>`;
    const enabled = sub === 'enable';
    if (target === 'web') {
      runtime.configManager.setDynamic('web.enabled', enabled);
      if (enabled) {
        runtime.configManager.setDynamic('danger.daemon', true);
        runtime.configManager.setDynamic('controlPlane.enabled', true);
        const webError = applyTargetEndpointFlagsOrDefault(runtime, 'web');
        if (webError) return webError;
        const webBinding = resolveRuntimeEndpointBinding(runtime.configManager, 'web');
        if (runtime.cli.flags.hostname !== undefined && webBinding.hostMode === 'local') {
          runtime.configManager.setDynamic('controlPlane.hostMode', 'local');
          runtime.configManager.setDynamic('controlPlane.host', '127.0.0.1');
          runtime.configManager.setDynamic('controlPlane.allowRemote', false);
        } else {
          enableEndpointLanDefault(runtime.configManager, 'controlPlane');
        }
      }
    }
    else if (target === 'listener' || target === 'http-listener') {
      runtime.configManager.setDynamic('danger.httpListener', enabled);
      if (enabled) {
        const listenerError = applyTargetEndpointFlagsOrDefault(runtime, 'httpListener');
        if (listenerError) return listenerError;
      }
    }
    else if (target === 'control-plane' || target === 'controlPlane') {
      runtime.configManager.setDynamic('controlPlane.enabled', enabled);
      runtime.configManager.setDynamic('danger.daemon', enabled);
      if (enabled) {
        const controlPlaneError = applyTargetEndpointFlagsOrDefault(runtime, 'controlPlane');
        if (controlPlaneError) return controlPlaneError;
      }
    }
    else if (SURFACE_CONFIGS.some(([id]) => id === target)) {
      runtime.configManager.setDynamic(`surfaces.${target}.enabled` as ConfigKey, enabled);
      if (enabled) {
        runtime.configManager.setDynamic('danger.httpListener', true);
        enableEndpointLanDefault(runtime.configManager, 'httpListener');
      }
    }
    else return `Unknown surface: ${target}`;
    if (enabled) {
      enableServicePosture(runtime.configManager);
    }
    return `Surface ${enabled ? 'enabled' : 'disabled'}: ${target}`;
  }
  if (sub !== 'list' && sub !== 'status' && sub !== 'check' && sub !== 'show') {
    return 'Usage: goodvibes surfaces [list|check|show <surfaceId>|enable <surfaceId>|disable <surfaceId>]';
  }
  const controlPlane = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const web = resolveRuntimeEndpointBinding(config, 'web');
  const httpListener = resolveRuntimeEndpointBinding(config, 'httpListener');
  const includeProbe = sub === 'check';
  const [controlPlaneReachable, webReachable, listenerReachable] = includeProbe
    ? await Promise.all([
      probeTcp(controlPlane.host, controlPlane.port),
      probeTcp(web.host, web.port),
      probeTcp(httpListener.host, httpListener.port),
    ])
    : [undefined, undefined, undefined];
  const externalSurfaces = SURFACE_CONFIGS.map(([id, label, requiredKeys]) => {
    const enabled = config.get(`surfaces.${id}.enabled` as ConfigKey);
    const missing = requiredKeys.filter((key) => !isPresentConfigValue(config.get(key as ConfigKey)));
    return {
      id,
      label,
      enabled,
      ready: !enabled || missing.length === 0,
      missing,
    };
  });
  const filteredSurfaces = target ? externalSurfaces.filter((surface) => surface.id === target) : externalSurfaces;
  if (target && filteredSurfaces.length === 0) return `Unknown surface: ${target}`;
  const value = {
    controlPlane: {
      enabled: config.get('controlPlane.enabled'),
      hostMode: controlPlane.hostMode,
      configuredHost: controlPlane.configuredHost,
      host: controlPlane.host,
      port: controlPlane.port,
      reachable: controlPlaneReachable,
    },
    web: {
      enabled: config.get('web.enabled'),
      hostMode: web.hostMode,
      configuredHost: web.configuredHost,
      host: web.host,
      port: web.port,
      reachable: webReachable,
    },
    httpListener: {
      enabled: config.get('danger.httpListener'),
      hostMode: httpListener.hostMode,
      configuredHost: httpListener.configuredHost,
      host: httpListener.host,
      port: httpListener.port,
      reachable: listenerReachable,
    },
    surfaces: filteredSurfaces,
  };
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes surfaces',
    `  control-plane: ${yesNo(value.controlPlane.enabled)} (${value.controlPlane.hostMode} ${value.controlPlane.host}:${value.controlPlane.port})${includeProbe ? ` reachable=${yesNo(value.controlPlane.reachable)}` : ''}`,
    `  web: ${yesNo(value.web.enabled)} (${value.web.hostMode} ${value.web.host}:${value.web.port})${includeProbe ? ` reachable=${yesNo(value.web.reachable)}` : ''}`,
    `  http-listener: ${yesNo(value.httpListener.enabled)} (${value.httpListener.hostMode} ${value.httpListener.host}:${value.httpListener.port})${includeProbe ? ` reachable=${yesNo(value.httpListener.reachable)}` : ''}`,
    '',
    'External surfaces:',
    ...value.surfaces.map((surface) => `  ${surface.label.padEnd(16)} enabled=${yesNo(surface.enabled)} ready=${yesNo(surface.ready)}${surface.enabled && surface.missing.length > 0 ? ` missing=${surface.missing.join(',')}` : ''}`),
  ].join('\n'));
}

export async function renderListenerTest(runtime: CliCommandRuntime): Promise<string> {
  const enabled = runtime.configManager.get('danger.httpListener');
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'httpListener');
  const reachable = await probeTcp(binding.host, binding.port);
  const value = { enabled, ...binding, reachable };
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes listener test',
    `  enabled: ${yesNo(enabled)}`,
    `  endpoint: ${binding.hostMode} ${binding.host}:${binding.port}`,
    `  reachable: ${yesNo(reachable)}`,
  ].join('\n'));
}

export async function renderControlPlaneStatus(runtime: CliCommandRuntime): Promise<string> {
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const reachable = await probeTcp(binding.host, binding.port);
  const auth = readAuthPaths(runtime);
  const value = {
    enabled: runtime.configManager.get('controlPlane.enabled'),
    ...binding,
    reachable,
    auth,
  };
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes control-plane status',
    `  enabled: ${yesNo(value.enabled)}`,
    `  bind: ${binding.hostMode} ${binding.host}:${binding.port}`,
    `  reachable: ${yesNo(reachable)}`,
    `  local auth users: ${auth.userStorePresent ? 'present' : 'missing'}`,
    `  bootstrap credential: ${auth.bootstrapCredentialPresent ? 'present' : 'missing'}`,
    `  operator tokens: ${auth.operatorTokenPresent ? 'present' : 'missing'}`,
  ].join('\n'));
}

export async function renderPairing(runtime: CliCommandRuntime): Promise<string> {
  const daemonHomeDir = join(runtime.homeDirectory, '.goodvibes', 'daemon');
  const tokenRecord = getOrCreateCompanionToken('tui', { daemonHomeDir });
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'controlPlane');
  const daemonUrl = `http://${urlHostForBindHost(binding.host)}:${binding.port}`;
  const info = buildCompanionConnectionInfo({
    daemonUrl,
    token: tokenRecord.token,
    username: 'admin',
  });
  const payload = encodeConnectionPayload(info);
  const qr = renderQrToString(generateQrMatrix(payload));
  return [formatConnectionBlock(info, payload), '', qr].join('\n');
}

export async function handleBundle(runtime: CliCommandRuntime): Promise<string> {
  const [sub = 'inspect', ...rest] = runtime.cli.commandArgs;
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  if (sub === 'inspect') {
    const path = rest[0];
    if (!path) return 'Usage: goodvibes bundle inspect <path>';
    const sourcePath = shellPaths.resolveWorkspacePath(path);
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
    return [
      'GoodVibes bundle',
      `  type: ${String(parsed['type'] ?? 'unknown')}`,
      `  version: ${String(parsed['version'] ?? 'unknown')}`,
      `  path: ${sourcePath}`,
      `  capturedAt: ${parsed['capturedAt'] ? new Date(Number(parsed['capturedAt'])).toISOString() : 'n/a'}`,
      `  configKeys: ${parsed['config'] && typeof parsed['config'] === 'object' ? CONFIG_SCHEMA.filter((setting) => getNestedValue(parsed['config'], setting.key) !== undefined).length : 0}`,
    ].join('\n');
  }
  if (sub === 'export') {
    const outputPath = rest[0] ?? 'goodvibes-bundle.json';
    const secrets = new SecretsManager({
      projectRoot: runtime.workingDirectory,
      globalHome: runtime.homeDirectory,
      configManager: runtime.configManager,
    });
    const bundle = {
      version: 1,
      type: 'goodvibes.setup',
      capturedAt: Date.now(),
      workingDirectory: runtime.workingDirectory,
      config: runtime.configManager.getRaw(),
      secrets: await secrets.inspect(),
      onboarding: {
        projectMarker: existsSync(shellPaths.resolveProjectPath('tui', 'onboarding.json')),
        userMarker: existsSync(shellPaths.resolveUserPath('tui', 'onboarding.json')),
      },
    };
    const targetPath = shellPaths.resolveWorkspacePath(outputPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
    return `Bundle exported: ${targetPath}`;
  }
  if (sub === 'import') {
    const path = rest[0];
    if (!path) return 'Usage: goodvibes bundle import <path>';
    const sourcePath = shellPaths.resolveWorkspacePath(path);
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf-8')) as { config?: GoodVibesConfig };
    if (!parsed.config || typeof parsed.config !== 'object') return 'Bundle has no config object to import.';
    let count = 0;
    for (const setting of CONFIG_SCHEMA) {
      const value = getNestedValue(parsed.config, setting.key);
      if (value === undefined) continue;
      runtime.configManager.setDynamic(setting.key, value);
      count++;
    }
    return `Bundle imported: ${count} config value${count === 1 ? '' : 's'} applied.`;
  }
  return 'Usage: goodvibes bundle export [path]|inspect <path>|import <path>';
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
  const url = !hasEndpointOverride && publicBaseUrl
    ? publicBaseUrl
    : `http://${urlHostForBindHost(binding.host)}:${binding.port}`;
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
