/**
 * Communication domain state — structured agent-to-agent and operator-to-agent messaging.
 */

import type { CommunicationKind, CommunicationScope } from '../../events/communication.ts';

export interface RuntimeCommunicationRecord {
  id: string;
  fromId: string;
  toId: string;
  scope: CommunicationScope;
  kind: CommunicationKind;
  content: string;
  timestamp: number;
  status: 'sent' | 'delivered' | 'blocked';
  fromRole?: string;
  toRole?: string;
  cohort?: string;
  wrfcId?: string;
  parentAgentId?: string;
  reason?: string;
}

export interface CommunicationDomainState {
  revision: number;
  lastUpdatedAt: number;
  source: string;
  records: Map<string, RuntimeCommunicationRecord>;
  recentRecordIds: string[];
  totalSent: number;
  totalDelivered: number;
  totalBlocked: number;
}

export function createInitialCommunicationState(): CommunicationDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    records: new Map(),
    recentRecordIds: [],
    totalSent: 0,
    totalDelivered: 0,
    totalBlocked: 0,
  };
}
