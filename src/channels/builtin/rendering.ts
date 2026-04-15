import type { AutomationRouteBinding } from '@pellux/goodvibes-sdk/platform/automation/routes';
import type { SharedApprovalRecord } from '../../control-plane/index.ts';
import type { Tool } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ChannelDeliveryRouteBinding } from '../delivery-router.ts';
import type { ChannelDeliveryRequest } from '../delivery/types.ts';
import type {
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelSurface,
  ChannelToolDescriptor,
} from '@pellux/goodvibes-sdk/platform/channels/types';
import type { BuiltinChannelRuntimeDeps } from './shared.ts';

interface BuiltinRenderingContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly listTools: (surface: ChannelSurface) => ChannelToolDescriptor[];
  readonly runTool: (surface: ChannelSurface, toolId: string, input?: Record<string, unknown>) => Promise<unknown>;
}

export async function renderBuiltinChannelEvent(
  context: BuiltinRenderingContext,
  surface: ChannelSurface,
  request: ChannelRenderRequest,
): Promise<ChannelRenderResult> {
  const router = context.deps.deliveryRouter;
  const binding = request.routeId ? context.deps.routeBindings.getBinding(request.routeId) : undefined;
  const responseId = await router.deliver({
    target: buildDeliveryTarget(surface, request, binding),
    body: request.text,
    title: request.title,
    jobId: binding?.jobId ?? request.routeId ?? `channel:${surface}`,
    runId: binding?.runId ?? request.agentId ?? request.sessionId ?? `${surface}:${Date.now()}`,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    status: renderStatus(request),
    includeLinks: request.phase !== 'progress',
    ...(binding ? { binding: toDeliveryRouteBinding(binding) } : {}),
  });
  return {
    delivered: true,
    ...(responseId ? { responseId } : {}),
    ...(binding?.threadId ? { threadId: binding.threadId } : {}),
    metadata: {
      surface,
      phase: request.phase,
      via: 'channel-delivery-router',
    },
  };
}

export async function notifyBuiltinApprovalViaRouter(
  context: BuiltinRenderingContext,
  surface: ChannelSurface,
  approval: SharedApprovalRecord,
  binding: AutomationRouteBinding,
): Promise<void> {
  const router = context.deps.deliveryRouter;
  const status = approval.status === 'approved'
    ? 'completed'
    : approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired'
      ? 'failed'
      : 'running';
  await router.deliver({
    target: buildDeliveryTarget(surface, { pending: {} }, binding),
    body: formatApprovalMessage(approval),
    title: `Approval ${approval.status}: ${approval.request.tool}`,
    jobId: binding.jobId ?? `approval:${approval.id}`,
    runId: binding.runId ?? approval.id,
    status,
    includeLinks: true,
    binding: toDeliveryRouteBinding(binding),
  });
}

export function listBuiltinAgentTools(
  context: BuiltinRenderingContext,
  surface: ChannelSurface,
): readonly Tool[] {
  return context.listTools(surface).map((descriptor): Tool => ({
    definition: {
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.inputSchema ?? {
        type: 'object',
        additionalProperties: true,
      },
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
    },
    execute: async (args) => {
      const result = await context.runTool(surface, descriptor.id, args);
      if (result === null) {
        return {
          success: false,
          error: `Unknown channel tool '${descriptor.id}' for surface '${surface}'.`,
        };
      }
      return {
        success: true,
        output: JSON.stringify({ surface, toolId: descriptor.id, result }, null, 2),
      };
    },
  }));
}

function buildDeliveryTarget(
  surface: ChannelSurface,
  request: { readonly pending?: Record<string, unknown> },
  binding?: AutomationRouteBinding,
): ChannelDeliveryRequest['target'] {
  const pending = request.pending ?? {};
  const address = surface === 'webhook'
    ? readPendingString(pending, 'callbackUrl')
      ?? readMetadataString(binding?.metadata, 'callbackUrl')
    : readPendingString(pending, 'targetAddress')
      ?? readPendingString(pending, 'responseUrl')
      ?? readPendingString(pending, 'channelId')
      ?? readPendingString(pending, 'topic')
      ?? binding?.channelId
      ?? binding?.externalId;
  if (surface === 'webhook') {
    return {
      kind: 'webhook',
      surfaceKind: 'webhook',
      ...(address ? { address } : {}),
    };
  }
  return {
    kind: 'surface',
    surfaceKind: surface,
    ...(address ? { address } : {}),
  };
}

function toDeliveryRouteBinding(binding: AutomationRouteBinding): ChannelDeliveryRouteBinding {
  return {
    id: binding.id,
    surfaceKind: binding.surfaceKind,
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    ...(binding.channelId ? { channelId: binding.channelId } : {}),
    ...(binding.title ? { title: binding.title } : {}),
    metadata: { ...binding.metadata },
  };
}

function renderStatus(request: ChannelRenderRequest): string {
  if (request.events.some((event) => event.kind === 'error')) return 'failed';
  if (request.phase === 'final') return 'completed';
  if (request.phase === 'approval') return 'running';
  return 'running';
}

function formatApprovalMessage(approval: SharedApprovalRecord): string {
  const lines = [
    `Approval ${approval.status}: ${approval.id}`,
    `Tool: ${approval.request.tool}`,
    approval.request.analysis.summary,
    approval.request.analysis.target ? `Target: ${approval.request.analysis.target}` : '',
    approval.resolvedBy ? `Resolved by: ${approval.resolvedBy}` : '',
  ].filter((line) => line.trim().length > 0);
  return lines.join('\n');
}

function readPendingString(pending: Record<string, unknown>, key: string): string | undefined {
  const value = pending[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!metadata) return undefined;
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
