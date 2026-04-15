import type { McpEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/mcp';
import type { PluginEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/plugins';
import { endMcpSpan, recordMcpPhase, startMcpSpan } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/mcp';
import { endPluginSpan, recordPluginPhase, startPluginSpan } from '@pellux/goodvibes-sdk/platform/runtime/telemetry/spans/plugin';
import type { DomainBridgeAttachmentInput, Env, SpanMap } from './domain-bridge-shared.ts';

export function attachPluginDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  pluginSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('PLUGIN_DISCOVERED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_DISCOVERED' }>>) => {
      helpers.safe(() => {
        const span = startPluginSpan(helpers.tracer, {
          pluginId: env.payload.pluginId,
          path: env.payload.path,
          version: env.payload.version,
          traceId: env.traceId,
        });
        pluginSpans.set(env.payload.pluginId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_LOADING', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_LOADING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(pluginSpans, env.payload.pluginId, (span) => recordPluginPhase(span, 'loading'));
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_LOADED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_LOADED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(pluginSpans, env.payload.pluginId, (span) => {
          recordPluginPhase(span, 'loaded', {
            'plugin.capability_count': env.payload.capabilities.length,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_ACTIVE', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_ACTIVE' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(pluginSpans, env.payload.pluginId, (span) => recordPluginPhase(span, 'active'));
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_DEGRADED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_DEGRADED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(pluginSpans, env.payload.pluginId, (span) => {
          recordPluginPhase(span, 'degraded', {
            'plugin.degraded_reason': env.payload.reason,
            'plugin.affected_capability_count': env.payload.affectedCapabilities.length,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_ERROR', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_ERROR' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(pluginSpans, env.payload.pluginId, (span) => {
          endPluginSpan(span, {
            outcome: 'error',
            error: env.payload.error,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_UNLOADING', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_UNLOADING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(pluginSpans, env.payload.pluginId, (span) => recordPluginPhase(span, 'unloading'));
      });
    }),
  );

  unsubs.push(
    bus.on('PLUGIN_DISABLED', (env: Env<Extract<PluginEvent, { type: 'PLUGIN_DISABLED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(pluginSpans, env.payload.pluginId, (span) => {
          endPluginSpan(span, {
            outcome: 'disabled',
            reason: env.payload.reason,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}

export function attachMcpDomain(
  { bus, helpers }: DomainBridgeAttachmentInput,
  mcpSpans: SpanMap,
): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    bus.on('MCP_CONFIGURED', (env: Env<Extract<McpEvent, { type: 'MCP_CONFIGURED' }>>) => {
      helpers.safe(() => {
        const span = startMcpSpan(helpers.tracer, {
          serverId: env.payload.serverId,
          transport: env.payload.transport,
          url: env.payload.url,
          traceId: env.traceId,
        });
        mcpSpans.set(env.payload.serverId, span);
      });
    }),
  );

  unsubs.push(
    bus.on('MCP_CONNECTING', (env: Env<Extract<McpEvent, { type: 'MCP_CONNECTING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(mcpSpans, env.payload.serverId, (span) => recordMcpPhase(span, 'connecting'));
      });
    }),
  );

  unsubs.push(
    bus.on('MCP_CONNECTED', (env: Env<Extract<McpEvent, { type: 'MCP_CONNECTED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(mcpSpans, env.payload.serverId, (span) => {
          recordMcpPhase(span, 'connected', {
            'mcp.tool_count': env.payload.toolCount,
            'mcp.resource_count': env.payload.resourceCount,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('MCP_DEGRADED', (env: Env<Extract<McpEvent, { type: 'MCP_DEGRADED' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(mcpSpans, env.payload.serverId, (span) => {
          recordMcpPhase(span, 'degraded', {
            'mcp.degraded_reason': env.payload.reason,
            'mcp.available_tool_count': env.payload.availableTools.length,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('MCP_AUTH_REQUIRED', (env: Env<Extract<McpEvent, { type: 'MCP_AUTH_REQUIRED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(mcpSpans, env.payload.serverId, (span) => {
          recordMcpPhase(span, 'auth_required', {
            'mcp.auth_type': env.payload.authType,
          });
          endMcpSpan(span, { outcome: 'auth_failed' });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('MCP_RECONNECTING', (env: Env<Extract<McpEvent, { type: 'MCP_RECONNECTING' }>>) => {
      helpers.safe(() => {
        helpers.withSpan(mcpSpans, env.payload.serverId, (span) => {
          recordMcpPhase(span, 'reconnecting', {
            'mcp.reconnect_attempt': env.payload.attempt,
            'mcp.reconnect_max_attempts': env.payload.maxAttempts,
          });
        });
      });
    }),
  );

  unsubs.push(
    bus.on('MCP_DISCONNECTED', (env: Env<Extract<McpEvent, { type: 'MCP_DISCONNECTED' }>>) => {
      helpers.safe(() => {
        helpers.closeSpan(mcpSpans, env.payload.serverId, (span) => {
          endMcpSpan(span, {
            outcome: 'disconnected',
            reason: env.payload.reason,
            willRetry: env.payload.willRetry,
          });
        });
      });
    }),
  );

  return () => unsubs.forEach((unsub) => unsub());
}
