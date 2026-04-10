import type { CommandRegistry, SlashCommand } from '../input/command-registry.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolDefinition } from '../types/tools.ts';
import type { RuntimeEventBus, AnyRuntimeEvent, RuntimeEventPayload } from '../runtime/events/index.ts';
import { GatewayMethodCatalog, type GatewayMethodDescriptor, type GatewayMethodHandler } from '../control-plane/index.ts';
import {
  ChannelDeliveryRouter,
  ChannelPluginRegistry,
  type ChannelDeliveryStrategy,
  type ChannelPlugin,
} from '../channels/index.ts';
import { MemoryEmbeddingProviderRegistry, type MemoryEmbeddingProvider } from '../state/index.ts';
import { VoiceProviderRegistry, type VoiceProvider } from '../voice/index.ts';
import { MediaProviderRegistry, type MediaProvider } from '../media/index.ts';
import { logger } from '../utils/logger.ts';

/**
 * PluginProviderConfig — minimal config for registering a custom LLM provider
 * via an OpenAI-compatible endpoint.
 */
export interface PluginProviderConfig {
  /** Base URL for an OpenAI-compatible endpoint (e.g. "http://localhost:8080/v1"). */
  baseURL: string;
  /** API key. May be empty string for local/unauthenticated servers. */
  apiKey?: string;
  /** Model IDs this provider exposes. */
  models: string[];
  /** Optional display label shown in the model picker. */
  displayName?: string;
}

/**
 * PluginToolSchema — JSON Schema for a tool parameter object.
 */
export type PluginToolSchema = Record<string, unknown>;

/**
 * PluginToolHandler — Called when the LLM invokes a plugin-registered tool.
 */
export type PluginToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ success: boolean; output?: string; error?: string }>;

/**
 * PluginCommandHandler — Called when a user runs a plugin-registered slash command.
 */
export type PluginCommandHandler = (args: string[]) => void | Promise<void>;

/**
 * PluginAPI — The constrained API surface exposed to plugins.
 * Plugins receive an instance of this interface during init; they cannot
 * access the wider application internals directly.
 */
export interface PluginAPI {
  /** Register a custom slash command. */
  registerCommand(
    name: string,
    description: string,
    handler: PluginCommandHandler,
  ): void;

  /** Register a custom LLM provider (OpenAI-compatible endpoint). */
  registerProvider(name: string, config: PluginProviderConfig): Promise<void>;

  /** Register a custom tool available to the LLM. */
  registerTool(
    name: string,
    schema: PluginToolSchema,
    handler: PluginToolHandler,
  ): void;

  /** Register a callable control-plane gateway method. */
  registerGatewayMethod(
    descriptor: Omit<GatewayMethodDescriptor, 'source' | 'pluginId'> & Partial<Pick<GatewayMethodDescriptor, 'source' | 'pluginId'>>,
    handler: GatewayMethodHandler,
  ): void;

  /** Register a channel plugin for a surface such as Slack, Discord, ntfy, or webhooks. */
  registerChannelPlugin(plugin: ChannelPlugin): void;

  /** Register an outbound channel delivery strategy. */
  registerDeliveryStrategy(strategy: ChannelDeliveryStrategy, options?: { readonly replace?: boolean }): void;

  /** Register a memory embedding provider. Sync providers can power sqlite-vec indexing immediately. */
  registerMemoryEmbeddingProvider(provider: MemoryEmbeddingProvider, options?: { readonly replace?: boolean; readonly makeDefault?: boolean }): void;

  /** Register a TS-only voice provider for TTS, STT, or realtime session negotiation. */
  registerVoiceProvider(provider: VoiceProvider, options?: { readonly replace?: boolean }): void;

  /** Register a TS-only media provider for analysis, transform, or generation. */
  registerMediaProvider(provider: MediaProvider, options?: { readonly replace?: boolean }): void;

  /** Subscribe to a typed runtime event. Returns an unsubscribe function. */
  onEvent<K extends AnyRuntimeEvent['type']>(
    eventName: K,
    handler: (payload: RuntimeEventPayload<K>) => void,
  ): () => void;

  /** Read a plugin-specific config value from the plugin's stored settings. */
  getConfig(key: string): unknown;

  /** Emit structured log output to the application logger. */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
}

/**
 * PluginAPIContext — Internal dependencies passed when creating a PluginAPI instance.
 * Not exposed to plugins.
 */
export interface PluginAPIContext {
  pluginName: string;
  runtimeBus: RuntimeEventBus;
  commandRegistry: CommandRegistry;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  /** Plugin-specific config key-value pairs from plugins.json state. */
  pluginConfig: Record<string, unknown>;
  /** Collect cleanup callbacks so the manager can teardown on disable/reload. */
  cleanup: Array<() => void>;
}

/**
 * createPluginAPI — Factory that creates a sandboxed PluginAPI for a single plugin.
 * All registrations are tracked in `ctx.cleanup` so they can be undone on deactivation.
 */
export function createPluginAPI(ctx: PluginAPIContext): PluginAPI {
  return {
    registerCommand(name, description, handler) {
      // Namespace commands to avoid collisions: "plugin-<pluginName>-<name>"
      const cmdName = `plugin-${ctx.pluginName}-${name}`;
      const cmd: SlashCommand = {
        name: cmdName,
        description: `[${ctx.pluginName}] ${description}`,
        handler: async (args, _context) => {
          try {
            await handler(args);
          } catch (err) {
            logger.error(`[plugin:${ctx.pluginName}] Command '${name}' threw: ${String(err)}`);
          }
        },
      };
      ctx.commandRegistry.register(cmd);
      ctx.cleanup.push(() => ctx.commandRegistry.unregister(cmdName));
    },

    async registerProvider(name, config) {
      // Dynamically import to avoid circular dependency at module load time.
      try {
        const { OpenAICompatProvider } = await import('../providers/openai-compat.ts');
        try {
          const provider = new OpenAICompatProvider({
            name,
            baseURL: config.baseURL,
            apiKey: config.apiKey ?? '',
            defaultModel: config.models[0] ?? '',
            models: config.models,
          });
          ctx.providerRegistry.register(provider);
          logger.info(`[plugin:${ctx.pluginName}] Registered provider '${name}' with ${config.models.length} model(s)`);
          // Note: ProviderRegistry.register() has no unregister equivalent.
          // Plugin providers persist until process restart — same as built-in providers.
          logger.warn(`[plugin:${ctx.pluginName}] Provider '${name}' cannot be unregistered on deactivate — it persists until process restart`);
        } catch (err) {
          logger.error(`[plugin:${ctx.pluginName}] registerProvider '${name}' failed: ${String(err)}`);
          throw err;
        }
      } catch (err) {
        logger.error(`[plugin:${ctx.pluginName}] Could not import OpenAICompatProvider: ${String(err)}`);
        throw err;
      }
    },

    registerTool(name, schema, handler) {
      const toolName = `plugin_${ctx.pluginName}_${name}`;
      if (ctx.toolRegistry.has(toolName)) {
        logger.warn(`[plugin:${ctx.pluginName}] Tool '${toolName}' already registered — skipping`);
        return;
      }
      const definition: ToolDefinition = {
        name: toolName,
        description: (schema.description as string) ?? `Plugin tool: ${name}`,
        parameters: schema,
      };
      ctx.toolRegistry.register({
        definition,
        execute: async (args) => {
          try {
            return await handler(args);
          } catch (err) {
            return { success: false, error: String(err) };
          }
        },
      });
      // ToolRegistry has no unregister method. Track for cleanup awareness.
      ctx.cleanup.push(() => {
        logger.warn(`[plugin:${ctx.pluginName}] Tool '${toolName}' cannot be unregistered on deactivate — it persists until process restart`);
      });
    },

    registerGatewayMethod(descriptor, handler) {
      const catalog = GatewayMethodCatalog.getActive();
      const methodId = descriptor.id.startsWith(`plugin.${ctx.pluginName}.`)
        ? descriptor.id
        : `plugin.${ctx.pluginName}.${descriptor.id}`;
      const unregister = catalog.register({
        ...descriptor,
        id: methodId,
        source: 'plugin',
        pluginId: ctx.pluginName,
      }, handler);
      ctx.cleanup.push(unregister);
      logger.info(`[plugin:${ctx.pluginName}] Registered gateway method '${methodId}'`);
    },

    registerChannelPlugin(plugin) {
      const registry = ChannelPluginRegistry.getActive();
      if (!registry) throw new Error('Channel plugin registry is not active');
      registry.register(plugin);
      ctx.cleanup.push(() => {
        if (registry.get(plugin.id) === plugin) registry.unregister(plugin.id);
      });
      logger.info(`[plugin:${ctx.pluginName}] Registered channel plugin '${plugin.id}'`);
    },

    registerDeliveryStrategy(strategy, options = {}) {
      const router = ChannelDeliveryRouter.getActive();
      if (!router) throw new Error('Channel delivery router is not active');
      router.registerStrategy(strategy, options);
      ctx.cleanup.push(() => {
        router.unregisterStrategy(strategy.id);
      });
      logger.info(`[plugin:${ctx.pluginName}] Registered delivery strategy '${strategy.id}'`);
    },

    registerMemoryEmbeddingProvider(provider, options = {}) {
      const unregister = MemoryEmbeddingProviderRegistry.getActive().register(provider, options);
      ctx.cleanup.push(unregister);
      logger.info(`[plugin:${ctx.pluginName}] Registered memory embedding provider '${provider.id}'`);
    },

    registerVoiceProvider(provider, options = {}) {
      const unregister = VoiceProviderRegistry.getActive().register(provider, options);
      ctx.cleanup.push(unregister);
      logger.info(`[plugin:${ctx.pluginName}] Registered voice provider '${provider.id}'`);
    },

    registerMediaProvider(provider, options = {}) {
      const unregister = MediaProviderRegistry.getActive().register(provider, options);
      ctx.cleanup.push(unregister);
      logger.info(`[plugin:${ctx.pluginName}] Registered media provider '${provider.id}'`);
    },

    onEvent(eventName, handler) {
      const unsub = ctx.runtimeBus.on(
        eventName,
        (envelope) => handler(envelope.payload as RuntimeEventPayload<typeof eventName>),
      );
      ctx.cleanup.push(unsub);
      return unsub;
    },

    getConfig(key) {
      return ctx.pluginConfig[key];
    },

    log(level, message) {
      logger[level](`[plugin:${ctx.pluginName}] ${message}`);
    },
  };
}
