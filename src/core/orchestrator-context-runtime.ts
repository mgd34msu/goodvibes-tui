import type { ConversationManager } from './conversation.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { ModelDefinition, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers/registry';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { estimateConversationTokens, COMPACTION_BUFFER_TOKENS, SMALL_WINDOW_THRESHOLD, compactSmallWindow, shouldAutoCompact } from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import type { CompactionContext } from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import type { SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core/session-memory';
import type { SessionLineageTracker } from '@pellux/goodvibes-sdk/platform/core/session-lineage';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';
import type { WrfcController } from '@pellux/goodvibes-sdk/platform/agents/wrfc-controller';
import type { ExecutionPlanManager } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import { emitOpsContextWarning } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import type { HookEvent, HookResult } from '@pellux/goodvibes-sdk/platform/hooks/types';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

type HookDispatcherLike = {
  fire(event: HookEvent): Promise<HookResult>;
};

type EmitterContextFactory = (turnId: string) => import('../runtime/emitters/index.ts').EmitterContext;

type CatalogTier = 'free' | 'paid' | 'subscription';

function normalizeCatalogTier(tier: ModelDefinition['tier']): CatalogTier | undefined {
  if (tier === 'free') return 'free';
  if (tier === 'subscription') return 'subscription';
  if (tier === 'standard' || tier === 'premium') return 'paid';
  return undefined;
}

function findLargerContextModels(
  providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'>,
  minContext: number,
  tier?: CatalogTier,
  limit = 3,
): Array<{ id: string; displayName: string; context: number }> {
  return providerRegistry
    .listModels()
      .filter((model) => model.selectable)
      .map((model) => ({
        id: model.id,
        displayName: model.displayName,
        context: providerRegistry.getContextWindowForModel(model),
        tier: normalizeCatalogTier(model.tier),
      }))
    .filter((model) => model.context > minContext && (tier === undefined || model.tier === tier))
    .sort((a, b) => b.context - a.context)
    .slice(0, limit)
    .map(({ id, displayName, context }) => ({ id, displayName, context }));
}

export type PreflightDeps = {
  conversation: ConversationManager;
  requestRender: () => void;
  hookDispatcher: HookDispatcherLike | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: ProviderRegistry;
  sessionLineageTracker: Pick<SessionLineageTracker, 'getEntries' | 'getCompactionCount'>;
  sessionId: string;
  agentManager: Pick<AgentManager, 'list'>;
  wrfcController: Pick<WrfcController, 'listChains'>;
  planManager: Pick<ExecutionPlanManager, 'getActive'> | null;
  sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  isCompacting: boolean;
  setIsCompacting: (value: boolean) => void;
};

export async function checkContextWindowPreflight(
  deps: PreflightDeps,
  turnId: string,
  model: ModelDefinition,
): Promise<'ok' | 'compacted' | 'error'> {
  const contextWindow = deps.providerRegistry.getContextWindowForModel(model);
  const tier = normalizeCatalogTier(model.tier);

  if (contextWindow <= 0) return 'ok';

  const messages = deps.conversation.getMessagesForLLM();
  const estimatedTokens = estimateConversationTokens(messages);
  if (estimatedTokens <= contextWindow) return 'ok';

  const threshold = deps.configManager.get('behavior.autoCompactThreshold') as number;
  const autoCompactEnabled = threshold > 0;

  if (autoCompactEnabled && !deps.isCompacting) {
    logger.info('Orchestrator: context window pre-flight - auto-compacting before chat call', {
      modelId: model.id,
      estimatedTokens,
      contextWindow,
    });

    deps.setIsCompacting(true);
    deps.conversation.addSystemMessage(
      `Context pre-check: request (~${Math.round(estimatedTokens / 1000)}K tokens) exceeds ${model.displayName} context window (${Math.round(contextWindow / 1000)}K). Auto-compacting...`
    );
    deps.requestRender();

    if (deps.hookDispatcher) {
      const preResult = await deps.hookDispatcher.fire({
        path: 'Pre:compact:preflight',
        phase: 'Pre',
        category: 'compact',
        specific: 'preflight',
        sessionId: deps.sessionId,
        timestamp: Date.now(),
        payload: { trigger: 'preflight', estimatedTokens, contextWindow },
      }).catch((err: unknown): HookResult => {
        logger.debug('Pre:compact:preflight hook error', { error: summarizeError(err) });
        return { ok: true };
      });
      if (preResult.decision === 'deny') {
        deps.setIsCompacting(false);
        logger.info('Orchestrator: Pre:compact:preflight denied by hook - skipping preflight compact', { reason: preResult.reason });
        return 'ok';
      }
    }

    try {
      const preflightCtx: CompactionContext = {
        messages,
        sessionMemories: deps.sessionMemoryStore?.list() ?? [],
        lineageEntries: deps.sessionLineageTracker.getEntries(),
        agents: deps.agentManager.list().filter(a => a.status === 'running' || a.status === 'pending'),
        wrfcChains: deps.wrfcController.listChains(),
        activePlan: deps.planManager?.getActive(deps.sessionId) ?? null,
        compactionCount: deps.sessionLineageTracker.getCompactionCount(),
        contextWindow,
        trigger: 'auto',
        extractionModelId: model.id,
        extractionProvider: model.provider,
      };
      await deps.conversation.compact(deps.providerRegistry, model.id, 'auto', model.provider, preflightCtx);
      deps.conversation.addSystemMessage('Context compacted. Retrying request...');
      if (deps.hookDispatcher) {
        deps.hookDispatcher.fire({
          path: 'Post:compact:preflight',
          phase: 'Post',
          category: 'compact',
          specific: 'preflight',
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { trigger: 'preflight', estimatedTokens, contextWindow },
        }).catch((err: unknown) => { logger.debug('Post:compact:preflight hook error', { error: summarizeError(err) }); });
      }
    } catch (compactErr) {
      const msg = compactErr instanceof Error ? compactErr.message : String(compactErr);
      logger.error('Orchestrator: pre-flight compact failed', { error: msg });
      deps.conversation.addSystemMessage(`Auto-compact failed: ${msg}.`);
      if (deps.hookDispatcher) {
        deps.hookDispatcher.fire({
          path: 'Fail:compact:preflight',
          phase: 'Fail',
          category: 'compact',
          specific: 'preflight',
          sessionId: deps.sessionId,
          timestamp: Date.now(),
          payload: { trigger: 'preflight', estimatedTokens, contextWindow, error: msg },
        }).catch((err: unknown) => { logger.debug('Fail:compact:preflight hook error', { error: summarizeError(err) }); });
      }
    } finally {
      deps.setIsCompacting(false);
    }

    const tokensAfter = estimateConversationTokens(deps.conversation.getMessagesForLLM());
    if (tokensAfter <= contextWindow) {
      return 'compacted';
    }

    emitContextOverflowError(
      deps.conversation,
      deps.requestRender,
      turnId,
      estimatedTokens,
      contextWindow,
      model.displayName,
      deps.providerRegistry,
      tier,
    );
    return 'error';
  }

  emitContextOverflowError(
    deps.conversation,
    deps.requestRender,
    turnId,
    estimatedTokens,
    contextWindow,
    model.displayName,
    deps.providerRegistry,
    tier,
  );
  return 'error';
}

export function emitContextOverflowError(
  conversation: { addSystemMessage: (message: string) => void },
  requestRender: () => void,
  _turnId: string,
  estimatedTokens: number,
  contextWindow: number,
  modelDisplayName: string,
  providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getContextWindowForModel'>,
  tier?: CatalogTier,
): void {
  const requestK = Math.round(estimatedTokens / 1000);
  const contextK = Math.round(contextWindow / 1000);
  const alternatives = findLargerContextModels(providerRegistry, contextWindow, tier, 3);

  let msg =
    `Request (~${requestK}K tokens) exceeds ${modelDisplayName} context window (${contextK}K). ` +
    `Use /compact to reduce context or switch to a larger model.`;

  if (alternatives.length > 0) {
    const altNames = alternatives.map(a => `${a.displayName} (${Math.round(a.context / 1000)}K)`).join(', ');
    msg += ` Larger-context alternatives: ${altNames}.`;
  }

  logger.warn('Orchestrator: context window overflow', {
    estimatedTokens,
    contextWindow,
    modelDisplayName,
    alternatives: alternatives.map(a => a.id),
  });

  conversation.addSystemMessage(msg);
  requestRender();
}

export type PostTurnContextDeps = {
  conversation: ConversationManager;
  agentManager: Pick<AgentManager, 'list'>;
  wrfcController: Pick<WrfcController, 'listChains'>;
  planManager: Pick<ExecutionPlanManager, 'getActive'> | null;
  sessionMemoryStore: Pick<SessionMemoryStore, 'list'> | null;
  runtimeBus: RuntimeEventBus | null;
  emitterContext: EmitterContextFactory;
  hookDispatcher: HookDispatcherLike | null;
  configManager: Pick<ConfigManager, 'get'>;
  providerRegistry: ProviderRegistry;
  sessionLineageTracker: Pick<SessionLineageTracker, 'getEntries' | 'getCompactionCount'>;
  sessionId: string;
  requestRender: () => void;
  isCompacting: boolean;
  setIsCompacting: (value: boolean) => void;
  lastWarningBracket: number;
  setLastWarningBracket: (value: number) => void;
};

export async function handlePostTurnContextMaintenance(
  deps: PostTurnContextDeps,
  turnId: string,
  totalTokens: number,
): Promise<void> {
  const currentModel = deps.providerRegistry.getCurrentModel();
  const maxTokens = deps.providerRegistry.getContextWindowForModel(currentModel);
  if (maxTokens <= 0) return;

  const usagePct = Math.round((totalTokens / maxTokens) * 100);
  const configuredThreshold = deps.configManager.get('behavior.autoCompactThreshold') as number;
  const warningsEnabled = deps.configManager.get('behavior.staleContextWarnings') as boolean;
  const autoCompactEnabled = configuredThreshold > 0;
  const bracket = Math.floor(usagePct / 10) * 10;

  if (
    autoCompactEnabled &&
    shouldAutoCompact({
      currentTokens: totalTokens,
      contextWindow: maxTokens,
      isCompacting: deps.isCompacting,
    })
  ) {
    deps.setIsCompacting(true);
    deps.conversation.addSystemMessage(
      `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens). Auto-compacting conversation...`
    );
    if (deps.runtimeBus) {
      emitOpsContextWarning(deps.runtimeBus, deps.emitterContext(turnId), {
        usage: usagePct,
        threshold: COMPACTION_BUFFER_TOKENS,
      });
    }
    deps.requestRender();

    let skipAutoCompact = false;
    if (deps.hookDispatcher) {
      const preAutoResult = await deps.hookDispatcher.fire({
        path: 'Pre:compact:auto',
        phase: 'Pre',
        category: 'compact',
        specific: 'auto',
        sessionId: deps.sessionId,
        timestamp: Date.now(),
        payload: { trigger: 'auto', usagePct, totalTokens, maxTokens },
      }).catch((err: unknown): HookResult => {
        logger.debug('Pre:compact:auto hook error', { error: summarizeError(err) });
        return { ok: true };
      });
      if (preAutoResult.decision === 'deny') {
        deps.setIsCompacting(false);
        skipAutoCompact = true;
        logger.info('Orchestrator: Pre:compact:auto denied by hook - skipping auto-compact', { reason: preAutoResult.reason });
      }
    }

    try {
      const currentMsgs = deps.conversation.getMessagesForLLM();
      const useSmallWindow = maxTokens < SMALL_WINDOW_THRESHOLD;

      if (!skipAutoCompact && useSmallWindow) {
        try {
          const compactedMsgs = compactSmallWindow(currentMsgs, 10);
          deps.conversation.replaceMessagesForLLM(compactedMsgs);
          deps.setIsCompacting(false);
          deps.setLastWarningBracket(0);
          deps.conversation.addSystemMessage('Context auto-compacted (small window mode). Kept last 10 messages.');
          deps.requestRender();
        } catch (err: unknown) {
          deps.setIsCompacting(false);
          const msg = summarizeError(err);
          logger.error('Orchestrator: small-window auto-compact failed', { error: msg });
          deps.conversation.addSystemMessage(`Auto-compact failed: ${msg}. Use /compact to retry manually.`);
          deps.requestRender();
        }
      } else if (!skipAutoCompact) {
        const compactionCtx: CompactionContext = {
          messages: currentMsgs,
          sessionMemories: deps.sessionMemoryStore?.list() ?? [],
          lineageEntries: deps.sessionLineageTracker.getEntries(),
          agents: deps.agentManager.list().filter(a => a.status === 'running' || a.status === 'pending'),
          wrfcChains: deps.wrfcController.listChains(),
          activePlan: deps.planManager?.getActive(deps.sessionId) ?? null,
          compactionCount: deps.sessionLineageTracker.getCompactionCount(),
          contextWindow: maxTokens,
          trigger: 'auto',
          extractionModelId: currentModel.id,
          extractionProvider: currentModel.provider,
        };
        void deps.conversation.compact(
          deps.providerRegistry,
          currentModel.id,
          'auto',
          currentModel.provider,
          compactionCtx,
        ).then(() => {
          deps.setIsCompacting(false);
          deps.setLastWarningBracket(0);
          deps.conversation.addSystemMessage('Context auto-compacted. Conversation history summarized to free context window.');
          deps.requestRender();
          logger.info('Orchestrator: auto-compact complete', { modelId: currentModel.id, usagePct });
          if (deps.hookDispatcher) {
            deps.hookDispatcher.fire({
              path: 'Post:compact:auto',
              phase: 'Post',
              category: 'compact',
              specific: 'auto',
              sessionId: deps.sessionId,
              timestamp: Date.now(),
              payload: { trigger: 'auto', usagePct, totalTokens, maxTokens },
            }).catch((err: unknown) => { logger.debug('Post:compact:auto hook error', { error: summarizeError(err) }); });
          }
        }).catch((err: unknown) => {
          deps.setIsCompacting(false);
          const msg = summarizeError(err);
          logger.error('Orchestrator: auto-compact failed', { error: msg });
          deps.conversation.addSystemMessage(`Auto-compact failed: ${msg}. Use /compact to retry manually.`);
          deps.requestRender();
          if (deps.hookDispatcher) {
            deps.hookDispatcher.fire({
              path: 'Fail:compact:auto',
              phase: 'Fail',
              category: 'compact',
              specific: 'auto',
              sessionId: deps.sessionId,
              timestamp: Date.now(),
              payload: { trigger: 'auto', usagePct, totalTokens, maxTokens, error: msg },
            }).catch((err: unknown) => { logger.debug('Fail:compact:auto hook error', { error: summarizeError(err) }); });
          }
        });
      }
    } catch (compactErr: unknown) {
      deps.setIsCompacting(false);
      logger.error('Auto-compact failed', { error: String(compactErr) });
      deps.conversation.addSystemMessage(`[Compact] Auto-compaction failed: ${String(compactErr)}`);
      deps.requestRender();
    }
  } else if (
    warningsEnabled &&
    autoCompactEnabled &&
    (maxTokens - totalTokens) <= COMPACTION_BUFFER_TOKENS * 2 &&
    bracket > deps.lastWarningBracket
  ) {
    deps.setLastWarningBracket(bracket);
    deps.conversation.addSystemMessage(
      `Context usage at ${usagePct}% (${totalTokens}/${maxTokens} tokens). Auto-compact will trigger within ${COMPACTION_BUFFER_TOKENS.toLocaleString()} remaining tokens.`
    );
    if (deps.runtimeBus) {
      emitOpsContextWarning(deps.runtimeBus, deps.emitterContext(turnId), {
        usage: usagePct,
        threshold: COMPACTION_BUFFER_TOKENS,
      });
    }
    deps.requestRender();
  }
}
