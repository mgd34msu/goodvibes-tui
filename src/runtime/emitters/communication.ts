/**
 * Communication emitters — typed emission wrappers for communication domain.
 */
import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '../events/index.ts';
import type { EmitterContext } from './index.ts';
import type { CommunicationKind, CommunicationScope } from '@pellux/goodvibes-sdk/platform/runtime/events/communication';

type BaseCommunication = {
  messageId: string;
  fromId: string;
  toId: string;
  scope: CommunicationScope;
  kind: CommunicationKind;
};

export function emitCommunicationSent(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: BaseCommunication & {
    content: string;
    fromRole?: string;
    toRole?: string;
    cohort?: string;
    wrfcId?: string;
    parentAgentId?: string;
  },
): void {
  bus.emit('communication', createEventEnvelope('COMMUNICATION_SENT', { type: 'COMMUNICATION_SENT', ...data }, ctx));
}

export function emitCommunicationDelivered(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: BaseCommunication,
): void {
  bus.emit('communication', createEventEnvelope('COMMUNICATION_DELIVERED', { type: 'COMMUNICATION_DELIVERED', ...data }, ctx));
}

export function emitCommunicationBlocked(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: BaseCommunication & {
    reason: string;
    fromRole?: string;
    toRole?: string;
    cohort?: string;
    wrfcId?: string;
    parentAgentId?: string;
  },
): void {
  bus.emit('communication', createEventEnvelope('COMMUNICATION_BLOCKED', { type: 'COMMUNICATION_BLOCKED', ...data }, ctx));
}
