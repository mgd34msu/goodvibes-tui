import type { PartialToolCall } from '../../../../providers/interface.ts';
import type { ConversationDomainState } from '../../domains/conversation.ts';

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function now(): number {
  return Date.now();
}

export function updateDomainMetadata<T extends { revision: number; lastUpdatedAt: number; source: string }>(
  domain: T,
  source: string,
): T {
  return {
    ...domain,
    revision: domain.revision + 1,
    lastUpdatedAt: now(),
    source,
  };
}

export function isTerminalTurnState(state: ConversationDomainState['turnState']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function canStartNewTurn(domain: ConversationDomainState): boolean {
  return domain.turnState === 'idle' || isTerminalTurnState(domain.turnState);
}

export function isCurrentTurnEvent(domain: ConversationDomainState, turnId: string): boolean {
  return domain.currentTurnId !== undefined && domain.currentTurnId === turnId;
}

export function formatPartialToolPreview(toolCalls?: PartialToolCall[]): string | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const last = toolCalls[toolCalls.length - 1] as { name?: unknown; arguments?: unknown };
  const name = typeof last.name === 'string' ? last.name : '';
  const args =
    typeof last.arguments === 'string'
      ? last.arguments
      : last.arguments !== undefined
        ? JSON.stringify(last.arguments)
        : '';
  if (!name) return undefined;
  const preview = args.length > 60 ? `${args.slice(0, 57)}...` : args;
  return `${name}(${preview})`;
}

export function resetStreamState(): ConversationDomainState['stream'] {
  return {
    accumulated: '',
    reasoningAccumulated: '',
    partialToolPreview: undefined,
    deltaCount: 0,
    firstDeltaAt: undefined,
    lastDeltaAt: undefined,
  };
}
