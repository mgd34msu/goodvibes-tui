/**
 * recovery-offer-wiring.ts — binds the startup recovery offer
 * (runtime/recovery-prompt.ts) to this shell's live objects.
 *
 * Kept out of main.ts so the entrypoint stays under the architecture
 * line-count gate, and kept out of recovery-prompt.ts so that module stays a
 * pure flow with injectable edges (which is what makes it testable without a
 * booted runtime).
 *
 * What accepting a snapshot actually does, and why each step is here:
 *   - `runtime.sessionId` moves to the snapshot's session, once the restore has
 *     actually happened. The transcript journal rebinds on that field
 *     (turn-event-wiring.ts), and every later turn snapshot keys off it.
 *     Without this the restored conversation would be written back under the
 *     fresh boot session id — the recovery point would be gone and its content
 *     would live somewhere the user never asked for. It moves AFTER the apply
 *     rather than before, so a refusal (nothing on disk, a damaged file) leaves
 *     this boot on its own session instead of adopting one it never loaded.
 *   - The conversation is rebuilt through the SDK's `applyRecoverySnapshot`,
 *     which reads and retires the snapshot in one operation and runs the same
 *     reset/fromJSON/rebuild + journal-replay sequence a normal resume runs.
 *     This module supplies the live conversation, the persist callback and the
 *     user's answer; nothing else about the restore is decided here.
 *   - The last-session pointer is written, so `--continue` on the next launch
 *     reaches the session the user just recovered.
 *   - Footer token counters are rehydrated from the restored history, so the
 *     numbers on screen describe the conversation actually in memory.
 */
import { applyRecoverySnapshot, confirmRecoveryRestore } from '@pellux/goodvibes-sdk/platform/runtime/operations';
import type { RecoveryPromptDeps } from './recovery-prompt.ts';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import type { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';

export interface RecoveryOfferWiringInput {
  readonly surface: SessionSurface;
  readonly sessionManager: Pick<SessionManager, 'save'>;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly conversation: ConversationManager;
  readonly commandContext: Pick<CommandContext, 'openSelection'> & {
    readonly session?: { readonly hydrateSessionUsage?: (() => void) | undefined } | undefined;
  };
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly receipt: (line: string) => void;
  readonly render: () => void;
}

export function buildRecoveryOfferWiring(input: RecoveryOfferWiringInput): RecoveryPromptDeps {
  return {
    surface: input.surface,
    // Read lazily: wireShellUiOpeners patches `openSelection` onto the command
    // context after this wiring is built, and the offer runs later still.
    get openSelection() { return input.commandContext.openSelection; },
    receipt: input.receipt,
    render: input.render,
    applySnapshot: ({ sessionId }) => {
      const persist = (messages: ConversationMessageSnapshot[]): void => {
        input.sessionManager.save(sessionId, messages as never[], {
          title: input.conversation.title || '',
          model: input.runtime.model,
          provider: input.runtime.provider,
          timestamp: Date.now(),
          // The user explicitly chose to recover this crashed session in the
          // modal. Expiring it out from under them on a later retention sweep
          // would undo the exact thing they just asked for.
          saveSource: 'user',
        });
      };
      // The user picked "Resume it" in the offer modal — that answer, and
      // nothing else, is what unlocks the restore.
      const result = applyRecoverySnapshot({
        sessionId,
        conversation: input.conversation,
        surface: input.surface,
        persistSnapshot: persist,
        confirmation: confirmRecoveryRestore(true)!,
      });
      // A refusal leaves this boot exactly as it was: the fresh session id
      // stands, nothing is persisted, and no last-session pointer is written.
      // The prompt turns the refusal into a receipt.
      if (!result.applied) return result;
      // Now that the conversation really is the recovered one, the runtime
      // moves to its session. The transcript journal rebinds on this field
      // (turn-event-wiring.ts) and every later turn snapshot keys off it, so
      // leaving it on the fresh boot session would write the restored
      // conversation back under an id the user never asked for. Both the
      // persist above and the one below name the session explicitly, so
      // neither depends on this assignment having happened first.
      input.runtime.sessionId = sessionId;
      // Unconditional, and the reason is the whole point of this feature: a
      // crash-recovery snapshot is NOT a session-store entry. The snapshot
      // file has just been retired by the read that loaded it, so until this
      // write lands the recovered conversation exists only in memory — the
      // pointer below would name a session nothing could load, and `/session
      // resume <id>` would still not reach it. The gap-closure persist above
      // only fires when the journal actually had records to replay, so it
      // cannot be relied on for this.
      persist(input.conversation.getMessageSnapshot() as ConversationMessageSnapshot[]);
      input.writeLastSessionPointer(sessionId);
      input.commandContext.session?.hydrateSessionUsage?.();
      return result;
    },
  };
}
