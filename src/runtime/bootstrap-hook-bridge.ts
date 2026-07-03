import type { ConversationManager } from '../core/conversation';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import { registerBootstrapHookBridge } from '@/runtime/index.ts';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { emitSessionResumed } from '@/runtime/index.ts';
import { HelperModel } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import type { SharedSessionBroker } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { replayJournalForSession } from '../core/session-recovery.ts';

export interface ResumeSessionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtime: MutableRuntimeState;
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  readonly onSessionIdChanged?: (sessionId: string) => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly hookDispatcher: HookDispatcher;
  readonly sessionManager: SessionManager;
  readonly panelManager: PanelManager;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel' | 'require'>;
  readonly homeDirectory: string;
  /** See CommandSessionServices.hydrateSessionUsage (command-registry.ts). */
  readonly hydrateSessionUsage?: () => void;
}

export function createResumeSessionHandler(options: ResumeSessionOptions): (sessionId: string) => void {
  return (sessionId: string): void => {
    try {
      const { messages, meta } = options.sessionManager.load(sessionId);
      emitSessionResumed(options.runtimeBus, {
        sessionId: options.runtime.sessionId,
        traceId: `${options.runtime.sessionId}:session-resume:${sessionId}`,
        source: 'bootstrap',
      }, {
        sessionId,
        turnCount: messages.length,
      });
      options.conversation.fromJSON({
        messages: messages as Parameters<typeof options.conversation.fromJSON>[0]['messages'],
        title: meta.title,
        titleSource: meta.titleSource,
      });
      options.runtime.sessionId = sessionId;
      replayJournalForSession({
        homeDirectory: options.homeDirectory,
        sessionId,
        snapshotTimestamp: meta.timestamp ?? 0,
        conversation: options.conversation,
        persistSnapshot: (replayedMessages) => {
          options.sessionManager.save(sessionId, replayedMessages as never[], {
            title: options.conversation.title || meta.title,
            model: meta.model,
            provider: meta.provider,
            timestamp: Date.now(),
            titleSource: meta.titleSource,
            returnContext: meta.returnContext,
          });
        },
      });
      // Hydrate the footer's token counters from the resumed history now that
      // fromJSON()/journal replay are both applied — before requestRender() below.
      options.hydrateSessionUsage?.();
      options.onSessionIdChanged?.(sessionId);
      if (meta?.model) options.runtime.model = meta.model;
      if (meta?.provider) options.runtime.provider = meta.provider;
      options.writeLastSessionPointer(sessionId);
      void options.sharedSessionBroker.reopenSession(sessionId).catch((err) => { logger.debug('session broker reopen session failed', { err }); });
      options.conversation.log(`Resumed session: ${sessionId}`, { fg: '135' });
      const reopenedPanels: string[] = [];
      if (meta.returnContext?.openPanels?.length) {
        for (const panelId of meta.returnContext.openPanels.slice(0, 4)) {
          try {
            options.panelManager.open(panelId);
            reopenedPanels.push(panelId);
          } catch {
            // Ignore unavailable panels during restore.
          }
        }
        if (reopenedPanels.length > 0) options.panelManager.show();
      }
      const returnContextMode = getReturnContextMode(options.configManager);
      if (returnContextMode !== 'off' && meta.returnContext) {
        for (const line of formatReturnContextForDisplay(meta.returnContext)) {
          options.conversation.log(`Resume: ${line}`, { fg: '244' });
        }
        if (reopenedPanels.length > 0) {
          options.conversation.log(`Resume: Reopened panels: ${reopenedPanels.join(', ')}`, { fg: '244' });
        }
        if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
          options.conversation.log(`Resume: Remote re-entry -> /remote recover ${meta.returnContext.remoteRunners![0]}`, { fg: '244' });
        }
        if ((meta.returnContext.worktreePaths?.length ?? 0) > 0) {
          options.conversation.log('Resume: Worktree re-entry -> /worktree review', { fg: '244' });
        }
        if (returnContextMode === 'assisted') {
          const helperModel = new HelperModel({
            configManager: options.configManager,
            providerRegistry: options.providerRegistry,
          });
          void maybeAssistReturnContextSummary(options.configManager, helperModel, meta.returnContext).then((assisted) => {
            if (!assisted.assistedNarrative) return;
            options.conversation.log(`Resume: ${assisted.assistedNarrative}`, { fg: '244' });
            options.requestRender();
          });
        }
      }
      options.hookDispatcher.fire({
        path: 'Lifecycle:session:load',
        phase: 'Lifecycle',
        category: 'session',
        specific: 'load',
        sessionId: options.runtime.sessionId,
        timestamp: Date.now(),
        payload: { sessionId },
      }).catch((err: unknown) => logger.debug('Hook bridge fire error', {
        path: 'Lifecycle:session:load',
        error: summarizeError(err),
      }));
    } catch (error) {
      logger.debug('resumeSession failed', { error: summarizeError(error) });
      options.conversation.log('Failed to resume session.', { fg: '#ef4444' });
    }
    options.requestRender();
  };
}
