import type { ConfigManager } from '../config/manager.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { ProviderRegistry } from '../providers/registry.ts';
import { autoRegisterProviders } from '../providers/auto-register.ts';
import { scan, loadPersistedProviders, persistProviders, removePersistedProviders, scanMcpServers } from '@pellux/goodvibes-sdk/platform/discovery/index';
import type { MutableRuntimeState } from './context.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { McpRegistry } from '../mcp/registry.ts';
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

export function startBackgroundProviderRegistration(
  options: BackgroundProviderRegistrationOptions,
): void {
  const { configManager, providerRegistry, runtime, requestRender, restoreSavedModel, systemMessageRouter, shellPaths } = options;

  autoRegisterProviders(providerRegistry);

  const persisted = loadPersistedProviders(shellPaths);
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
      removePersistedProviders(shellPaths, removedServers);
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
      persistProviders(shellPaths, result.servers);
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

  mcpRegistry.connectAll(shellPaths).catch((err) => {
    logger.debug('MCP auto-connect failed (non-fatal)', { error: summarizeError(err) });
  });

  setTimeout(() => {
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers(shellPaths, registeredNames).then((result) => {
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
