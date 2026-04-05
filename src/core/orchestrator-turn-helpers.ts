import type { ConversationManager } from './conversation.ts';
import { providerRegistry } from '../providers/registry.ts';
import type { ContentPart, LLMProvider } from '../providers/interface.ts';
import { configManager } from '../config/index.ts';
import { classifyIntent } from './intent-classifier.ts';
import { adaptivePlanner } from './adaptive-planner-instance.ts';
import { logger } from '../utils/logger.ts';
import { planManager } from './plan-manager-instance.ts';
import type { ExecutionPlan, PlanItem } from './execution-plan.ts';
import type { RuntimeEventBus } from '../runtime/events/index.ts';
import { emitPlanStrategySelected, emitToolReconciled, emitTurnCompleted } from '../runtime/emitters/index.ts';
import { buildSyntheticResult } from './tool-reconciliation.ts';
import { autoSpawnPendingItems } from './orchestrator-tool-runtime.ts';
import type { ToolCall, ToolResult } from '../types/tools.ts';

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.ts').EmitterContext;
export type ChatResponseWithReasoning = Awaited<ReturnType<LLMProvider['chat']>> & {
  reasoning?: string;
  reasoningSummary?: string;
};

export function maybeEmitAdaptivePlannerDecision(
  text: string,
  flagEnabled: boolean,
  runtimeBus: RuntimeEventBus | null,
  emitterContext: EmitterContextFactory,
  turnId: string,
): void {
  if (!flagEnabled) return;
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
  text: string,
  content: ContentPart[] | undefined,
): ExecutionPlan | null {
  const preTurnPlan = planManager.getActive();
  if (preTurnPlan) {
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

  const activePlan = planManager.getActive();
  if (!activePlan) {
    const classification = classifyIntent(text);
    if (classification.intent === 'project' && classification.confidence > 0.5) {
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
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  executeToolCalls: (turnId: string, calls: ToolCall[]) => Promise<ToolResult[]>;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  messageQueueLength: number;
  requestRender: () => void;
}): Promise<{ continueLoop: boolean; results: ToolResult[] }> {
  args.setPendingToolCalls(args.response.toolCalls);
  args.conversation.addAssistantMessage(args.response.content, {
    toolCalls: args.response.toolCalls,
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: providerRegistry.getCurrentModel().displayName,
    provider: providerRegistry.getCurrentModel().provider,
  });

  const results = await args.executeToolCalls(args.turnId, args.response.toolCalls);
  args.conversation.addToolResults(results);
  args.setPendingToolCalls([]);

  const allImages = (results as Array<ToolResult & { _images?: Array<{ path: string; base64: string; mediaType: string; description: string }> }>)
    .filter(r => Array.isArray(r._images) && r._images.length > 0)
    .flatMap(r => r._images!);
  if (allImages.length > 0 && providerRegistry.getCurrentModel().capabilities.multimodal) {
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
      const activePlan = planManager.getActive();
      if (activePlan) {
        const summary = planManager.getSummary(activePlan);
        const nextItems = planManager.getNextItems(activePlan);
        if (nextItems.length > 0) {
          const autoSpawnedDescs = autoSpawnPendingItems(args.conversation, activePlan, nextItems);
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

  if (planManager.getActive()) {
    args.conversation.addSystemMessage(
      'Update the execution plan to reflect completed work. Mark items as COMPLETE or IN_PROGRESS with the agent ID.'
    );
  }

  return { continueLoop: true, results };
}

export function handleFinalResponseOutcome(args: {
  conversation: ConversationManager;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  response: ChatResponseWithReasoning;
  preTurnPlan: ExecutionPlan | null;
  requestRender: () => void;
  setAutoSpawnTimeout: (timeout: ReturnType<typeof setTimeout> | null) => void;
  autoSpawnTimeoutMs: number;
}): false {
  args.conversation.addAssistantMessage(args.response.content, {
    reasoningContent: args.response.reasoning || undefined,
    reasoningSummary: args.response.reasoningSummary || undefined,
    usage: args.response.usage,
    model: providerRegistry.getCurrentModel().displayName,
    provider: providerRegistry.getCurrentModel().provider,
  });
  if (args.runtimeBus) {
    emitTurnCompleted(args.runtimeBus, args.emitterContext(args.turnId), {
      turnId: args.turnId,
      response: args.response.content,
      stopReason: args.response.content.trim().length > 0 ? 'completed' : 'empty_response',
    });
  }

  if (args.preTurnPlan && args.preTurnPlan.awaitingPlan === true && args.response.content.includes('## Phase')) {
    const parsed = planManager.parseFromMarkdown(args.response.content);
    if (parsed.items && parsed.items.length > 0) {
      planManager.replaceItems(args.preTurnPlan.id, parsed.items);
      const filledPlan = planManager.load(args.preTurnPlan.id);
      if (filledPlan) {
        filledPlan.awaitingPlan = false;
        planManager.save(filledPlan);
      }
      const updatedPlan = planManager.getActive();
      if (updatedPlan) {
        const nextItems = planManager.getNextItems(updatedPlan);
        if (nextItems.length > 0) {
          const spawned = autoSpawnPendingItems(args.conversation, updatedPlan, nextItems);
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

  const pendingPlan = planManager.getActive();
  if (pendingPlan) {
    const pendingItems = planManager.getNextItems(pendingPlan);
    if (pendingItems.length > 0) {
      args.setAutoSpawnTimeout(setTimeout(() => {
        args.setAutoSpawnTimeout(null);
        const stillActivePlan = planManager.getActive();
        if (!stillActivePlan) return;
        const stillPending = planManager.getNextItems(stillActivePlan);
        if (stillPending.length === 0) return;

        const spawned = autoSpawnPendingItems(args.conversation, stillActivePlan, stillPending);
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
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  turnId: string;
  isReconciliationEnabled: boolean;
}): void {
  logger.warn('Orchestrator: provider reported stopReason=tool_use but returned no tool calls (malformed response)', {
    model: providerRegistry.getCurrentModel().id,
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
