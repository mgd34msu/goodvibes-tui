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
import type { SessionSpineClient } from '@pellux/goodvibes-sdk/platform/runtime/session-spine';
import type { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { PanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resumeSessionCore } from '../core/session-resume-core.ts';
import type { SessionSurface } from '@/runtime/index.ts';

export interface ResumeSessionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtime: MutableRuntimeState;
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  readonly onSessionIdChanged?: (sessionId: string) => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  /** Fire-and-forget daemon-spine mirror. Reopen (not register) is the
   * ONLY resume-time verb — see the SDK session-spine client.ts header doc. */
  readonly sessionSpine: Pick<SessionSpineClient, 'reopen'>;
  readonly project: string;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly hookDispatcher: HookDispatcher;
  readonly sessionManager: SessionManager;
  readonly panelManager: PanelManager;
  /** The app's declare-once session-storage handle — the same one /session resume threads. */
  readonly surface: SessionSurface;
  /**
   * Multi-instance guard for this seam. Resolves false when the operator
   * declines to fork a session another terminal still has open. Optional so a
   * host without a modal surface keeps the seam's original behavior.
   */
  readonly confirmLiveResume?: (sessionId: string) => Promise<boolean>;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'get' | 'getCurrentModel' | 'getForModel' | 'require' | 'resolveModelPricing'>;
  /** See CommandSessionServices.hydrateSessionUsage (command-registry.ts). */
  readonly hydrateSessionUsage?: () => void;
  /**
   * Reselects the resumed session's saved model through the live provider
   * registry (matches session-workflow.ts's `/session resume` reselection
   * fallback — see core/session-resume-core.ts). Optional so a caller without
   * a provider API wired still gets the direct-assignment behavior this seam
   * always had.
   */
  readonly selectModel?: (model: string) => Promise<{ readonly registryKey: string; readonly providerId: string }>;
}

/**
 * Delegates the mechanical resume sequence to resumeSessionCore (the same
 * routine session-workflow.ts's `/session resume` calls) so the two seams
 * cannot diverge on restoreTurnAnchors, resetAll-before-fromJSON, model
 * reselection, or the modal-redirect panel-reopen skip — see
 * core/session-resume-core.ts's header doc for the full list of divergences
 * this closes. Everything below the resumeSessionCore call is plumbing only
 * this seam performs (hook fire, session-spine mirror, shared-broker
 * reopen, last-session pointer) plus this seam's own log/render idiom.
 */
export function createResumeSessionHandler(options: ResumeSessionOptions): (sessionId: string) => Promise<void> {
  return async (sessionId: string): Promise<void> => {
    try {
      // Multi-instance safety, matching what `/session resume` already does
      // for the text path: never fork a session another terminal is holding
      // open without the operator saying so.
      if (options.confirmLiveResume && !(await options.confirmLiveResume(sessionId))) {
        options.conversation.log('Resume cancelled — the session is still open in another terminal.', { fg: '244' });
        options.requestRender();
        return;
      }
      // Pre-read purely for the emitSessionResumed announcement's turnCount,
      // which reports the raw saved-snapshot size — resumeSessionCore performs
      // its own load() right after this (SessionManager.load is a cheap JSONL
      // parse; the tiny duplicate read keeps this announcement's meaning
      // unchanged rather than repurposing it to a post-replay count).
      const { messages: rawMessages } = options.sessionManager.load(sessionId);
      emitSessionResumed(options.runtimeBus, {
        sessionId: options.runtime.sessionId,
        traceId: `${options.runtime.sessionId}:session-resume:${sessionId}`,
        source: 'bootstrap',
      }, {
        sessionId,
        turnCount: rawMessages.length,
      });

      const outcome = await resumeSessionCore(sessionId, {
        sessionManager: options.sessionManager,
        conversation: options.conversation,
        runtime: options.runtime,
        surface: options.surface,
        panelManager: options.panelManager,
        selectModel: options.selectModel,
        hydrateSessionUsage: options.hydrateSessionUsage,
      });
      const { meta, panels } = outcome;

      options.onSessionIdChanged?.(sessionId);
      options.writeLastSessionPointer(sessionId);
      void options.sharedSessionBroker.reopenSession(sessionId).catch((err) => { logger.debug('session broker reopen session failed', { err }); });
      // Fire-and-forget spine mirror (reopen:true — the user resume verb).
      options.sessionSpine.reopen({ sessionId, project: options.project, title: options.conversation.title || meta.title });
      options.conversation.log(`Resumed session: ${sessionId}`, { fg: '135' });
      if (panels.movedToModal.length > 0) {
        options.conversation.log(`Resume: ${panels.movedToModal.join(', ')} moved to a modal — reopen via its command instead of as a panel.`, { fg: '244' });
      }
      if (panels.notReopened.length > 0) {
        options.conversation.log(`Resume: …and ${panels.notReopened.length} more not reopened (/panels to open)`, { fg: '244' });
      }
      const returnContextMode = getReturnContextMode(options.configManager);
      if (returnContextMode !== 'off' && meta.returnContext) {
        for (const line of formatReturnContextForDisplay(meta.returnContext)) {
          options.conversation.log(`Resume: ${line}`, { fg: '244' });
        }
        if (panels.reopened.length > 0) {
          options.conversation.log(`Resume: Reopened panels: ${panels.reopened.join(', ')}`, { fg: '244' });
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
