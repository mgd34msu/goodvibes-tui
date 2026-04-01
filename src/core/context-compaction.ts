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
 *   shouldAutoCompact(opts)                — check if 15k token buffer threshold is exceeded
 *   compactSmallWindow(messages, keepRecent) — simplified compaction for small context windows
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

// ---------------------------------------------------------------------------
// Re-export CompactionEvent, CompactionResult, and CompactionContext for backward compatibility
// ---------------------------------------------------------------------------

export type { CompactionEvent, CompactionResult, CompactionContext } from './compaction-types.ts';

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
  /** Optional v2 context data (agents, plan, lineage, memories). When provided, v2 path is used. */
  context?: CompactionContext;
}

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
 * instead of the full structured v2 output, since there isn't enough room for extraction calls.
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

/** Rough token estimate: 4 chars ≈ 1 token. Used for threshold checks.
 * @deprecated Import estimateTokens from compaction-types.ts instead.
 * Re-exported here for backward compatibility.
 */
export { estimateTokens } from './compaction-types.ts';

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
 * @returns Truncated message array with a summary placeholder prepended
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
// Legacy v1 compaction (used when CompactionOptions.context is absent)
// ---------------------------------------------------------------------------

/**
 * MAX_PROMPT_OLDER_TOKENS — budget for the summarization prompt sent to the LLM
 * in the v1 legacy path. This is NOT related to the user's context window; it
 * caps the amount of older message text included in the extraction request.
 * Should be well below the extraction model's own context window.
 */
const MAX_PROMPT_OLDER_TOKENS = 80_000;

/**
 * compactMessagesLegacy — v1 backward-compatible compaction.
 *
 * Keeps the most recent `keepRecentMessages` messages verbatim, summarizes older
 * messages via a single LLM call, and returns a CompactionResult that places the
 * summary as a user/assistant pair followed by the recent messages.
 *
 * Throws if the LLM returns empty content or provider lookup fails.
 */
async function compactMessagesLegacy(
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const {
    registry,
    modelId,
    provider: providerName,
    messages,
    keepRecentMessages = 10,
    trigger = 'manual',
  } = opts;

  const tokensBeforeEstimate = estimateConversationTokens(messages);

  logger.info('Context compaction v1 (legacy): starting', {
    trigger,
    messageCount: messages.length,
    tokensBeforeEstimate,
    keepRecentMessages,
  });

  // Partition: older messages to summarize, recent to keep verbatim
  const recentMessages = messages.slice(-keepRecentMessages);
  const olderMessages = messages.slice(0, Math.max(0, messages.length - keepRecentMessages));

  // Build summarization prompt, truncating oldest if over token budget
  const promptParts: string[] = [
    'Summarize the following conversation history into concise bullet points. Focus on key decisions, facts, and outcomes. Be brief.',
    '',
    '--- CONVERSATION HISTORY ---',
    '',
  ];

  let olderTokens = 0;
  const includedOlderMessages: ProviderMessage[] = [];
  for (const msg of olderMessages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as ContentPart[]).filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
    const msgTokens = estimateTokens(text);
    if (olderTokens + msgTokens > MAX_PROMPT_OLDER_TOKENS) break;
    olderTokens += msgTokens;
    includedOlderMessages.push(msg);
  }

  for (const msg of includedOlderMessages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as ContentPart[]).filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
    promptParts.push(`[${msg.role}]: ${text.trim()}`);
    promptParts.push('');
  }

  promptParts.push('--- END CONVERSATION HISTORY ---');
  promptParts.push('');
  promptParts.push('Provide a concise bullet-point summary:');

  const summarizationPrompt = promptParts.join('\n');

  // Get provider — throw (don't degrade gracefully) for v1 compat
  let llmProvider: LLMProvider;
  try {
    llmProvider = registry.getForModel(modelId, providerName);
  } catch (err) {
    throw new Error(
      `Context compaction: failed to get provider for model '${modelId}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Call LLM — throw on empty (v1 behavior)
  const response = await llmProvider.chat({
    messages: [{ role: 'user', content: summarizationPrompt }],
    model: modelId,
  });
  const summaryText = response.content?.trim() ?? '';
  if (!summaryText) {
    throw new Error('Context compaction: LLM returned empty summary');
  }

  // Build v1 output: [summaryUser, summaryAssistant, ...recentMessages]
  const summaryUserMsg: ProviderMessage = {
    role: 'user',
    content: '[Context compacted — summary of earlier conversation follows]',
  };
  const summaryAssistantMsg: ProviderMessage = {
    role: 'assistant',
    content: summaryText,
  };
  const newMessages: ProviderMessage[] = [summaryUserMsg, summaryAssistantMsg, ...recentMessages];

  const tokensAfterEstimate = estimateConversationTokens(newMessages);

  const event: CompactionEvent = {
    timestamp: Date.now(),
    messagesBeforeCompaction: messages.length,
    messagesAfterCompaction: newMessages.length,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    modelId,
    trigger,
    sectionsIncluded: ['legacy-summary'],
    validationPassed: true,
  };

  compactionEvents.push(event);
  if (compactionEvents.length > 50) compactionEvents.shift();

  logger.info('Context compaction v1 (legacy): complete', {
    trigger,
    modelId,
    messagesBeforeCompaction: event.messagesBeforeCompaction,
    messagesAfterCompaction: event.messagesAfterCompaction,
    tokensBeforeEstimate: event.tokensBeforeEstimate,
    tokensAfterEstimate: event.tokensAfterEstimate,
    tokensSaved: event.tokensBeforeEstimate - event.tokensAfterEstimate,
  });

  return {
    messages: newMessages,
    summary: summaryText,
    tokensBeforeEstimate,
    tokensAfterEstimate,
    event,
    sections: [],
    validationWarnings: [],
  };
}

// ---------------------------------------------------------------------------
// Core compaction logic: v2 hybrid
// ---------------------------------------------------------------------------

/**
 * compactMessages — hybrid compaction entry point.
 *
 * When called with CompactionOptions (legacy v1 shape without a `context` field),
 * runs the v1 compatible summarize-and-keep path for backward compatibility.
 *
 * When called with CompactionOptions that includes a `context` field, or with a
 * CompactionContext directly, runs the v2 hybrid path with section assembly,
 * targeted LLM extraction, and post-compaction validation.
 */
export async function compactMessages(
  ctxOrOpts: CompactionContext | CompactionOptions,
  registryOverride?: ProviderRegistry,
): Promise<CompactionResult> {
  let result: CompactionResult;

  // Legacy path: CompactionOptions without a context field
  if ('registry' in ctxOrOpts) {
    const opts = ctxOrOpts as CompactionOptions;
    if (!opts.context) {
      // Pure v1 legacy: use keepRecentMessages-based summarization
      result = await compactMessagesLegacy(opts);
    } else {
      // Opts has a context field: promote to v2 path
      const ctx: CompactionContext = {
        ...opts.context,
        messages: opts.messages,
        trigger: opts.trigger ?? 'manual',
        extractionModelId: opts.modelId,
        extractionProvider: opts.provider,
      };
      registryOverride = opts.registry;
      result = await compactMessagesV2(ctx, registryOverride);
    }
  } else {
    // V2 path
    result = await compactMessagesV2(ctxOrOpts as CompactionContext, registryOverride);
  }

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
 * compactMessagesV2 — v2 hybrid compaction (internal implementation).
 *
 * Accepts a CompactionContext containing all data sources. Makes targeted LLM
 * calls for substance filtering and extraction (parallelized), assembles a
 * structured handoff context, validates it, and returns a CompactionResult.
 */
async function compactMessagesV2(
  ctx: CompactionContext,
  registryOverride?: ProviderRegistry,
): Promise<CompactionResult> {
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
  // Build rule-based sections (no LLM needed)
  // ---------------------------------------------------------------------------
  const sections: CompactionSection[] = [];

  // Section 0: Handoff header (always present)
  sections.push(buildHandoffHeader());

  // Section 2: Current task
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
  const memoriesSection = buildSessionMemories([...ctx.sessionMemories]);
  if (memoriesSection) sections.push(memoriesSection);

  // Section 3: Running agents
  const runningSection = buildRunningAgents(ctx.agents, ctx.wrfcChains);
  if (runningSection) sections.push(runningSection);

  // Section 6: Agent activity table (rule-based, needed before LLM calls to determine remaining)
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
    llmExtract(registryOverride, ctx.extractionModelId, ctx.extractionProvider, filterPrompt, 'conversation-filter'),
    llmExtract(registryOverride, ctx.extractionModelId, ctx.extractionProvider, toolPrompt, 'tool-results'),
    llmExtract(registryOverride, ctx.extractionModelId, ctx.extractionProvider, olderPrompt, 'older-agent-summary'),
    llmExtract(registryOverride, ctx.extractionModelId, ctx.extractionProvider, problemsPrompt, 'resolved-problems'),
  ]);

  // ---------------------------------------------------------------------------
  // Assemble LLM-assisted sections
  // ---------------------------------------------------------------------------

  // Section 4: Recent conversation
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

  // Section 5: Tool results
  if (toolSummary) {
    sections.push({
      id: 'tool-results',
      header: '## Tool Results & Files Modified',
      content: toolSummary,
      tokens: estimateTokens(toolSummary),
    });
  }

  // Section 7: Older agent summary
  if (olderSummary) {
    sections.push({
      id: 'older-agent-summary',
      header: '## Older Work Summary',
      content: olderSummary,
      tokens: estimateTokens(olderSummary),
    });
  }

  // Section 8: Resolved problems
  if (problemsText && problemsText.toLowerCase().trim() !== 'empty'
      && !problemsText.toLowerCase().includes('no resolved problems')) {
    sections.push({
      id: 'resolved-problems',
      header: '## Resolved Problems',
      content: problemsText,
      tokens: estimateTokens(problemsText),
    });
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
