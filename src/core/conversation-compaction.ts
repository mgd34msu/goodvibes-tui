import type { ProviderMessage } from '../providers/interface.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { logger } from '../utils/logger.ts';
import { compactMessages } from './context-compaction.ts';
import type { CompactionContext } from './context-compaction.ts';
import type { SessionMemoryStore } from './session-memory.ts';
import type { SessionLineageTracker } from './session-lineage.ts';

export interface ConversationCompactionHost {
  getMessageCount(): number;
  getMessagesForLLM(): ProviderMessage[];
  replaceMessagesForLLM(newMessages: ProviderMessage[]): void;
  getSessionMemoryStore(): Pick<SessionMemoryStore, 'list'> | null;
  getSessionLineageTracker(): Pick<SessionLineageTracker, 'addCompactionEntry'>;
}

export async function compactConversation(
  host: ConversationCompactionHost,
  registry: ProviderRegistry,
  modelId: string,
  trigger: 'auto' | 'manual' = 'manual',
  provider?: string,
  context?: CompactionContext,
): Promise<void> {
  if (host.getMessageCount() === 0) return;

  try {
    const llmMessages = host.getMessagesForLLM();
    const compactionContext: CompactionContext = context ?? {
      messages: llmMessages,
      trigger,
      extractionModelId: modelId,
      extractionProvider: provider,
      sessionMemories: [],
      agents: [],
      wrfcChains: [],
      activePlan: null,
      lineageEntries: [],
      compactionCount: 0,
      contextWindow: 0,
    };
    const result = await compactMessages(compactionContext, registry);

    host.replaceMessagesForLLM(result.messages);

    const memoriesCount = host.getSessionMemoryStore()?.list().length ?? 0;
    const memoriesPart = memoriesCount > 0 ? `, ${memoriesCount} pinned memories` : '';
    const saved = result.tokensBeforeEstimate - result.tokensAfterEstimate;
    const savedKTokens = Math.round(saved / 1000);
    host.getSessionLineageTracker().addCompactionEntry(
      `${trigger} compact, saved ~${savedKTokens}K tokens${memoriesPart}.`,
    );

    logger.info('Conversation compacted', {
      trigger,
      messagesBeforeCompaction: result.event.messagesBeforeCompaction,
      messagesAfterCompaction: result.event.messagesAfterCompaction,
      tokensBeforeEstimate: result.tokensBeforeEstimate,
      tokensAfterEstimate: result.tokensAfterEstimate,
      tokensSaved: saved,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Compact failed', { error: msg });
    throw err;
  }
}
