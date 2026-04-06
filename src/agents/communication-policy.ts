import type { CommunicationKind, CommunicationScope } from '../runtime/events/communication.ts';

export type AgentCommunicationRole =
  | 'orchestrator'
  | 'planner'
  | 'engineer'
  | 'reviewer'
  | 'fixer'
  | 'verifier'
  | 'researcher'
  | 'integrator'
  | 'general';

export interface AgentCommunicationMetadata {
  agentId: string;
  role: AgentCommunicationRole;
  parentAgentId?: string;
  cohort?: string;
  wrfcId?: string;
}

export function communicationRoleForTemplate(template?: string): AgentCommunicationRole {
  switch (template) {
    case 'engineer':
      return 'engineer';
    case 'reviewer':
      return 'reviewer';
    case 'researcher':
      return 'researcher';
    case 'general':
      return 'general';
    default:
      return 'general';
  }
}

export interface CommunicationDecision {
  allowed: boolean;
  reason?: string;
}

function isParentChild(from: AgentCommunicationMetadata, to: AgentCommunicationMetadata): boolean {
  return from.parentAgentId === to.agentId || to.parentAgentId === from.agentId;
}

function sharesCohort(from: AgentCommunicationMetadata, to: AgentCommunicationMetadata): boolean {
  return !!from.cohort && from.cohort === to.cohort;
}

function sharesWrfc(from: AgentCommunicationMetadata, to: AgentCommunicationMetadata): boolean {
  return !!from.wrfcId && from.wrfcId === to.wrfcId;
}

export function evaluateCommunicationRoute(input: {
  from: AgentCommunicationMetadata;
  to: AgentCommunicationMetadata;
  kind: CommunicationKind;
  scope: CommunicationScope;
}): CommunicationDecision {
  const { from, to, kind, scope } = input;

  if (scope === 'broadcast' && from.role !== 'orchestrator' && from.role !== 'planner') {
    return { allowed: false, reason: 'broadcast is reserved for coordinators' };
  }

  if (from.role === 'orchestrator' || from.role === 'planner') {
    return { allowed: true };
  }

  if (to.role === 'orchestrator') {
    if (['status', 'question', 'finding', 'handoff', 'escalation', 'completion'].includes(kind)) {
      return { allowed: true };
    }
    return { allowed: false, reason: 'agents may only report structured updates upward to the orchestrator' };
  }

  if (isParentChild(from, to)) {
    if (['directive', 'status', 'question', 'finding', 'handoff', 'completion', 'escalation'].includes(kind)) {
      return { allowed: true };
    }
  }

  if (sharesWrfc(from, to)) {
    if (
      (from.role === 'reviewer' && ['review', 'finding', 'directive'].includes(kind)) ||
      (from.role === 'fixer' && ['status', 'question', 'handoff', 'completion'].includes(kind)) ||
      (from.role === 'engineer' && ['status', 'question', 'handoff', 'completion'].includes(kind)) ||
      (from.role === 'verifier' && ['finding', 'escalation', 'completion'].includes(kind))
    ) {
      return { allowed: true };
    }
  }

  if (sharesCohort(from, to) && ['status', 'question', 'finding', 'handoff'].includes(kind)) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'communication route is outside the allowed role and topology policy' };
}
