import type { UiRuntimeEvents } from '@/runtime/index.ts';
import { buildPersistedSessionContext, persistConversation } from '@/runtime/index.ts';
import { maybeAutoCompact } from './context-auto-compact.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import type { HookDispatcher, HookPhase, HookCategory, HookEventPath } from '@pellux/goodvibes-sdk/platform/hooks';
import type { ConversationManager } from './conversation.ts';

/** Infer the options param of persistConversation to pick up SessionManager correctly. */
type PersistOptions = NonNullable<Parameters<typeof persistConversation>[5]>;

/** Minimal orchestrator surface required by turn-event wiring. */
interface TurnOrchestrator {
  readonly lastInputTokens: number;
}

/** Minimal provider registry surface required by turn-event wiring. */
interface TurnProviderRegistry {
  getCurrentModel(): { readonly contextWindow: number };
}

/** Minimal config manager surface required by turn-event wiring. */
interface TurnConfigManager {
  get(key: string): unknown;
}

/** Minimal system message router surface required by turn-event wiring. */
interface TurnSystemMessageRouter {
  high(message: string): void;
  low(message: string): void;
  routeSystemMessage(message: string, level: string): void;
}

export interface WireTurnEventHandlersOptions {
  readonly events: UiRuntimeEvents;
  readonly conversation: ConversationManager;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly orchestrator: TurnOrchestrator;
  readonly configManager: TurnConfigManager;
  readonly providerRegistry: TurnProviderRegistry;
  readonly systemMessageRouter: TurnSystemMessageRouter;
  readonly hookDispatcher: HookDispatcher;
  readonly workingDir: string;
  readonly homeDirectory: string;
  readonly sessionManager: PersistOptions['sessionManager'];
  readonly gitStatusProvider: { refresh(): Promise<unknown> };
  readonly lastGitInfoRef: { value: unknown };
  readonly buildSessionContinuityHints: () => Record<string, unknown>;
  readonly render: () => void;
}

export interface WireTurnEventHandlersResult {
  /** Trigger a git status refresh; may be called from external code after tool execution. */
  readonly refreshGit: () => void;
  /** Unsubscribe functions to push into the parent unsubs array. */
  readonly unsubs: ReadonlyArray<() => void>;
}

/**
 * Wire TURN_COMPLETED, TOOL_SUCCEEDED, and TOOL_FAILED runtime events.
 *
 * Responsibilities:
 *   - Auto-save conversation to persistent store after each LLM turn
 *   - Fire the Lifecycle:session:save hook
 *   - Trigger auto-compact when context usage exceeds the configured threshold
 *   - Refresh git status after turns and tool results
 *
 * Returns refreshGit (callable externally) and unsubs (push into parent unsubs).
 */
export function wireTurnEventHandlers(
  options: WireTurnEventHandlersOptions,
): WireTurnEventHandlersResult {
  const {
    events, conversation, runtime, orchestrator, configManager,
    providerRegistry, systemMessageRouter, hookDispatcher,
    workingDir, homeDirectory, sessionManager, gitStatusProvider,
    lastGitInfoRef, buildSessionContinuityHints, render,
  } = options;

  const unsubs: Array<() => void> = [];

  const refreshGit = (): void => {
    gitStatusProvider.refresh().then((info) => { lastGitInfoRef.value = info; render(); }).catch(() => { /* non-fatal */ });
  };

  unsubs.push(events.turns.on('TURN_COMPLETED', () => {
    // Auto-save after every LLM turn so kills don't lose the session
    try {
      const snapshot = conversation.toJSON() as { messages: Array<import('./conversation.ts').ConversationMessageSnapshot>; timestamp?: number };
      const persisted = buildPersistedSessionContext(snapshot.messages, conversation.getTitleSource(), buildSessionContinuityHints());
      persistConversation(
        runtime.sessionId,
        { ...snapshot, ...persisted },
        runtime.model,
        runtime.provider,
        conversation.title || '',
        { workingDirectory: workingDir, homeDirectory, sessionManager },
      );
      hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
    } catch (e) { logger.debug('auto-save on turn:complete failed', { error: summarizeError(e) }); }
    // Auto-compact: check context usage and compact if threshold exceeded
    const currentModelForCompact = providerRegistry.getCurrentModel();
    maybeAutoCompact({
      configManager: configManager as Parameters<typeof maybeAutoCompact>[0]['configManager'],
      conversation,
      providerRegistry: providerRegistry as Parameters<typeof maybeAutoCompact>[0]['providerRegistry'],
      systemMessageRouter: systemMessageRouter as Parameters<typeof maybeAutoCompact>[0]['systemMessageRouter'],
      model: runtime.model,
      provider: runtime.provider,
      lastInputTokens: orchestrator.lastInputTokens,
      contextWindow: currentModelForCompact.contextWindow,
    }).catch((err: unknown) => logger.debug('maybeAutoCompact error', { error: summarizeError(err) }));
    refreshGit();
  }));

  unsubs.push(events.tools.on('TOOL_SUCCEEDED', () => {
    refreshGit();
  }));
  unsubs.push(events.tools.on('TOOL_FAILED', () => {
    refreshGit();
  }));

  return { refreshGit, unsubs };
}
