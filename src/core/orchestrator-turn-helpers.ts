import type { ConversationManager } from './conversation.ts';
import type { ConfigManager } from '../config/manager.ts';
import type { ContentPart, LLMProvider } from '../providers/interface.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { classifyIntent } from '@pellux/goodvibes-sdk/platform/core/intent-classifier';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import type { AdaptivePlanner } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';
import type { ExecutionPlan, PlanItem } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import type { ExecutionPlanManager } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { emitPlanStrategySelected, emitToolReconciled, emitTurnCompleted } from '../runtime/emitters/index.ts';
import { buildSyntheticResult } from '@pellux/goodvibes-sdk/platform/core/tool-reconciliation';
import { autoSpawnPendingItems } from './orchestrator-tool-runtime.ts';
import type { ToolCall, ToolResult } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { AgentManager } from '../tools/agent/index.ts';

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.ts').EmitterContext;
export type ChatResponseWithReasoning = Awaited<ReturnType<LLMProvider['chat']>> & {
  reasoning?: string;
  reasoningSummary?: string;
};

const PROJECT_PRIMING_SIGNALS = new Set([
  'parallelism_keywords',
  'multi_sentence_actions',
  'spec_plan_reference',
]);

export function maybeEmitAdaptivePlannerDecision(
  text: string,
  flagEnabled: boolean,
  adaptivePlanner: Pick<AdaptivePlanner, 'select'> | null,
  runtimeBus: RuntimeEventBus | null,
  emitterContext: EmitterContextFactory,
  turnId: string,
): void {
  if (!flagEnabled) return;
  if (!adaptivePlanner) return;
  const classification = classifyIntent(text);
  const plannerInputs = {
    riskScore: 0.3,
    latencyBudgetMs: Infinity,
    isMultiStep: classification.intent === 'project' && classification.confidence > 0.5,
    remoteAvailable: false,
    backgroundEligible: false,
    taskDescription: text.slice(0, 120),
  };
  const decision = adaptivePlanner.select(plannerInputs);
  if (runtimeBus) {
    emitPlanStrategySelected(runtimeBus, emitterContext(turnId), decision);
  }
  logger.debug('[Orchestrator] adaptive-planner decision', {
    strategy: decision.selected,
    reasonCode: decision.reasonCode,
  });
}

export function prepareConversationForTurn(
  conversation: ConversationManager,
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>,
  text: string,
  content: ContentPart[] | undefined,
  sessionId?: string,
  planManager: Pick<ExecutionPlanManager, 'getActive' | 'toMarkdown'> | null = null,
): ExecutionPlan | null {
  const preTurnPlan = planManager?.getActive(sessionId) ?? null;
  if (preTurnPlan && planManager) {
    const planMd = planManager.toMarkdown(preTurnPlan);
    conversation.addSystemMessage(
      `## Current Execution Plan\n${planMd}\n\nRefer to this plan. Update item statuses as you complete work.`
    );
  }

  if (content && content.some(p => p.type === 'image')) {
    const model = providerRegistry.getCurrentModel();
    if (!model.capabilities.multimodal) {
      conversation.addSystemMessage(
        `Warning: ${model.displayName} does not support image input. Images have been removed from this message.`
      );
      const textOnly = content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join('');
      conversation.addUserMessage(textOnly || text);
    } else {
      conversation.addUserMessage(content);
    }
  } else {
    conversation.addUserMessage(content ?? text);
  }

  const activePlan = planManager?.getActive(sessionId) ?? null;
  if (!activePlan) {
    const classification = classifyIntent(text);
    const hasProjectPrimingSignal = classification.signals.some((signal) => PROJECT_PRIMING_SIGNALS.has(signal));
    const shouldPrimeProjectMode = classification.intent === 'project'
      && classification.confidence > 0.5
      && hasProjectPrimingSignal;
    if (shouldPrimeProjectMode) {
      conversation.addSystemMessage(
        '[Project mode] This looks like a multi-step project task. ' +
        'Before executing, write a brief spec (goals, constraints, non-goals) ' +
        'and an execution plan (phases and tasks). ' +
        'Use the execution plan format: ## Phase [STATUS] / - [x] Task - STATUS.'
      );
    }
  }

  return preTurnPlan;
}

export async function handleToolResponseOutcome(args: {
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  planManager: Pick<ExecutionPlanManager, 'getActive' | 'getSummary' | 'getNextItems' | 'updateItem'> | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  executeToolCalls: (turnId: string, calls: ToolCall[]) => Promise<ToolResult[]>;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  messageQueueLength: number;
  requestRender: () => void;
  sessionId?: string;
}): Promise<{ continueLoop: boolean; results: ToolResult[] }> {
  args.setPendingToolCalls(args.response.toolCalls);
  args.conversation.addAssistantMessage(args.response.content, {
    toolCalls: args.response.toolCalls,
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  });

  const results = await args.executeToolCalls(args.turnId, args.response.toolCalls);
  args.conversation.addToolResults(results);
  args.setPendingToolCalls([]);

  const allImages = (results as Array<ToolResult & { _images?: Array<{ path: string; base64: string; mediaType: string; description: string }> }>)
    .filter(r => Array.isArray(r._images) && r._images.length > 0)
    .flatMap(r => r._images!);
  if (allImages.length > 0 && args.providerRegistry.getCurrentModel().capabilities.multimodal) {
    const imageParts: ContentPart[] = [
      { type: 'text', text: '[Images from read tool results]' },
      ...allImages.map(img => ({ type: 'image' as const, data: img.base64, mediaType: img.mediaType })),
    ];
    args.conversation.addUserMessage(imageParts);
  }

  const spawnedAgents = args.response.toolCalls.some((tc: ToolCall) => {
    const mode = (tc.arguments as Record<string, unknown>).mode;
    return tc.name === 'agent' && (mode === 'spawn' || mode === 'batch-spawn');
  });

  if (spawnedAgents || args.messageQueueLength > 0) {
    if (spawnedAgents) {
      const planManager = args.planManager;
      const activePlan = planManager?.getActive(args.sessionId) ?? null;
      if (activePlan) {
        const summary = planManager?.getSummary(activePlan) ?? '';
        const nextItems = planManager?.getNextItems(activePlan) ?? [];
        if (nextItems.length > 0) {
          const autoSpawnedDescs = autoSpawnPendingItems(
            args.conversation,
            activePlan,
            nextItems,
            args.agentManager,
            args.configManager,
            args.providerRegistry,
            args.runtimeBus,
            args.emitterContext(args.turnId),
            planManager,
          );
          if (autoSpawnedDescs.length > 0) {
            args.conversation.addSystemMessage(
              `[Plan] Auto-spawned ${autoSpawnedDescs.length} agent(s) for remaining plan items: ${autoSpawnedDescs.join(', ')}. Plan progress: ${summary}.`
            );
          } else {
            const nextDesc = nextItems.map(i => i.description).join(', ');
            args.conversation.addSystemMessage(
              `Plan progress: ${summary}. Next items ready: ${nextDesc}. Continue spawning agents for remaining work.`
            );
          }
        } else {
          args.conversation.addSystemMessage(`Plan progress: ${summary}. All items are accounted for.`);
        }
      } else {
        args.conversation.addSystemMessage(
          'You spawned an agent for part of the task. If there are remaining tasks, continue spawning agents now.'
        );
      }
    }
    if (args.runtimeBus) {
      emitTurnCompleted(args.runtimeBus, args.emitterContext(args.turnId), {
        turnId: args.turnId,
        response: args.response.content,
        stopReason: args.response.content.trim().length > 0 ? 'completed' : 'empty_response',
      });
    }
    return { continueLoop: false, results };
  }

  if (args.planManager?.getActive(args.sessionId)) {
    args.conversation.addSystemMessage(
      'Update the execution plan to reflect completed work. Mark items as COMPLETE or IN_PROGRESS with the agent ID.'
    );
  }

  return { continueLoop: true, results };
}

export function handleFinalResponseOutcome(args: {
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list' | 'spawn'>;
  planManager: Pick<ExecutionPlanManager, 'parseFromMarkdown' | 'replaceItems' | 'load' | 'save' | 'getActive' | 'getNextItems' | 'updateItem'> | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  preTurnPlan: ExecutionPlan | null;
  requestRender: () => void;
  setAutoSpawnTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void;
  autoSpawnTimeoutMs: number;
  sessionId?: string;
}): false {
  args.conversation.addAssistantMessage(args.response.content, {
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: args.providerRegistry.getCurrentModel().displayName,
    provider: args.providerRegistry.getCurrentModel().provider,
  });
  if (args.runtimeBus) {
    emitTurnCompleted(args.runtimeBus, args.emitterContext(args.turnId), {
      turnId: args.turnId,
      response: args.response.content,
      stopReason: args.response.content.trim().length > 0 ? 'completed' : 'empty_response',
    });
  }

  const planManager = args.planManager;
  if (args.preTurnPlan && args.preTurnPlan.awaitingPlan === true && args.response.content.includes('## Phase') && planManager) {
    const parsed = planManager.parseFromMarkdown(args.response.content);
    if (parsed.items && parsed.items.length > 0) {
      planManager.replaceItems(args.preTurnPlan.id, parsed.items);
      const filledPlan = planManager.load(args.preTurnPlan.id);
      if (filledPlan) {
        filledPlan.awaitingPlan = false;
        planManager.save(filledPlan);
      }
      const updatedPlan = planManager.getActive(args.sessionId);
      if (updatedPlan) {
        const nextItems = planManager.getNextItems(updatedPlan);
        if (nextItems.length > 0) {
          const spawned = autoSpawnPendingItems(
            args.conversation,
            updatedPlan,
            nextItems,
            args.agentManager,
            args.configManager,
            args.providerRegistry,
            args.runtimeBus,
            args.emitterContext(args.turnId),
            planManager,
          );
          if (spawned.length > 0) {
            args.conversation.addSystemMessage(
              `[Plan] Parsed ${parsed.items.length} item(s) from your plan. Auto-spawned ${spawned.length} agent(s) for items with no blockers: ${spawned.join(', ')}.`
            );
            args.requestRender();
          } else {
            args.conversation.addSystemMessage(
              `[Plan] Parsed ${parsed.items.length} item(s) from your plan. Spawn agents for the items with no blockers to begin execution.`
            );
          }
        } else {
          args.conversation.addSystemMessage(
            `[Plan] Parsed ${parsed.items.length} item(s) from your plan. No items are ready to start - check dependencies.`
          );
        }
        return false;
      }
    }
  }

  const pendingPlan = planManager?.getActive(args.sessionId) ?? null;
  if (pendingPlan) {
    const pendingItems = planManager?.getNextItems(pendingPlan) ?? [];
    if (pendingItems.length > 0) {
      args.setAutoSpawnTimeout(setTimeout(() => {
        args.setAutoSpawnTimeout(null);
        const stillActivePlan = planManager?.getActive(args.sessionId) ?? null;
        if (!stillActivePlan) return;
        const stillPending = planManager?.getNextItems(stillActivePlan) ?? [];
        if (stillPending.length === 0) return;

        const spawned = autoSpawnPendingItems(
          args.conversation,
          stillActivePlan,
          stillPending,
          args.agentManager,
          args.configManager,
          args.providerRegistry,
          args.runtimeBus,
          args.emitterContext(args.turnId),
          planManager,
        );
        if (spawned.length > 0) {
          args.conversation.addSystemMessage(
            `[Plan] Timeout fallback auto-spawned ${spawned.length} agent(s) for plan items the model did not address: ${spawned.join(', ')}.`
          );
          args.requestRender();
        }
      }, args.autoSpawnTimeoutMs));
    }
  }

  return false;
}

export function emitMalformedToolUseWarning(args: {
  conversation: ConversationManager;
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel'>;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  isReconciliationEnabled: boolean;
}): void {
  logger.warn('Orchestrator: provider reported stopReason=tool_use but returned no tool calls (malformed response)', {
    model: args.providerRegistry.getCurrentModel().id,
    stopReason: 'tool_use',
  });
  if (args.isReconciliationEnabled) {
    args.conversation.addSystemMessage(
      '[Tool Reconciliation] Provider returned stop_reason=tool_use but no tool calls were included in the response. ' +
      'This is a malformed provider response. If this repeats, try switching models.',
    );
    if (args.runtimeBus) {
      emitToolReconciled(args.runtimeBus, args.emitterContext(args.turnId), {
        turnId: args.turnId,
        count: 0,
        callIds: [],
        toolNames: [],
        reason: 'malformed-stop-reason',
        isMalformed: true,
        timestamp: Date.now(),
      });
    }
  }
}
