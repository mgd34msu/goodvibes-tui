import { configManager, getWorkingDirectory } from '../config/index.ts';
import { logger } from '../utils/logger.ts';
import { providerRegistry } from '../providers/registry.ts';
import { autoRegisterProviders } from '../providers/auto-register.ts';
import { scan, loadPersistedProviders, persistProviders, removePersistedProviders, scanMcpServers } from '../discovery/index.ts';
import type { MutableRuntimeState } from './context.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { McpRegistry } from '../mcp/registry.ts';

type BackgroundProviderRegistrationOptions = {
  runtime: MutableRuntimeState;
  requestRender: () => void;
  restoreSavedModel: (savedModel: string, savedProvider: string, runtime: MutableRuntimeState) => void;
  systemMessageRouter: SystemMessageRouter;
};

export function startBackgroundProviderRegistration(
  options: BackgroundProviderRegistrationOptions,
): void {
  const { runtime, requestRender, restoreSavedModel, systemMessageRouter } = options;

  autoRegisterProviders();

  const persisted = loadPersistedProviders();
  if (persisted.length > 0) {
    try {
      providerRegistry.registerDiscoveredProviders(persisted);
      restoreSavedModel(
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
        error: err instanceof Error ? err.message : String(err),
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
          configManager.get('provider.model') as string,
          configManager.get('provider.provider') as string,
          runtime,
        );
      } catch (err) {
        logger.debug('[bootstrap] Non-fatal error during scan provider registration', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const server of newServers) {
      systemMessageRouter.low(
        `[Scan] Found ${server.name} at ${server.host}:${server.port} (${server.models.length} model${server.models.length !== 1 ? 's' : ''})`,
      );
    }

    if (result.servers.length > 0 && removedServers.length > 0) {
      removePersistedProviders(removedServers);
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
              error: err instanceof Error ? err.message : String(err),
            });
          }
          systemMessageRouter.high(
            `[Scan] Active model was on ${server.name} — switched to openrouter/free`,
          );
        }
      }
    }

    if (result.servers.length > 0) {
      persistProviders(result.servers);
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
};

export function scheduleMcpAutodiscovery(options: McpAutodiscoveryOptions): void {
  const { mcpRegistry, systemMessageRouter, requestRender } = options;

  mcpRegistry.connectAll(getWorkingDirectory()).catch((err) => {
    logger.debug('MCP auto-connect failed (non-fatal)', { error: String(err) });
  });

  setTimeout(() => {
    const workDir = getWorkingDirectory();
    const registeredNames = new Set(mcpRegistry.serverNames);
    scanMcpServers(workDir, registeredNames).then((result) => {
      if (result.suggestions.length === 0) return;
      for (const suggestion of result.suggestions) {
        systemMessageRouter.low(
          `[MCP] Discovered server '${suggestion.name}' (${suggestion.command} ${(suggestion.args ?? []).join(' ')}). Add it to .goodvibes/mcp.json or ~/.config/mcp/mcp.json to enable it.`,
        );
      }
      requestRender();
    }).catch((err) => {
      logger.debug('MCP auto-discovery scan failed (non-fatal)', { error: String(err) });
    });
  }, 2000);
}
