import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import type { ConfigManager, ConfigKey, GoodVibesConfig } from '../config/index.ts';
import { CONFIG_SCHEMA } from '../config/index.ts';
import { formatProviderModel, getModelIdFromProviderModel } from '../config/provider-model.ts';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { createRuntimeServices } from '../runtime/services.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import { SecretsManager } from '../config/secrets.ts';
import { RuntimeEventBus, type TurnEvent } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { listProviderRuntimeSnapshots } from '@pellux/goodvibes-sdk/platform/providers';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@pellux/goodvibes-sdk/platform/config';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config';
import { inspectProviderAuth } from '@/runtime/index.ts';
import { getOrCreateCompanionToken, buildCompanionConnectionInfo, encodeConnectionPayload, formatConnectionBlock } from '@pellux/goodvibes-sdk/platform/pairing';
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';
import type { GoodVibesCliParseResult } from './types.ts';
import { formatProviderAuthRoute, summarizeProviderAuthRoutes } from './provider-auth-routes.ts';
import { classifyProviderSetup } from './provider-classification.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import { applyRuntimeEndpointFlagOverrides } from './config-overrides.ts';
import type { RuntimeEndpointId } from './endpoints.ts';
import { handleServiceCommand } from './service-command.ts';
import { handleBundleCommand } from './bundle-command.ts';
import { buildListenerTestResult, formatListenerTestResult, handleSurfacesCommand } from './surface-command.ts';
import { buildControlPlaneStatusResult, formatControlPlaneStatus, handleSecrets, handleSessions, handleTasks, renderPairing, renderRemote, renderSubscriptions, renderWeb } from './management-commands.ts';

export interface CliCommandRuntime {
  readonly cli: GoodVibesCliParseResult;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

interface CliCommandResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

type Formatter = (value: unknown, text: string) => string;

export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

export function formatJsonOrText(cli: GoodVibesCliParseResult): Formatter {
  return (value, text) => cli.flags.outputFormat === 'json'
    ? JSON.stringify(value, null, 2)
    : text;
}

function exitCodeForText(output: string): number {
  if (output.startsWith('Usage:') || output.startsWith('Invalid ')) return 2;
  if (output.startsWith('Session not found:') || output.startsWith('Unknown task:') || output.startsWith('Task submit failed ')) return 1;
  if (output.startsWith('No stored ') || output.startsWith('No pending ') || output.startsWith('No model ') || output.startsWith('No provider ') || output.startsWith('No auth ')) return 1;
  if (output.startsWith('Unknown ')) return 1;
  if (output === 'Bundle has no config object to import.') return 1;
  return 0;
}

function splitCommandOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return { name: token.slice(0, index), value: token.slice(index + 1) };
}

function readOptionValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const split = splitCommandOption(token);
    if (split.name !== name) continue;
    if (split.value !== undefined) return split.value;
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) return undefined;
    return next;
  }
  return undefined;
}

function readOptionValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const split = splitCommandOption(token);
    if (split.name !== name) continue;
    if (split.value !== undefined) {
      values.push(split.value);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) values.push(next);
  }
  return values;
}

export function hasCommandFlag(args: readonly string[], name: string): boolean {
  return args.some((arg) => splitCommandOption(arg).name === name);
}

function commandValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      values.push(token);
      continue;
    }
    if (!token.includes('=') && args[index + 1] && !args[index + 1]!.startsWith('--')) index += 1;
  }
  return values;
}

function readPassword(args: readonly string[]): string | null {
  const explicit = readOptionValue(args, '--password');
  if (explicit !== undefined) return explicit;
  if (hasCommandFlag(args, '--password-stdin')) return readFileSync(0, 'utf-8').trimEnd();
  return process.env.GOODVIBES_AUTH_PASSWORD ?? null;
}

export function extractAuthorizationCode(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get('code') ?? input;
  } catch {
    return input;
  }
}

export function isPresentConfigValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null && value !== false;
}

function inferProviderFromRegistryKey(modelKey: string): string {
  if (modelKey.includes(':')) return modelKey.split(':')[0] || 'openai';
  if (modelKey.includes('/')) return modelKey.split('/')[0] || 'openai';
  return 'openai';
}

export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function getLocalNetworkIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const netInfo of nets[name] ?? []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
      }
    }
  } catch {
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

function connectHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host || '127.0.0.1';
}

export function urlHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return getLocalNetworkIp();
  return host || '127.0.0.1';
}

export function enableServicePosture(config: ConfigManager): void {
  config.setDynamic('service.enabled', true);
  config.setDynamic('service.autostart', true);
  config.setDynamic('service.restartOnFailure', true);
}

export function enableEndpointLanDefault(config: ConfigManager, endpoint: RuntimeEndpointId): void {
  const binding = resolveRuntimeEndpointBinding(config, endpoint);
  if (binding.hostMode === 'custom') return;
  if (endpoint === 'controlPlane') {
    config.setDynamic('controlPlane.hostMode', 'network');
    config.setDynamic('controlPlane.host', '0.0.0.0');
    config.setDynamic('controlPlane.allowRemote', true);
    return;
  }
  if (endpoint === 'httpListener') {
    config.setDynamic('httpListener.hostMode', 'network');
    config.setDynamic('httpListener.host', '0.0.0.0');
    return;
  }
  config.setDynamic('web.hostMode', 'network');
  config.setDynamic('web.host', '0.0.0.0');
}

export function applyTargetEndpointFlagsOrDefault(
  runtime: CliCommandRuntime,
  endpoint: RuntimeEndpointId,
): string | null {
  const errors = applyRuntimeEndpointFlagOverrides(runtime.configManager, endpoint, runtime.cli.flags);
  if (errors.length > 0) return errors.join('\n');
  if (runtime.cli.flags.hostname === undefined) {
    enableEndpointLanDefault(runtime.configManager, endpoint);
  }
  if (endpoint === 'controlPlane') {
    const binding = resolveRuntimeEndpointBinding(runtime.configManager, endpoint);
    runtime.configManager.setDynamic('controlPlane.allowRemote', binding.hostMode !== 'local');
  }
  return null;
}

export function openBrowser(url: string): string {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => {});
    child.unref();
    return 'browser open requested';
  } catch (error) {
    return `browser open failed: ${summarizeError(error)}`;
  }
}

export async function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function withRuntimeServices<T>(
  runtime: CliCommandRuntime,
  fn: (services: RuntimeServices) => Promise<T> | T,
): Promise<T> {
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const services = createRuntimeServices({
    configManager: runtime.configManager,
    runtimeBus,
    runtimeStore,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  services.providerRegistry.initModelLimits();
  services.benchmarkStore.initBenchmarks();
  services.providerRegistry.initCatalog();
  try {
    await services.providerRegistry.ready();
    return await fn(services);
  } finally {
    services.providerRegistry.stopWatching();
  }
}

export function readAuthPaths(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
  const operatorTokenPath = join(runtime.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath,
    operatorTokenPresent: existsSync(operatorTokenPath),
  };
}

export async function runNonInteractiveAgent(runtime: CliCommandRuntime): Promise<number> {
  const prompt = runtime.cli.flags.prompt ?? runtime.cli.positionals.join(' ').trim();
  if (!prompt) {
    console.error('Usage: goodvibes run|exec [prompt]');
    return 2;
  }

  const outputFormat = runtime.cli.flags.outputFormat;
  const ctx = await bootstrapRuntime(process.stdout, {
    configManager: runtime.configManager,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });

  const events: TurnEvent[] = [];
  let finalResponse = '';
  let finalError = '';
  let finalStopReason = '';
  let exitCode = 0;

  const done = new Promise<void>((resolve) => {
    const unsubs = [
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload }) => {
        events.push(payload);
        if (outputFormat === 'stream-json') {
          process.stdout.write(JSON.stringify({ type: payload.type, content: payload.content, accumulated: payload.accumulated }) + '\n');
        }
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => {
        events.push(payload);
        finalResponse = payload.response;
        finalStopReason = payload.stopReason;
        for (const unsub of unsubs) unsub();
        resolve();
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => {
        events.push(payload);
        finalError = payload.error;
        finalStopReason = payload.stopReason;
        exitCode = 1;
        for (const unsub of unsubs) unsub();
        resolve();
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => {
        events.push(payload);
        finalError = payload.reason ?? 'cancelled';
        finalStopReason = payload.stopReason;
        exitCode = 130;
        for (const unsub of unsubs) unsub();
        resolve();
      }),
    ];
  });

  try {
    await ctx.orchestrator.handleUserInput(prompt);
    await done;
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({
        ok: exitCode === 0,
        response: finalResponse,
        error: finalError || undefined,
        stopReason: finalStopReason,
        sessionId: ctx.runtime.sessionId,
        model: ctx.runtime.model,
        provider: ctx.runtime.provider,
        events: events.length,
      }, null, 2) + '\n');
    } else if (outputFormat !== 'stream-json') {
      process.stdout.write((exitCode === 0 ? finalResponse : finalError) + '\n');
    } else {
      process.stdout.write(JSON.stringify({
        type: exitCode === 0 ? 'TURN_COMPLETED' : 'TURN_ERROR',
        ok: exitCode === 0,
        response: finalResponse,
        error: finalError || undefined,
        stopReason: finalStopReason,
      }) + '\n');
    }
  } finally {
    const snapshot = ctx.conversation.toJSON() as Parameters<typeof ctx.shutdown>[0];
    await ctx.shutdown(snapshot);
  }
  return exitCode;
}

async function renderProviders(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    const snapshots = await listProviderRuntimeSnapshots(services.providerRegistry);
    const current = services.providerRegistry.getCurrentModel();
    if (sub === 'current') {
      const snapshot = snapshots.find((candidate) => candidate.providerId === current.provider);
      const authRoutes = snapshot?.runtime.auth?.routes ?? [];
      const value = {
        provider: current.provider,
        model: current.registryKey,
        configured: snapshot?.runtime.auth?.configured ?? true,
        configuredVia: snapshot?.runtime.auth?.mode ?? 'unknown',
        authRoutes,
        authRouteSummary: summarizeProviderAuthRoutes(authRoutes),
      };
      return formatJsonOrText(runtime.cli)(value, [
        'GoodVibes current provider',
        `  provider: ${current.provider}`,
        `  model: ${current.registryKey}`,
        `  configured: ${yesNo(value.configured)}`,
        `  via: ${value.configuredVia}`,
        `  auth routes: ${value.authRouteSummary}`,
      ].join('\n'));
    }
    if (sub === 'use' || sub === 'set') {
      const provider = rest[0];
      if (!provider) return 'Usage: goodvibes providers use <provider> [modelRegistryKey]';
      const providerModels = services.providerRegistry
        .getSelectableModels()
        .filter((model) => model.provider === provider || model.registryKey.startsWith(`${provider}:`));
      const requestedModel = rest[1];
      const selected = requestedModel
        ? providerModels.find((model) => model.registryKey === requestedModel || model.id === requestedModel)
        : providerModels.find((model) => model.registryKey === current.registryKey) ?? providerModels[0];
      if (providerModels.length === 0 || !selected) {
        if (requestedModel) {
          runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, requestedModel));
        } else {
          runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, getModelIdFromProviderModel(runtime.configManager.get('provider.model'))));
        }
        return requestedModel
          ? `Provider selected: ${provider} (${requestedModel})\n  warning: model catalog entry was not available locally; saved explicit selection.`
          : `Provider selected: ${provider}\n  warning: model catalog entry was not available locally; model selection was left unchanged.`;
      }
      runtime.configManager.setDynamic('provider.model', selected.registryKey);
      return `Provider selected: ${selected.provider} (${selected.registryKey})`;
    }
    if (sub === 'inspect' || sub === 'show') {
      const provider = rest[0];
      if (!provider) return 'Usage: goodvibes providers inspect <provider>';
      const snapshot = snapshots.find((candidate) => candidate.providerId === provider);
      if (!snapshot) return `No provider found: ${provider}`;
      const setup = classifyProviderSetup({
        providerId: snapshot.providerId,
        authMode: snapshot.runtime.auth?.mode,
        configured: snapshot.runtime.auth?.configured ?? true,
        modelCount: snapshot.modelCount,
      });
      const authRoutes = snapshot.runtime.auth?.routes ?? [];
      return formatJsonOrText(runtime.cli)({
        ...snapshot,
        setup,
        authRoutes,
        authRouteSummary: summarizeProviderAuthRoutes(authRoutes),
      }, [
        `Provider ${snapshot.providerId}`,
        `  active: ${yesNo(snapshot.active)}`,
        `  setup: ${setup.setupLabel}`,
        `  configured: ${yesNo(snapshot.runtime.auth?.configured ?? true)}`,
        `  via: ${snapshot.runtime.auth?.mode ?? 'unknown'}`,
        `  models: ${snapshot.modelCount}`,
        `  auth routes: ${summarizeProviderAuthRoutes(authRoutes)}`,
        ...authRoutes.map((route) => `    ${formatProviderAuthRoute(route)}`),
        `  detail: ${snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? ''}`,
      ].join('\n'));
    }
    if (sub !== 'list') return 'Usage: goodvibes providers [list|current|inspect <provider>|use <provider> [modelRegistryKey]]';
    const value = snapshots.map((snapshot) => ({
      ...classifyProviderSetup({
        providerId: snapshot.providerId,
        authMode: snapshot.runtime.auth?.mode,
        configured: snapshot.runtime.auth?.configured ?? true,
        modelCount: snapshot.modelCount,
      }),
      provider: snapshot.providerId,
      active: snapshot.active,
      configured: snapshot.runtime.auth?.configured ?? true,
      configuredVia: snapshot.runtime.auth?.mode ?? 'unknown',
      models: snapshot.modelCount,
      current: current.provider === snapshot.providerId,
      detail: snapshot.runtime.auth?.detail ?? snapshot.runtime.notes?.join('; ') ?? '',
      authRoutes: snapshot.runtime.auth?.routes ?? [],
      authRouteSummary: summarizeProviderAuthRoutes(snapshot.runtime.auth?.routes),
    }));
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes providers',
      ...value.map((provider) =>
        `  ${provider.current ? '*' : ' '} ${provider.provider.padEnd(18)} setup=${provider.setupClass} configured=${yesNo(provider.configured)} via=${provider.configuredVia ?? 'n/a'} models=${provider.models} routes=${provider.authRouteSummary} ${provider.detail ?? ''}`.trimEnd(),
      ),
    ].join('\n'));
  });
}

async function renderModels(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, async (services) => {
    const [subOrFilter, ...rest] = runtime.cli.commandArgs;
    const current = services.providerRegistry.getCurrentModel().registryKey;
    const providerSnapshots = await listProviderRuntimeSnapshots(services.providerRegistry);
    const classifyModelProvider = (providerId: string) => {
      const snapshot = providerSnapshots.find((candidate) => candidate.providerId === providerId);
      return classifyProviderSetup({
        providerId,
        authMode: snapshot?.runtime.auth?.mode,
        configured: snapshot?.runtime.auth?.configured,
        modelCount: snapshot?.modelCount,
      });
    };
    if (subOrFilter === 'current') {
      const model = services.providerRegistry.getCurrentModel();
      const setup = classifyModelProvider(model.provider);
      const providerSnapshot = providerSnapshots.find((candidate) => candidate.providerId === model.provider);
      const value = {
        registryKey: model.registryKey,
        provider: model.provider,
        id: model.id,
        displayName: model.displayName,
        contextWindow: services.providerRegistry.getContextWindowForModel(model),
        providerConfigured: providerSnapshot?.runtime.auth?.configured ?? true,
        setup,
      };
      return formatJsonOrText(runtime.cli)(value, [
        'GoodVibes current model',
        `  model: ${model.registryKey}`,
        `  provider: ${model.provider}`,
        `  setup: ${setup.setupLabel}`,
        `  provider configured: ${yesNo(value.providerConfigured)}`,
        `  context: ${value.contextWindow.toLocaleString()}`,
      ].join('\n'));
    }
    if (subOrFilter === 'use' || subOrFilter === 'set') {
      const modelKey = rest[0];
      if (!modelKey) return 'Usage: goodvibes models use <registryKey>';
      const model = services.providerRegistry
        .getSelectableModels()
        .find((candidate) => candidate.registryKey === modelKey || candidate.id === modelKey);
      if (!model) {
        const provider = inferProviderFromRegistryKey(modelKey);
        runtime.configManager.setDynamic('provider.model', formatProviderModel(provider, modelKey));
        await services.favoritesStore.recordUsage(modelKey);
        return `Model selected: ${modelKey}\n  warning: model catalog entry was not available locally; saved explicit selection.`;
      }
      runtime.configManager.setDynamic('provider.model', model.registryKey);
      await services.favoritesStore.recordUsage(model.registryKey);
      return `Model selected: ${model.registryKey}`;
    }
    if (subOrFilter === 'pin' || subOrFilter === 'unpin') {
      const modelKey = rest[0];
      if (!modelKey) return `Usage: goodvibes models ${subOrFilter} <registryKey>`;
      if (subOrFilter === 'pin') await services.favoritesStore.pinModel(modelKey);
      else await services.favoritesStore.unpinModel(modelKey);
      return `Model ${subOrFilter === 'pin' ? 'pinned' : 'unpinned'}: ${modelKey}`;
    }
    if (subOrFilter === 'pinned') {
      const pinned = await services.favoritesStore.getPinned();
      return formatJsonOrText(runtime.cli)({ pinned }, [
        `GoodVibes pinned models (${pinned.length})`,
        ...pinned.map((model) => `  ${model}`),
      ].join('\n'));
    }
    if (subOrFilter === 'recent') {
      const recent = await services.favoritesStore.getRecentModels(25);
      return formatJsonOrText(runtime.cli)({ recent }, [
        `GoodVibes recent models (${recent.length})`,
        ...recent.map((model) => `  ${model}`),
      ].join('\n'));
    }
    const filter = subOrFilter === 'list' ? rest[0]?.toLowerCase() : subOrFilter?.toLowerCase();
    const models = services.providerRegistry
      .getSelectableModels()
      .filter((model) => !filter || model.provider.toLowerCase() === filter || model.registryKey.toLowerCase().includes(filter))
      .slice(0, 200);
    const value = models.map((model) => ({
      registryKey: model.registryKey,
      provider: model.provider,
      ...classifyModelProvider(model.provider),
      id: model.id,
      displayName: model.displayName,
      contextWindow: services.providerRegistry.getContextWindowForModel(model),
      current: model.registryKey === current,
    }));
    return formatJsonOrText(runtime.cli)(value, [
      `GoodVibes models${filter ? ` (${filter})` : ''}`,
      ...value.map((model) => `  ${model.current ? '*' : ' '} ${model.registryKey.padEnd(42)} setup=${model.setupClass} ctx=${model.contextWindow.toLocaleString()} ${model.displayName}`),
    ].join('\n'));
  });
}

async function renderAuth(runtime: CliCommandRuntime): Promise<string> {
  return await withRuntimeServices(runtime, (services) => {
    const [sub = 'status', ...rawRest] = runtime.cli.commandArgs;
    const rest = commandValues(rawRest);
    if (sub === 'add-user' || sub === 'add') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]';
      const password = readPassword(rawRest);
      if (!password) return 'Usage: goodvibes auth add-user <username> [--password <value>|--password-stdin] [--role <role>]';
      const roles = readOptionValues(rawRest, '--role').filter((role) => role.length > 0);
      const user = services.localUserAuthManager.addUser(username, password, roles.length > 0 ? roles : ['user']);
      return `Auth user added: ${user.username} (${user.roles.join(', ') || 'no roles'})`;
    }
    if (sub === 'delete-user' || sub === 'remove-user') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth delete-user <username>';
      return services.localUserAuthManager.deleteUser(username)
        ? `Auth user deleted: ${username}`
        : `No auth user found: ${username}`;
    }
    if (sub === 'rotate-password' || sub === 'passwd') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]';
      const password = readPassword(rawRest);
      if (!password) return 'Usage: goodvibes auth rotate-password <username> [--password <value>|--password-stdin]';
      services.localUserAuthManager.rotatePassword(username, password);
      return `Auth password rotated: ${username}`;
    }
    if (sub === 'revoke-session') {
      const token = rest[0];
      if (!token) return 'Usage: goodvibes auth revoke-session <token-or-fingerprint>';
      return services.localUserAuthManager.revokeSession(token)
        ? 'Auth session revoked.'
        : 'No auth session found.';
    }
    if (sub === 'revoke-sessions') {
      const username = rest[0];
      if (!username) return 'Usage: goodvibes auth revoke-sessions <username>';
      const count = services.localUserAuthManager.revokeSessionsForUser(username);
      return `Auth sessions revoked for ${username}: ${count}`;
    }
    if (sub === 'clear-bootstrap') {
      return services.localUserAuthManager.clearBootstrapCredentialFile()
        ? 'Bootstrap credential file removed.'
        : 'Bootstrap credential file was already absent.';
    }
    if (sub !== 'status' && sub !== 'list' && sub !== 'users' && sub !== 'sessions') {
      return 'Usage: goodvibes auth [status|users|sessions|add-user|delete-user|rotate-password|revoke-session|revoke-sessions|clear-bootstrap]';
    }
    const snapshot = services.localUserAuthManager.inspect();
    const paths = readAuthPaths(runtime);
    const value = {
      ...paths,
      users: snapshot.users.map((user) => ({ username: user.username, roles: user.roles })),
      sessions: snapshot.sessions.length,
      permissionMode: runtime.configManager.get('permissions.mode'),
    };
    if (sub === 'users') {
      return formatJsonOrText(runtime.cli)(value.users, [
        `GoodVibes auth users (${value.users.length})`,
        ...value.users.map((user) => `  ${user.username} (${user.roles.join(', ') || 'no roles'})`),
      ].join('\n'));
    }
    if (sub === 'sessions') {
      return formatJsonOrText(runtime.cli)(snapshot.sessions, [
        `GoodVibes auth sessions (${snapshot.sessions.length})`,
        ...snapshot.sessions.map((session) => `  ${session.username} expires=${new Date(session.expiresAt).toISOString()} fingerprint=${session.tokenFingerprint}`),
      ].join('\n'));
    }
    return formatJsonOrText(runtime.cli)(value, [
      'GoodVibes auth',
      `  permission mode: ${String(value.permissionMode)}`,
      `  users: ${value.users.length}`,
      ...value.users.map((user) => `    ${user.username} (${user.roles.join(', ') || 'no roles'})`),
      `  sessions: ${value.sessions}`,
      `  user store: ${paths.userStorePresent ? 'present' : 'missing'} (${paths.userStorePath})`,
      `  bootstrap credential: ${paths.bootstrapCredentialPresent ? 'present' : 'missing'} (${paths.bootstrapCredentialPath})`,
      `  operator tokens: ${paths.operatorTokenPresent ? 'present' : 'missing'} (${paths.operatorTokenPath})`,
    ].join('\n'));
  });
}


export async function handleGoodVibesCliCommand(runtime: CliCommandRuntime): Promise<CliCommandResult> {
  try {
    switch (runtime.cli.command) {
      case 'run':
        return { handled: true, exitCode: await runNonInteractiveAgent(runtime) };
      case 'web':
        console.log(renderWeb(runtime));
        return { handled: true, exitCode: 0 };
      case 'service': {
        const result = await handleServiceCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'providers': {
        const output = await renderProviders(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'models': {
        const output = await renderModels(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'auth': {
        const output = await renderAuth(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'subscription': {
        const output = await renderSubscriptions(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'secrets': {
        const output = await handleSecrets(runtime);
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'sessions': {
        const output = await handleSessions(runtime);
        if (output === null) return { handled: false, exitCode: 0 };
        console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'tasks': {
        const output = await handleTasks(runtime);
        if (output) console.log(output);
        return { handled: true, exitCode: exitCodeForText(output) };
      }
      case 'surfaces': {
        const result = await handleSurfacesCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'listener': {
        const result = await buildListenerTestResult(runtime);
        console.log(formatListenerTestResult(runtime, result));
        return { handled: true, exitCode: result.issues.length > 0 ? 1 : 0 };
      }
      case 'control-plane': {
        const result = await buildControlPlaneStatusResult(runtime);
        console.log(formatControlPlaneStatus(runtime, result));
        return { handled: true, exitCode: result.issues.length > 0 ? 1 : 0 };
      }
      case 'pair':
        console.log(await renderPairing(runtime));
        return { handled: true, exitCode: 0 };
      case 'bundle': {
        const result = await handleBundleCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'remote':
        console.log(await renderRemote(runtime, 'remote'));
        return { handled: true, exitCode: 0 };
      case 'bridge':
        console.log(await renderRemote(runtime, 'bridge'));
        return { handled: true, exitCode: 0 };
      default:
        return { handled: false, exitCode: 0 };
    }
  } catch (error) {
    console.error(summarizeError(error));
    return { handled: true, exitCode: 1 };
  }
}
