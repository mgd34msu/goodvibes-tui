import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigManager, ConfigKey, GoodVibesConfig } from '@pellux/goodvibes-sdk/platform/config';
import { CONFIG_SCHEMA } from '@pellux/goodvibes-sdk/platform/config';
import { formatProviderModel, getModelIdFromProviderModel } from '@pellux/goodvibes-sdk/platform/providers';
import { SecretsManager } from '../config/secrets.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { listProviderRuntimeSnapshots } from '@pellux/goodvibes-sdk/platform/providers';
import type { CanonicalModel } from '@pellux/goodvibes-sdk/platform/providers';
import { BUILTIN_SECRET_PROVIDER_SOURCES, describeSecretRef, isSecretRefInput, resolveSecretRef } from '@pellux/goodvibes-sdk/platform/config';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config';
import { beginOpenAICodexLogin, exchangeOpenAICodexCode } from '@pellux/goodvibes-sdk/platform/config';
import { inspectProviderAuth } from '@/runtime/index.ts';
import type { CliCommandRuntime, GoodVibesCliParseResult } from '@pellux/goodvibes-terminal-shell';
import { formatProviderAuthRoute, summarizeProviderAuthRoutes } from './provider-auth-routes.ts';
import { classifyProviderSetup } from '../providers/provider-classification.ts';
import { resolveRuntimeEndpointBinding } from '@pellux/goodvibes-terminal-shell';
import { applyRuntimeEndpointFlagOverrides } from '@pellux/goodvibes-terminal-shell';
import type { RuntimeEndpointId } from '@pellux/goodvibes-terminal-shell';
import { handleServiceCommand } from './service-command.ts';
import { handleBundleCommand } from './bundle-command.ts';
import { handleHooksCommand } from './hooks-command.ts';
import { handlePluginCommand } from './plugin-command.ts';
import { buildListenerTestResult, formatListenerTestResult, handleSurfacesCommand } from './surface-command.ts';
import { buildControlPlaneStatusResult, formatControlPlaneStatus, handleSecrets, handleSessions, handleTasks, renderPairing, renderRemote, renderSubscriptions, renderWeb } from './management-commands.ts';
import {
  yesNo,
  formatJsonOrText,
  hasCommandFlag,
  withRuntimeServices,
  runNonInteractiveAgent,
  isPresentConfigValue,
  urlHostForBindHost,
  probeTcp,
  readAuthPaths,
  exitCodeForText,
  splitCommandOption,
  readOptionValue,
  readOptionValues,
  commandValues,
  readPassword,
} from './management-utils.ts';

interface CliCommandResult {
  readonly handled: boolean;
  readonly exitCode: number;
}

export {
  yesNo,
  formatJsonOrText,
  hasCommandFlag,
  extractAuthorizationCode,
  isPresentConfigValue,
  getNestedValue,
  urlHostForBindHost,
  enableServicePosture,
  enableEndpointLanDefault,
  applyTargetEndpointFlagsOrDefault,
  openBrowser,
  probeTcp,
  withRuntimeServices,
  readAuthPaths,
  runNonInteractiveAgent,
} from './management-utils.ts';

function inferProviderFromRegistryKey(modelKey: string): string {
  if (modelKey.includes(':')) return modelKey.split(':')[0] || 'openai';
  if (modelKey.includes('/')) return modelKey.split('/')[0] || 'openai';
  return 'openai';
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

/**
 * Build the synthetic chain entry list for `goodvibes models chain` output.
 * Pure transformation: accepts canonical model data and an optional lowercase filter key,
 * returns a serializable array suitable for both JSON and text formatting.
 *
 * @internal exported for unit testing
 */
export function buildSyntheticChainEntries(
  canonicalModels: readonly CanonicalModel[],
  filterKey?: string,
): Array<{
  id: string;
  tier: string;
  backendCount: number;
  keyedBackendCount: number;
  backends: Array<{ position: number; provider: string; model: string; registryKey: string }>;
}> {
  const filtered = filterKey
    ? canonicalModels.filter((m) => m.id.toLowerCase().includes(filterKey))
    : canonicalModels;
  return filtered.map((m) => ({
    id: m.id,
    tier: m.tier,
    backendCount: m.backendCount,
    keyedBackendCount: m.keyedBackendCount,
    backends: m.backends.map((b, idx) => ({
      position: idx,
      provider: b.providerName,
      model: b.modelId,
      registryKey: b.registryKey ?? `${b.providerName}:${b.modelId}`,
    })),
  }));
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
    if (subOrFilter === 'chain' || subOrFilter === 'chains') {
      // List synthetic model fallback ladders, backend composition for each synthetic model.
      const canonicalModels = services.providerRegistry.getSyntheticCanonicalModels();
      if (canonicalModels.length === 0) {
        return formatJsonOrText(runtime.cli)([], 'No synthetic models found in the current catalog.');
      }
      const filterKey = rest[0]?.toLowerCase();
      const filtered = filterKey
        ? canonicalModels.filter((m) => m.id.toLowerCase().includes(filterKey))
        : canonicalModels;
      const value = buildSyntheticChainEntries(filtered);
      return formatJsonOrText(runtime.cli)(value, [
        `GoodVibes synthetic model chains${filterKey ? ` (${filterKey})` : ''}`,
        ...value.flatMap((m) => [
          `  ${m.id}  [${m.tier}]  ${m.keyedBackendCount}/${m.backendCount} backends configured`,
          ...m.backends.map((b) => `    ${b.position}. ${b.provider}/${b.model}`),
        ]),
      ].join('\n'));
    }
    const filter = subOrFilter === 'list' ? rest[0]?.toLowerCase() : subOrFilter?.toLowerCase();
    const models = services.providerRegistry
      .getSelectableModels()
      .filter((model) => !filter || model.provider.toLowerCase() === filter || model.registryKey.toLowerCase().includes(filter))
      .slice(0, 200);
    const value = models.map((model) => {
      const synthInfo = model.provider === 'synthetic'
        ? services.providerRegistry.getSyntheticModelInfoFromCatalog(model.id)
        : null;
      return {
        registryKey: model.registryKey,
        provider: model.provider,
        ...classifyModelProvider(model.provider),
        id: model.id,
        displayName: model.displayName,
        contextWindow: services.providerRegistry.getContextWindowForModel(model),
        current: model.registryKey === current,
        ...(synthInfo !== null ? {
          isSynthetic: true,
          syntheticTier: synthInfo.tier,
          syntheticBackends: synthInfo.backendCount,
          syntheticConfiguredBackends: synthInfo.keyedBackendCount,
        } : {}),
      };
    });
    return formatJsonOrText(runtime.cli)(value, [
      `GoodVibes models${filter ? ` (${filter})` : ''}`,
      ...value.map((model) => {
        const synthLabel = model.isSynthetic
          ? ` [synthetic ${model.syntheticConfiguredBackends}/${model.syntheticBackends}p]`
          : '';
        return `  ${model.current ? '*' : ' '} ${model.registryKey.padEnd(42)} setup=${model.setupClass} ctx=${model.contextWindow.toLocaleString()}${synthLabel} ${model.displayName}`;
      }),
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
      case 'support-bundle': {
        const result = await handleBundleCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'hooks': {
        const result = await handleHooksCommand(runtime);
        console.log(result.output);
        return { handled: true, exitCode: result.exitCode };
      }
      case 'plugin': {
        const result = await handlePluginCommand(runtime);
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
