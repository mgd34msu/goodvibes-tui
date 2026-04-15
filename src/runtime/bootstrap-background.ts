import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { autoRegisterProviders } from '@pellux/goodvibes-sdk/platform/providers/auto-register';
import { scan, loadPersistedProviders, persistProviders, removePersistedProviders, scanMcpServers } from '@pellux/goodvibes-sdk/platform/discovery/index';
import type { MutableRuntimeState } from './context.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

type BackgroundProviderRegistrationOptions = {
  configManager: ConfigManager;
  providerRegistry: ProviderRegistry;
  runtime: MutableRuntimeState;
  requestRender: () => void;
  restoreSavedModel: (providerRegistry: ProviderRegistry, savedModel: string, savedProvider: string, runtime: MutableRuntimeState) => void;
  systemMessageRouter: SystemMessageRouter;
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
};

function toDiscoveryRoots(shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>) {
  return {
    workingDirectory: shellPaths.workingDirectory,
    homeDirectory: shellPaths.homeDirectory,
    surfaceRoot: 'tui',
  } as const;
}

export function startBackgroundProviderRegistration(
  options: BackgroundProviderRegistrationOptions,
): void {
  const { configManager, providerRegistry, runtime, requestRender, restoreSavedModel, systemMessageRouter, shellPaths } = options;
  const discoveryRoots = toDiscoveryRoots(shellPaths);

  autoRegisterProviders(providerRegistry);

  const persisted = loadPersistedProviders(discoveryRoots);
  if (persisted.length > 0) {
    try {
      providerRegistry.registerDiscoveredProviders(persisted);
      restoreSavedModel(
        providerRegistry,
        configManager.get('provider.model') as string,
        configManager.get('provider.provider') as string,
        runtime,
      );
      for (const server of persisted) {
        systemMessageRouter.low(
          `[Local] ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''}) — from last session`,
        );
      }
      requestRender();
    } catch (err) {
      logger.debug('[bootstrap] Non-fatal error during persisted provider registration', {
        error: summarizeError(err),
      });
    }
  }

  scan().then((result) => {
    const currentModel = configManager.get('provider.model') as string;
    const foundKeys = new Set(result.servers.map((server) => `${server.host}:${server.port}`));
    const persistedKeys = new Set(persisted.map((server) => `${server.host}:${server.port}`));
    const newServers = result.servers.filter((server) => !persistedKeys.has(`${server.host}:${server.port}`));
    const removedServers = persisted.filter((server) => !foundKeys.has(`${server.host}:${server.port}`));

    if (result.servers.length > 0) {
      try {
        providerRegistry.registerDiscoveredProviders(result.servers);
        restoreSavedModel(
          providerRegistry,
          configManager.get('provider.model') as string,
          configManager.get('provider.provider') as string,
          runtime,
        );
      } catch (err) {
        logger.debug('[bootstrap] Non-fatal error during scan provider registration', {
          error: summarizeError(err),
        });
      }
    }

    for (const server of newServers) {
      systemMessageRouter.low(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''})`,
      );
    }

    if (result.servers.length > 0 && removedServers.length > 0) {
      removePersistedProviders(discoveryRoots, removedServers);
      for (const server of removedServers) {
        systemMessageRouter.low(
          `[Scan] ${server.name} at ${server.host}:${server.port} is no longer reachable — removed`,
        );
        const wasActive = server.models.includes(currentModel);
        if (wasActive) {
          configManager.set('provider.model', 'openrouter/free');
          configManager.set('provider.provider', 'openrouter');
          try {
            providerRegistry.setCurrentModel('openrouter/free');
            runtime.model = 'openrouter/free';
            runtime.provider = 'openrouter';
          } catch (err) {
            logger.debug('[bootstrap] Non-fatal error switching model after server removal', {
              error: summarizeError(err),
            });
          }
          systemMessageRouter.high(
            `[Scan] Active model was on ${server.name} — switched to openrouter/free`,
          );
        }
      }
    }

    if (result.servers.length > 0) {
      persistProviders(discoveryRoots, result.servers);
    }

    if (newServers.length > 0 || removedServers.length > 0) {
      requestRender();
    }
  }).catch(() => {
    // Non-fatal: scan failure expected when no local LLMs are running
  });
}

type McpAutodiscoveryOptions = {
  mcpRegistry: McpRegistry;
  systemMessageRouter: SystemMessageRouter;
  requestRender: () => void;
  shellPaths: Pick<ShellPathService, 'workingDirectory' | 'homeDirectory'>;
};

export function scheduleMcpAutodiscovery(options: McpAutodiscoveryOptions): void {
  const { mcpRegistry, systemMessageRouter, requestRender, shellPaths } = options;
  const discoveryRoots = toDiscoveryRoots(shellPaths);

  mcpRegistry.connectAll(shellPaths).catch((err) => {
    logger.debug('MCP auto-connect failed (non-fatal)', { error: summarizeError(err) });
  });

  setTimeout(() => {
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers(discoveryRoots, registeredNames).then((result) => {
      if (result.suggestions.length === 0) return;
      for (const suggestion of result.suggestions) {
        systemMessageRouter.low(
          `[MCP] Discovered server '${suggestion.name}' (${suggestion.command} ${(suggestion.args ?? []).join(' ')}). Add it to .goodvibes/mcp.json or ~/.config/mcp/mcp.json to enable it.`,
        );
      }
      requestRender();
    }).catch((err) => {
      logger.debug('MCP auto-discovery scan failed (non-fatal)', { error: summarizeError(err) });
    });
  }, 2000);
}
