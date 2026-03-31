/**
 * context-compaction.ts
 *
 * Context Compaction v2 — Hybrid compaction engine for goodvibes-tui.
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
 * Public API (stable — backward compatible with v1):
 *   estimateConversationTokens(messages)   — rough token count for a message array
 *   estimateTokens(text)                   — rough token count for a string
 *   shouldAutoCompact(opts)                — check if threshold is exceeded
 *   getCompactionThreshold(contextWindow)  — context-window-aware threshold
 *   compactMessages(ctx)                   — v2 hybrid compaction entry point
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
import { DEFAULT_COMPACTION_CONFIG } from './compaction-types.ts';
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

// ---------------------------------------------------------------------------
// Re-export CompactionEvent and CompactionResult for backward compatibility
// ---------------------------------------------------------------------------

export type { CompactionEvent, CompactionResult } from './compaction-types.ts';

// ---------------------------------------------------------------------------
// V1 compatibility types (for callers that still use the old API shape)
// ---------------------------------------------------------------------------

/** @deprecated Use CompactionContext instead. Kept for backward compatibility. */
export interface CompactionOptions {
  /** Provider registry to get the LLM provider from. */
  registry: ProviderRegistry;
  /** Model ID to use for summarization. */
  modelId: string;
  /** Provider name — used to disambiguate models that exist on multiple providers. */
  provider?: string;
  /** Current messages (as sent to the LLM — no system messages). */
  messages: ProviderMessage[];
  /** Number of recent messages to keep verbatim (default: 10). */
  keepRecentMessages?: number;
  /** Whether this was triggered automatically or manually (default: 'manual'). */
  trigger?: 'auto' | 'manual';
}

export interface AutoCompactOptions {
  /** Current input token count from last LLM response. */
  currentTokens: number;
  /** Maximum context window for the current model. */
  contextWindow: number;
  /** Threshold percentage (0-100) at which to trigger compaction (default: 80). */
  threshold: number;
  /** Whether auto-compact is already in progress (prevent re-entry). */
  isCompacting: boolean;
}

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

/** Rough token estimate for a string: 4 chars ≈ 1 token, with 10% safety margin. */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.1);
}

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

// ---------------------------------------------------------------------------
// Context-window-aware threshold
// ---------------------------------------------------------------------------

/**
 * Returns the compaction threshold percentage based on the model's context window.
 *
 * Larger context windows can wait longer; smaller windows must compact earlier
 * to leave room for LLM extraction calls.
 *
 *   >= 500k tokens : compact at 80%
 *   128k–500k     : compact at 75%
 *   < 128k         : compact at 65%
 */
export function getCompactionThreshold(contextWindow: number): number {
  if (contextWindow >= 500_000) return 80;
  if (contextWindow >= 128_000) return 75;
  return 65;
}

// ---------------------------------------------------------------------------
// Should compact?
// ---------------------------------------------------------------------------

/**
 * Returns true if the context usage exceeds the threshold and compaction
 * has not already been triggered.
 */
export function shouldAutoCompact(opts: AutoCompactOptions): boolean {
  const { currentTokens, contextWindow, threshold, isCompacting } = opts;
  if (isCompacting || contextWindow <= 0) return false;
  const usagePct = (currentTokens / contextWindow) * 100;
  return usagePct >= threshold;
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
// Core compaction logic: v2 hybrid
// ---------------------------------------------------------------------------

/**
 * compactMessages — v2 hybrid compaction.
 *
 * Accepts a CompactionContext containing all data sources. Makes targeted LLM
 * calls for substance filtering and extraction, assembles a structured handoff
 * context, validates it, and returns a CompactionResult.
 *
 * Also accepts the legacy CompactionOptions shape for backward compatibility;
 * callers should migrate to CompactionContext.
 */
export async function compactMessages(
  ctxOrOpts: CompactionContext | CompactionOptions,
  registryOverride?: ProviderRegistry,
): Promise<CompactionResult> {
  // ---------------------------------------------------------------------------
  // Normalize input: support both new CompactionContext and legacy CompactionOptions
  // ---------------------------------------------------------------------------
  let ctx: CompactionContext;

  if ('registry' in ctxOrOpts) {
    // Legacy CompactionOptions — build a minimal CompactionContext
    const opts = ctxOrOpts as CompactionOptions;
    ctx = {
      messages: opts.messages,
      sessionMemories: [],
      agents: [],
      wrfcChains: [],
      activePlan: null,
      lineageEntries: [],
      originalTask: undefined,
      compactionCount: 1,
      contextWindow: 128_000,
      trigger: opts.trigger ?? 'manual',
      extractionModelId: opts.modelId,
      extractionProvider: opts.provider,
    };
    registryOverride = opts.registry;
  } else {
    ctx = ctxOrOpts as CompactionContext;
  }

  if (!registryOverride) {
    throw new Error('compactMessages: provider registry is required');
  }

  const config = DEFAULT_COMPACTION_CONFIG;
  const tokensBeforeEstimate = estimateConversationTokens(ctx.messages);

  logger.info('Context compaction v2: starting', {
    trigger: ctx.trigger,
    messageCount: ctx.messages.length,
    tokensBeforeEstimate,
    agentCount: ctx.agents.length,
    chainCount: ctx.wrfcChains.length,
  });

  // ---------------------------------------------------------------------------
  // Build sections
  // ---------------------------------------------------------------------------
  const sections: CompactionSection[] = [];

  // Section 0: Handoff header (always present)
  sections.push(buildHandoffHeader());

  // Section 2: Current task (before memories in display, but build from plan/messages)
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

  // Section 1: Session memories
  const memoriesSection = buildSessionMemories(ctx.sessionMemories);
  if (memoriesSection) sections.push(memoriesSection);

  // Section 3: Running agents
  const runningSection = buildRunningAgents(ctx.agents, ctx.wrfcChains);
  if (runningSection) sections.push(runningSection);

  // Section 4: Recent conversation (gather + LLM substance filter)
  const gatheredMessages = gatherRecentConversation(
    ctx.messages,
    config.recentConversationBudget,
  );

  if (gatheredMessages.length > 0) {
    const filterPrompt = buildConversationFilterPrompt(gatheredMessages);
    const filteredText = await llmExtract(
      registryOverride,
      ctx.extractionModelId,
      ctx.extractionProvider,
      filterPrompt,
      'conversation-filter',
    );
    if (filteredText) {
      const tokens = estimateTokens(filteredText);
      sections.push({
        id: 'recent-conversation',
        header: '## Recent Conversation',
        content: filteredText,
        tokens,
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

  // Section 5: Tool results (LLM-assisted relevance filter)
  const toolMessages = ctx.messages.filter((m) => m.role === 'tool');
  if (toolMessages.length > 0) {
    const toolPrompt = buildToolResultsPrompt(toolMessages);
    const toolSummary = await llmExtract(
      registryOverride,
      ctx.extractionModelId,
      ctx.extractionProvider,
      toolPrompt,
      'tool-results',
    );
    if (toolSummary) {
      sections.push({
        id: 'tool-results',
        header: '## Tool Results & Files Modified',
        content: toolSummary,
        tokens: estimateTokens(toolSummary),
      });
    }
  }

  // Section 6: Agent activity table (rule-based)
  const { section: activitySection, remainingChains } = buildAgentActivityTable(
    ctx.wrfcChains,
    config.agentActivityBudget,
  );
  if (activitySection) sections.push(activitySection);

  // Section 7: Older agent summary (LLM-assisted, only if agents beyond table)
  if (remainingChains.length > 0) {
    const olderPrompt = buildOlderAgentSummaryPrompt(remainingChains);
    const olderSummary = await llmExtract(
      registryOverride,
      ctx.extractionModelId,
      ctx.extractionProvider,
      olderPrompt,
      'older-agent-summary',
    );
    if (olderSummary) {
      sections.push({
        id: 'older-agent-summary',
        header: '## Older Work Summary',
        content: olderSummary,
        tokens: estimateTokens(olderSummary),
      });
    }
  }

  // Section 8: Resolved problems (LLM-assisted)
  const allUserAssistant = ctx.messages.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  if (allUserAssistant.length > 0) {
    const problemsPrompt = buildResolvedProblemsPrompt(allUserAssistant);
    const problemsText = await llmExtract(
      registryOverride,
      ctx.extractionModelId,
      ctx.extractionProvider,
      problemsPrompt,
      'resolved-problems',
    );
    if (problemsText && problemsText.toLowerCase().trim() !== 'empty'
        && !problemsText.toLowerCase().includes('no resolved problems')) {
      sections.push({
        id: 'resolved-problems',
        header: '## Resolved Problems',
        content: problemsText,
        tokens: estimateTokens(problemsText),
      });
    }
  }

  // Section 9: Plan progress (rule-based)
  const planSection = buildPlanProgress(ctx.activePlan);
  if (planSection) sections.push(planSection);

  // Section 10: Session lineage (rule-based, append-only)
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
    logger.warn('Context compaction v2: validation warnings', { warnings: validationWarnings });
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

  logger.info('Context compaction v2: complete', {
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
 * Supports both v2 CompactionContext and legacy CompactionOptions.
 */
export async function checkAndCompact(
  autoOpts: AutoCompactOptions,
  ctxOrOpts: CompactionContext | Omit<CompactionOptions, 'trigger'>,
  registryOverride?: ProviderRegistry,
): Promise<CompactionResult | null> {
  if (!shouldAutoCompact(autoOpts)) return null;

  if ('registry' in ctxOrOpts) {
    // Legacy path
    return compactMessages(
      { ...ctxOrOpts, trigger: 'auto' } as CompactionOptions,
      registryOverride,
    );
  }

  return compactMessages(
    { ...ctxOrOpts, trigger: 'auto' } as CompactionContext,
    registryOverride,
  );
}
