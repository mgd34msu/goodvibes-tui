/**
 * context-compaction.ts
 *
 * Context compaction engine for goodvibes-tui.
 *
 * Architecture:
 *   - Deterministic structure: fixed sections assembled in order
 *   - Targeted LLM calls for: substance filter, tool relevance, resolved problems,
 *     older agent summary
 *   - Rule-based sections: handoff, memories, current task, running agents,
 *     agent activity table, plan progress, session lineage
 *   - Post-compaction validation: sanity-checks required sections
 *   - Context-window-aware thresholds
 *
 * Public API:
 *   estimateConversationTokens(messages)   — rough token count for a message array
 *   estimateTokens(text)                   — rough token count for a string
 *   shouldAutoCompact(opts)                — check if 15k token buffer threshold is exceeded
 *   compactSmallWindow(messages, keepRecent) — simplified compaction for small context windows
 *   compactMessages(ctx, registry)         — structured compaction entry point
 *   checkAndCompact(autoOpts, ctx)         — check and compact if threshold exceeded
 *   getCompactionEvents()                  — return compaction event log
 *   getLastCompactionEvent()               — return most recent compaction event
 */

import type { ProviderMessage, ContentPart, LLMProvider } from '../providers/interface.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { logger } from '../utils/logger.ts';
import type {
  CompactionSection,
  CompactionContext,
  CompactionResult,
  CompactionEvent,
  CompactionConfig,
} from './compaction-types.ts';
import { DEFAULT_COMPACTION_CONFIG, estimateTokens } from './compaction-types.ts';
import {
  buildHandoffHeader,
  buildSessionMemories,
  buildCurrentTask,
  buildRunningAgents,
  gatherRecentConversation,
  buildConversationFilterPrompt,
  buildToolResultsPrompt,
  buildAgentActivityTable,
  buildOlderAgentSummaryPrompt,
  buildResolvedProblemsPrompt,
  buildPlanProgress,
  buildSessionLineage,
} from './compaction-sections.ts';
import { cacheHitTracker } from '../providers/cache-strategy.ts';
import { cachePlanner } from '../providers/cache-planner.ts';

export type { CompactionEvent, CompactionResult, CompactionContext } from './compaction-types.ts';

export interface AutoCompactOptions {
  /** Current input token count from last LLM response. */
  currentTokens: number;
  /** Maximum context window for the current model. */
  contextWindow: number;
  /** Whether auto-compact is already in progress (prevent re-entry). */
  isCompacting: boolean;
}

// ---------------------------------------------------------------------------
// Compaction trigger constants
// ---------------------------------------------------------------------------

/**
 * Tokens remaining in the context window at which auto-compaction triggers.
 * Compact when contextWindow - currentTokens <= COMPACTION_BUFFER_TOKENS.
 * 15k gives room for the ~6.5k compaction output + LLM extraction calls.
 */
export const COMPACTION_BUFFER_TOKENS = 15_000;

/**
 * Context windows smaller than this use simplified compaction (summarize last N messages)
 * instead of the full structured output, since there isn't enough room for extraction calls.
 */
export const SMALL_WINDOW_THRESHOLD = 12_000;

/** Hit rate threshold for logging cache impact during compaction. */
const CACHE_HIT_RATE_LOG_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Compaction event log (in-memory, session-scoped)
// ---------------------------------------------------------------------------

const compactionEvents: CompactionEvent[] = [];

export function getCompactionEvents(): readonly CompactionEvent[] {
  return compactionEvents;
}

export function getLastCompactionEvent(): CompactionEvent | null {
  return compactionEvents.length > 0
    ? compactionEvents[compactionEvents.length - 1]
    : null;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Rough token estimate: 4 chars ≈ 1 token. Used for threshold checks. */
export function estimateConversationTokens(messages: ProviderMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === 'text') {
          total += estimateTokens(part.text);
        }
      }
    }
  }
  return total;
}

export { estimateTokens } from './compaction-types.ts';

// ---------------------------------------------------------------------------
// Should compact?
// ---------------------------------------------------------------------------

/**
 * Returns true if the remaining context window is within COMPACTION_BUFFER_TOKENS
 * and compaction has not already been triggered.
 *
 * Triggers when: contextWindow - currentTokens <= 15000
 * The 15k buffer gives room for the ~6.5k compaction output + LLM extraction calls
 * + post-compaction work before the window is exhausted.
 */
export function shouldAutoCompact(opts: AutoCompactOptions): boolean {
  const { currentTokens, contextWindow, isCompacting } = opts;
  if (isCompacting || contextWindow <= 0) return false;
  return (contextWindow - currentTokens) <= COMPACTION_BUFFER_TOKENS;
}

// ---------------------------------------------------------------------------
// Small-window simplified compaction
// ---------------------------------------------------------------------------

/**
 * Simplified compaction for context windows smaller than SMALL_WINDOW_THRESHOLD (12k).
 * There isn't enough room for LLM extraction calls, so we just keep the last
 * `keepRecent` messages and add a brief summary note.
 *
 * @param messages - Full conversation message array
 * @param keepRecent - Number of recent messages to keep verbatim (default: 10)
 * @returns Truncated message array with a summary pair prepended
 */
export function compactSmallWindow(
  messages: ProviderMessage[],
  keepRecent = 10,
): ProviderMessage[] {
  if (messages.length <= keepRecent) return messages;
  const recentMessages = messages.slice(-keepRecent);
  const omittedCount = messages.length - keepRecent;
  const summaryMsg: ProviderMessage = {
    role: 'user' as const,
    content: `[Context compacted — small window mode, ${omittedCount} messages summarized]`,
  };
  const summaryReply: ProviderMessage = {
    role: 'assistant' as const,
    content: `[${omittedCount} earlier messages omitted to fit context window. Continuing from recent conversation.]`,
  };
  return [summaryMsg, summaryReply, ...recentMessages];
}

// ---------------------------------------------------------------------------
// LLM extraction helper
// ---------------------------------------------------------------------------

/**
 * Call the LLM with a prompt and return the trimmed response text.
 * Returns null on any failure (compaction should degrade gracefully).
 */
async function llmExtract(
  registry: ProviderRegistry,
  modelId: string,
  providerName: string | undefined,
  prompt: string,
  label: string,
): Promise<string | null> {
  if (!prompt.trim()) return null;

  let provider: LLMProvider;
  try {
    provider = registry.getForModel(modelId, providerName);
  } catch (err) {
    logger.warn(`Compaction: failed to get provider for ${label}`, {
      modelId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  try {
    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      model: modelId,
    });
    const text = response.content?.trim() ?? '';
    if (!text) {
      logger.warn(`Compaction: LLM returned empty response for ${label}`);
      return null;
    }
    return text;
  } catch (err) {
    logger.warn(`Compaction: LLM extraction failed for ${label}`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Post-compaction validation
// ---------------------------------------------------------------------------

function validateCompaction(
  sections: CompactionSection[],
  ctx: CompactionContext,
  totalTokens: number,
  config: CompactionConfig,
): string[] {
  const warnings: string[] = [];
  const sectionIds = new Set(sections.map((s) => s.id));

  if (!sectionIds.has('handoff-header')) {
    warnings.push('CRITICAL: handoff-header section is missing');
  }
  if (!sectionIds.has('current-task')) {
    warnings.push('WARNING: current-task section is missing');
  }

  const hasRunningAgents = ctx.agents.some(
    (a) => a.status === 'running' || a.status === 'pending',
  );
  if (hasRunningAgents && !sectionIds.has('running-agents')) {
    warnings.push('WARNING: running agents exist but running-agents section is missing');
  }

  if (ctx.sessionMemories.length > 0 && !sectionIds.has('session-memories')) {
    warnings.push('WARNING: session memories exist but session-memories section is missing');
  }

  if (totalTokens > config.totalCeiling) {
    warnings.push(
      `WARNING: total tokens (${totalTokens}) exceeds ceiling (${config.totalCeiling})`,
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Assemble compacted output
// ---------------------------------------------------------------------------

function assembleSections(sections: CompactionSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section.header) {
      parts.push(section.header);
    }
    parts.push(section.content);
    parts.push(''); // blank line between sections
  }
  return parts.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Core compaction logic
// ---------------------------------------------------------------------------

/**
 * compactMessages — structured compaction entry point.
 */
export async function compactMessages(
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult> {
  const result = await runCompaction(ctx, registry);

  // Invalidate cache strategy after compaction — cached message indices are no longer valid
  cachePlanner.invalidate();

  // Log compaction's impact on cache
  const recentHitRate = cacheHitTracker.getHitRate();
  if (recentHitRate > CACHE_HIT_RATE_LOG_THRESHOLD) {
    logger.info('[Compaction] High cache hit rate before compaction — cache will need rebuild', {
      hitRate: (recentHitRate * 100).toFixed(0) + '%',
    });
  }

  return result;
}

/**
 * runCompaction — internal implementation for structured compaction.
 *
 * Accepts a CompactionContext containing all data sources. Makes targeted LLM
 * calls for substance filtering and extraction (parallelized), assembles a
 * structured handoff context, validates it, and returns a CompactionResult.
 */
async function runCompaction(
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult> {
  const config = DEFAULT_COMPACTION_CONFIG;
  const tokensBeforeEstimate = estimateConversationTokens(ctx.messages);

  logger.info('Context compaction: starting', {
    trigger: ctx.trigger,
    messageCount: ctx.messages.length,
    tokensBeforeEstimate,
    agentCount: ctx.agents.length,
    chainCount: ctx.wrfcChains.length,
  });

  // ---------------------------------------------------------------------------
  // Build rule-based sections (no LLM needed)
  // ---------------------------------------------------------------------------
  const sections: CompactionSection[] = [];

  // Handoff header (always present)
  sections.push(buildHandoffHeader());

  // Current task
  const planTitle = ctx.activePlan?.title ?? null;
  const lastUserMsg = (() => {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      if (ctx.messages[i].role === 'user') {
        const text = typeof ctx.messages[i].content === 'string'
          ? ctx.messages[i].content as string
          : (ctx.messages[i].content as ContentPart[]).filter(
              (p): p is { type: 'text'; text: string } => p.type === 'text'
            ).map((p) => p.text).join('');
        if (text.trim()) return text.trim();
      }
    }
    return null;
  })();
  const currentTaskSection = buildCurrentTask(planTitle, lastUserMsg);
  if (currentTaskSection) sections.push(currentTaskSection);

  // Session memories
  const memoriesSection = buildSessionMemories([...ctx.sessionMemories]);
  if (memoriesSection) sections.push(memoriesSection);

  // Running agents
  const runningSection = buildRunningAgents(ctx.agents, ctx.wrfcChains);
  if (runningSection) sections.push(runningSection);

  // Agent activity table (rule-based, needed before LLM calls to determine remaining)
  const { section: activitySection, remainingChains } = buildAgentActivityTable(
    ctx.wrfcChains,
    config.agentActivityBudget,
  );
  if (activitySection) sections.push(activitySection);

  // ---------------------------------------------------------------------------
  // Prepare all LLM-assisted prompts
  // ---------------------------------------------------------------------------
  const gatheredMessages = gatherRecentConversation(
    ctx.messages,
    config.recentConversationBudget,
  );
  const filterPrompt = gatheredMessages.length > 0
    ? buildConversationFilterPrompt(gatheredMessages)
    : '';

  const toolMessages = ctx.messages.filter((m) => m.role === 'tool');
  const toolPrompt = toolMessages.length > 0
    ? buildToolResultsPrompt(toolMessages)
    : '';

  const olderPrompt = remainingChains.length > 0
    ? buildOlderAgentSummaryPrompt(remainingChains)
    : '';

  const allUserAssistant = ctx.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  const problemsPrompt = allUserAssistant.length > 0
    ? buildResolvedProblemsPrompt(allUserAssistant)
    : '';

  // ---------------------------------------------------------------------------
  // Parallelize all 4 independent LLM extraction calls
  // ---------------------------------------------------------------------------
  const [filteredText, toolSummary, olderSummary, problemsText] = await Promise.all([
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, filterPrompt, 'conversation-filter'),
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, toolPrompt, 'tool-results'),
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, olderPrompt, 'older-agent-summary'),
    llmExtract(registry, ctx.extractionModelId, ctx.extractionProvider, problemsPrompt, 'resolved-problems'),
  ]);

  // ---------------------------------------------------------------------------
  // Assemble LLM-assisted sections
  // ---------------------------------------------------------------------------

  // Recent conversation
  if (gatheredMessages.length > 0) {
    if (filteredText) {
      sections.push({
        id: 'recent-conversation',
        header: '## Recent Conversation',
        content: filteredText,
        tokens: estimateTokens(filteredText),
      });
    } else {
      // Fallback: include raw gathered messages if LLM filter fails
      const fallbackLines = gatheredMessages.map((m) => {
        const text = typeof m.content === 'string'
          ? m.content
          : (m.content as ContentPart[])
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map((p) => p.text)
              .join('');
        return `[${m.role}]: ${text.trim()}`;
      });
      const fallbackContent = fallbackLines.join('\n\n');
      sections.push({
        id: 'recent-conversation',
        header: '## Recent Conversation',
        content: fallbackContent,
        tokens: estimateTokens(fallbackContent),
      });
    }
  }

  // Tool results
  if (toolSummary) {
    sections.push({
      id: 'tool-results',
      header: '## Tool Results & Files Modified',
      content: toolSummary,
      tokens: estimateTokens(toolSummary),
    });
  }

  // Older agent summary
  if (olderSummary) {
    sections.push({
      id: 'older-agent-summary',
      header: '## Older Work Summary',
      content: olderSummary,
      tokens: estimateTokens(olderSummary),
    });
  }

  // Resolved problems
  if (problemsText && problemsText.toLowerCase().trim() !== 'empty'
      && !problemsText.toLowerCase().includes('no resolved problems')) {
    sections.push({
      id: 'resolved-problems',
      header: '## Resolved Problems',
      content: problemsText,
      tokens: estimateTokens(problemsText),
    });
  }

  // Plan progress (rule-based)
  const planSection = buildPlanProgress(ctx.activePlan);
  if (planSection) sections.push(planSection);

  // Session lineage (rule-based, append-only)
  const lineageSection = buildSessionLineage(
    ctx.originalTask ?? lastUserMsg ?? undefined,
    ctx.lineageEntries,
    ctx.compactionCount,
  );
  if (lineageSection) sections.push(lineageSection);

  // ---------------------------------------------------------------------------
  // Assemble and validate
  // ---------------------------------------------------------------------------
  const compactedText = assembleSections(sections);
  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
  const validationWarnings = validateCompaction(sections, ctx, totalTokens, config);

  if (validationWarnings.length > 0) {
    logger.warn('Context compaction: validation warnings', { warnings: validationWarnings });
  }

  // Build the new message list: a single user message containing the compacted context
  const newMessages: ProviderMessage[] = [
    {
      role: 'user',
      content: compactedText,
    },
  ];

  const tokensAfterEstimate = estimateConversationTokens(newMessages);

  const event: CompactionEvent = {
    timestamp: Date.now(),
    messagesBeforeCompaction: ctx.messages.length,
    messagesAfterCompaction: newMessages.length,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    modelId: ctx.extractionModelId,
    trigger: ctx.trigger,
    sectionsIncluded: sections.map((s) => s.id),
    validationPassed: validationWarnings.length === 0,
  };

  compactionEvents.push(event);
  if (compactionEvents.length > 50) compactionEvents.shift();

  logger.info('Context compaction: complete', {
    trigger: ctx.trigger,
    modelId: ctx.extractionModelId,
    messagesBeforeCompaction: event.messagesBeforeCompaction,
    messagesAfterCompaction: event.messagesAfterCompaction,
    tokensBeforeEstimate: event.tokensBeforeEstimate,
    tokensAfterEstimate: event.tokensAfterEstimate,
    tokensSaved: event.tokensBeforeEstimate - event.tokensAfterEstimate,
    sectionsIncluded: event.sectionsIncluded,
    validationWarnings: validationWarnings.length,
  });

  return {
    messages: newMessages,
    summary: compactedText,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    event,
    sections,
    validationWarnings,
  };
}

// ---------------------------------------------------------------------------
// checkAndCompact
// ---------------------------------------------------------------------------

/**
 * checkAndCompact — Check if context usage exceeds threshold and compact if so.
 * Returns the compaction result if compaction was performed, null otherwise.
 *
 */
export async function checkAndCompact(
  autoOpts: AutoCompactOptions,
  ctx: CompactionContext,
  registry: ProviderRegistry,
): Promise<CompactionResult | null> {
  if (!shouldAutoCompact(autoOpts)) return null;

  return compactMessages(
    { ...ctx, trigger: 'auto' } as CompactionContext,
    registry,
  );
}
