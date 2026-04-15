import type { ConversationMessageSnapshot, ConversationTitleSource } from '../core/conversation';
import type { HelperModel } from '@pellux/goodvibes-sdk/platform/config/helper-model';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

export type ReturnContextMode = 'off' | 'local' | 'assisted';

export interface SessionContinuityHints {
  readonly pendingApprovals?: number;
  readonly activeTasks?: number;
  readonly blockedTasks?: number;
  readonly remoteContracts?: number;
  readonly remoteRunners?: readonly string[];
  readonly worktreeCount?: number;
  readonly worktreePaths?: readonly string[];
  readonly openPanels?: readonly string[];
}

export interface SessionReturnContextSummary {
  readonly activityLabel: string;
  readonly statusLabel: string;
  readonly lastUserPrompt?: string;
  readonly lastAssistantReply?: string;
  readonly pendingApprovals: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly assistantTurnCount: number;
  readonly userTurnCount: number;
  readonly lastRole?: string;
  readonly activeTasks?: number;
  readonly blockedTasks?: number;
  readonly remoteContracts?: number;
  readonly remoteRunners?: readonly string[];
  readonly worktreeCount?: number;
  readonly worktreePaths?: readonly string[];
  readonly openPanels?: readonly string[];
  readonly lines: readonly string[];
  readonly assistedNarrative?: string;
}

export interface PersistedSessionContext {
  readonly titleSource?: ConversationTitleSource;
  readonly returnContext?: SessionReturnContextSummary;
}

type ReturnContextConfig = Pick<ConfigManager, 'get'>;

export function buildPersistedSessionContext(
  messages: readonly ConversationMessageSnapshot[],
  titleSource?: ConversationTitleSource,
  hints?: SessionContinuityHints,
): PersistedSessionContext {
  return {
    titleSource,
    returnContext: buildLocalReturnContextSummary(messages, hints),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function textContent(message: ConversationMessageSnapshot | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

export function getReturnContextMode(configManager: ReturnContextConfig): ReturnContextMode {
  return (configManager.get('behavior.returnContextMode') as ReturnContextMode | undefined) ?? 'off';
}

export function buildLocalReturnContextSummary(
  messages: readonly ConversationMessageSnapshot[],
  hints?: SessionContinuityHints,
): SessionReturnContextSummary {
  const userMessages = messages.filter((message) => message.role === 'user');
  const assistantMessages = messages.filter((message) => message.role === 'assistant');
  const toolMessages = messages.filter((message) => message.role === 'tool');
  const pendingApprovals = hints?.pendingApprovals
    ?? messages.filter((message) => message.role === 'system' && typeof message.content === 'string' && /approval/i.test(message.content)).length;
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const lastMessage = messages[messages.length - 1];

  const lastUserPrompt = truncate(textContent(lastUser), 120);
  const lastAssistantReply = truncate(textContent(lastAssistant), 120);

  let activityLabel = 'Fresh session';
  let statusLabel = 'idle';
  if (lastMessage?.role === 'assistant') {
    activityLabel = 'assistant replied';
    statusLabel = 'ready for next turn';
  } else if (lastMessage?.role === 'tool') {
    activityLabel = 'tool work completed';
    statusLabel = 'awaiting assistant follow-up';
  } else if (lastMessage?.role === 'user') {
    activityLabel = 'user prompt queued';
    statusLabel = 'awaiting response';
  } else if (lastMessage?.role === 'system') {
    activityLabel = 'system/operator update';
    statusLabel = 'review recommended';
  }

  const lines: string[] = [];
  lines.push(`Activity: ${activityLabel}`);
  lines.push(`Status: ${statusLabel}`);
  if (lastUserPrompt) lines.push(`Last prompt: ${lastUserPrompt}`);
  if (lastAssistantReply) lines.push(`Last reply: ${lastAssistantReply}`);
  if (pendingApprovals > 0) lines.push(`Pending approvals spotted: ${pendingApprovals}`);
  if (toolMessages.length > 0) lines.push(`Tool results in session: ${toolMessages.length}`);
  if ((hints?.activeTasks ?? 0) > 0 || (hints?.blockedTasks ?? 0) > 0) {
    lines.push(`Tasks: active ${hints?.activeTasks ?? 0}, blocked ${hints?.blockedTasks ?? 0}`);
  }
  if ((hints?.remoteContracts ?? 0) > 0) {
    lines.push(`Remote contracts: ${hints?.remoteContracts}`);
  }
  if ((hints?.remoteRunners?.length ?? 0) > 0) {
    lines.push(`Remote runners: ${hints!.remoteRunners!.slice(0, 3).join(', ')}`);
  }
  if ((hints?.worktreeCount ?? 0) > 0) {
    lines.push(`Worktrees tracked: ${hints?.worktreeCount}`);
  }
  if ((hints?.worktreePaths?.length ?? 0) > 0) {
    lines.push(`Worktree paths: ${hints!.worktreePaths!.slice(0, 2).join(', ')}`);
  }
  if ((hints?.openPanels?.length ?? 0) > 0) {
    lines.push(`Open panels: ${hints!.openPanels!.slice(0, 4).join(', ')}`);
  }

  return {
    activityLabel,
    statusLabel,
    lastUserPrompt: lastUserPrompt || undefined,
    lastAssistantReply: lastAssistantReply || undefined,
    pendingApprovals,
    toolCallCount: assistantMessages.reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0),
    toolResultCount: toolMessages.length,
    assistantTurnCount: assistantMessages.length,
    userTurnCount: userMessages.length,
    lastRole: lastMessage?.role,
    ...(typeof hints?.activeTasks === 'number' ? { activeTasks: hints.activeTasks } : {}),
    ...(typeof hints?.blockedTasks === 'number' ? { blockedTasks: hints.blockedTasks } : {}),
    ...(typeof hints?.remoteContracts === 'number' ? { remoteContracts: hints.remoteContracts } : {}),
    ...(hints?.remoteRunners ? { remoteRunners: [...hints.remoteRunners] } : {}),
    ...(typeof hints?.worktreeCount === 'number' ? { worktreeCount: hints.worktreeCount } : {}),
    ...(hints?.worktreePaths ? { worktreePaths: [...hints.worktreePaths] } : {}),
    ...(hints?.openPanels ? { openPanels: [...hints.openPanels] } : {}),
    lines,
  };
}

export async function maybeAssistReturnContextSummary(
  configManager: ReturnContextConfig,
  helperModel: Pick<HelperModel, 'chat'>,
  summary: SessionReturnContextSummary,
): Promise<SessionReturnContextSummary> {
  if (getReturnContextMode(configManager) !== 'assisted') return summary;

  const enabled = configManager.get('helper.enabled') as boolean | undefined;
  if (!enabled) return summary;

  const prompt = [
    'You are generating a terse resume summary for a terminal coding session.',
    'Return one sentence under 160 characters.',
    'Focus on what the operator should look at first.',
    '',
    `Activity: ${summary.activityLabel}`,
    `Status: ${summary.statusLabel}`,
    ...(summary.lastUserPrompt ? [`Last prompt: ${summary.lastUserPrompt}`] : []),
    ...(summary.lastAssistantReply ? [`Last reply: ${summary.lastAssistantReply}`] : []),
    `Pending approvals: ${summary.pendingApprovals}`,
    `Tool calls: ${summary.toolCallCount}`,
    `Tool results: ${summary.toolResultCount}`,
  ].join('\n');

  const response = (await helperModel.chat('tool_summarize', prompt, { maxTokens: 80, helperOnly: true })).trim();
  if (!response) return summary;
  return {
    ...summary,
    assistedNarrative: truncate(response.replace(/\s+/g, ' '), 160),
  };
}

export function formatReturnContextForDisplay(summary: SessionReturnContextSummary | undefined): string[] {
  if (!summary) return [];
  const lines = [...summary.lines];
  if (summary.assistedNarrative) {
    lines.unshift(`Assist: ${summary.assistedNarrative}`);
  }
  return lines;
}
