/**
 * CommunicationEvent — typed runtime events for structured agent communication.
 */

export type CommunicationKind =
  | 'directive'
  | 'status'
  | 'question'
  | 'finding'
  | 'review'
  | 'handoff'
  | 'escalation'
  | 'completion';

export type CommunicationScope = 'direct' | 'broadcast';

export type CommunicationEvent =
  | {
      type: 'COMMUNICATION_SENT';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
      content: string;
      fromRole?: string;
      toRole?: string;
      cohort?: string;
      wrfcId?: string;
      parentAgentId?: string;
    }
  | {
      type: 'COMMUNICATION_DELIVERED';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
    }
  | {
      type: 'COMMUNICATION_BLOCKED';
      messageId: string;
      fromId: string;
      toId: string;
      scope: CommunicationScope;
      kind: CommunicationKind;
      reason: string;
      fromRole?: string;
      toRole?: string;
      cohort?: string;
      wrfcId?: string;
      parentAgentId?: string;
    };

export type CommunicationEventType = CommunicationEvent['type'];
