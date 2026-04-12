import type { TurnEvent } from '../../../events/turn.ts';
import type { ToolEvent } from '../../../events/tools.ts';
import type { ConversationDomainState, ActiveToolCall, ToolExecutionState } from '../../domains/conversation.ts';
import { canStartNewTurn, formatPartialToolPreview, isCurrentTurnEvent, isTerminalTurnState, now, resetStreamState, updateDomainMetadata } from './shared.ts';

function formatToolArgs(event: ToolEvent | TurnEvent): string {
  if ('args' in event) {
    return JSON.stringify(event.args);
  }
  return '{}';
}

export function updateConversationState(
  domain: ConversationDomainState,
  event: TurnEvent | ToolEvent,
): ConversationDomainState {
  const source = event.type;
  if ('callId' in event) {
    if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) {
      return domain;
    }
    const activeToolCalls = new Map(domain.activeToolCalls);
    const existing = activeToolCalls.get(event.callId);
    const stateByEvent: Partial<Record<ToolEvent['type'], ToolExecutionState>> = {
      TOOL_RECEIVED: 'received',
      TOOL_VALIDATED: 'validated',
      TOOL_PREHOOKED: 'prehooked',
      TOOL_PERMISSIONED: 'permissioned',
      TOOL_EXECUTING: 'executing',
      TOOL_MAPPED: 'mapped',
      TOOL_POSTHOOKED: 'posthooked',
      TOOL_SUCCEEDED: 'succeeded',
      TOOL_FAILED: 'failed',
      TOOL_CANCELLED: 'cancelled',
      BUDGET_EXCEEDED_MS: 'failed',
      BUDGET_EXCEEDED_TOKENS: 'failed',
      BUDGET_EXCEEDED_COST: 'failed',
    };
    const nextState = stateByEvent[event.type];
    const timestamp = now();
    const nextRecord: ActiveToolCall = {
      callId: event.callId,
      toolName: event.tool,
      args: existing?.args ?? formatToolArgs(event),
      state: nextState ?? existing?.state ?? 'received',
      stateEnteredAt: 'startedAt' in event ? event.startedAt : timestamp,
      phaseTimestamps: {
        ...(existing?.phaseTimestamps ?? {}),
        ...(nextState ? { [nextState]: timestamp } : {}),
      },
      error:
        'error' in event
          ? event.error
          : event.type === 'BUDGET_EXCEEDED_MS'
            ? `${event.phase} exceeded ${event.limitMs}ms budget`
            : event.type === 'BUDGET_EXCEEDED_TOKENS'
              ? `${event.phase} exceeded ${event.limitTokens} token budget`
              : event.type === 'BUDGET_EXCEEDED_COST'
                ? `${event.phase} exceeded $${event.limitCostUsd} cost budget`
                : existing?.error,
    };
    activeToolCalls.set(event.callId, nextRecord);
    return {
      ...updateDomainMetadata(domain, source),
      activeToolCalls,
      currentTurnId: domain.currentTurnId ?? event.turnId,
      toolCallsThisTurn: event.type === 'TOOL_RECEIVED' ? domain.toolCallsThisTurn + 1 : domain.toolCallsThisTurn,
    };
  }

  switch (event.type) {
    case 'TURN_SUBMITTED':
      if (!canStartNewTurn(domain)) return domain;
      return {
        ...updateDomainMetadata(domain, source),
        turnState: 'preflight',
        currentTurnId: event.turnId,
        turnStartedAt: now(),
        turnEndedAt: undefined,
        lastTurnError: undefined,
        lastTurnStopReason: undefined,
        lastTurnResponse: undefined,
        lastPreflightFailure: undefined,
        stream: resetStreamState(),
        activeToolCalls: new Map(),
        toolCallsThisTurn: 0,
        lastToolReconciliation: undefined,
      };
    case 'PREFLIGHT_OK':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'preflight') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'preflight',
      };
    case 'PREFLIGHT_FAIL':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'preflight') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'failed',
        turnEndedAt: now(),
        lastTurnError: event.reason,
        lastTurnStopReason: event.stopReason,
        lastPreflightFailure: event.reason,
        stream: resetStreamState(),
      };
    case 'STREAM_START':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'preflight') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'streaming',
        stream: resetStreamState(),
      };
    case 'STREAM_DELTA':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'streaming') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'streaming',
        stream: {
          accumulated: event.accumulated,
          reasoningAccumulated: `${domain.stream.reasoningAccumulated}${event.reasoning ?? ''}`,
          partialToolPreview: formatPartialToolPreview(event.toolCalls),
          deltaCount: domain.stream.deltaCount + 1,
          firstDeltaAt: domain.stream.firstDeltaAt ?? now(),
          lastDeltaAt: now(),
        },
      };
    case 'STREAM_END':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'streaming') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    case 'LLM_RESPONSE_RECEIVED':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
      };
    case 'TOOL_BATCH_READY':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'tool_dispatch') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'post_hooks',
      };
    case 'TOOLS_DONE':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'tool_dispatch') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'post_hooks',
      };
    case 'POST_HOOKS_DONE':
      if (!isCurrentTurnEvent(domain, event.turnId) || domain.turnState !== 'post_hooks') return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'post_hooks',
      };
    case 'TOOL_RECONCILED':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        lastToolReconciliation: {
          count: event.count,
          callIds: [...event.callIds],
          toolNames: [...event.toolNames],
          reason: event.reason,
          timestamp: event.timestamp,
          isMalformed: event.isMalformed ?? false,
        },
      };
    case 'TURN_COMPLETED':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'completed',
        turnEndedAt: now(),
        totalTurns: domain.totalTurns + 1,
        lastTurnResponse: event.response,
        lastTurnStopReason: event.stopReason,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    case 'TURN_ERROR':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'failed',
        turnEndedAt: now(),
        lastTurnError: event.error,
        lastTurnStopReason: event.stopReason,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    case 'TURN_CANCEL':
      if (!isCurrentTurnEvent(domain, event.turnId) || isTerminalTurnState(domain.turnState)) return domain;
      return {
        ...updateDomainMetadata(domain, source),
        currentTurnId: event.turnId,
        turnState: 'cancelled',
        turnEndedAt: now(),
        lastTurnError: event.reason,
        lastTurnStopReason: event.stopReason,
        stream: {
          ...domain.stream,
          partialToolPreview: undefined,
        },
      };
    default:
      return updateDomainMetadata(domain, source);
  }
}
