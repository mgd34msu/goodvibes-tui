import type { ConfigManager } from '../config/manager.ts';
import type { ServiceRegistry } from '../config/service-registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { MutableRuntimeState } from './context.ts';
import type { IntegrationRecord } from './store/domains/integrations.ts';
import { logger } from '../utils/logger.ts';
import { loadSystemPrompt as _loadSystemPrompt } from '../utils/prompt-loader.ts';

export function loadBootstrapSystemPrompt(configManager: ConfigManager): string {
  return _loadSystemPrompt(
    () => configManager.get('provider.systemPromptFile') as string | undefined,
  );
}

export async function syncConfiguredServices(
  syncIntegration: (record: IntegrationRecord, source?: string) => void,
  serviceRegistry: ServiceRegistry,
): Promise<void> {
  const services = serviceRegistry.getAll();
  await Promise.all(
    Object.entries(services).map(async ([id, config]) => {
      const inspection = await serviceRegistry.inspect(id);
      if (!inspection) return;
      syncIntegration({
        id,
        displayName: config.name || id,
        category: 'custom',
        status: inspection.hasPrimaryCredential ? 'healthy' : 'unconfigured',
        enabled: true,
        successCount: 0,
        errorCount: 0,
        meta: {
          authType: config.authType,
          baseUrl: config.baseUrl ?? null,
          hasPrimaryCredential: inspection.hasPrimaryCredential,
          hasWebhookUrl: inspection.hasWebhookUrl,
          hasSigningSecret: inspection.hasSigningSecret,
          hasPublicKey: inspection.hasPublicKey,
        },
      }, 'bootstrap.services');
    }),
  );
}

export function restoreSavedModel(
  providerRegistry: ProviderRegistry,
  savedModel: string,
  savedProvider: string,
  runtime: MutableRuntimeState,
): void {
  const registry = providerRegistry.listModels();
  const modelDef = savedModel.includes(':')
    ? (registry.find((m) => m.registryKey === savedModel) ?? registry.find((m) => m.id === savedModel))
    : registry.find((m) => m.id === savedModel && (!savedProvider || m.provider === savedProvider))
      ?? registry.find((m) => m.id === savedModel);
  if (!modelDef) return;
  try {
    const key = modelDef.registryKey ?? `${modelDef.provider}:${modelDef.id}`;
    providerRegistry.setCurrentModel(key);
    runtime.model = key;
    runtime.provider = modelDef.provider;
  } catch (err) {
    logger.debug('Model restore failed (non-fatal)', { error: String(err) });
  }
}
