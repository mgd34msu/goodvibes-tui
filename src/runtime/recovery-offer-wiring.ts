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
 *   - `runtime.sessionId` moves to the snapshot's session FIRST. The
 *     transcript journal rebinds on that field (turn-event-wiring.ts), and
 *     every later turn snapshot keys off it. Without this the restored
 *     conversation would be written back under the fresh boot session id —
 *     the recovery point would be gone and its content would live somewhere
 *     the user never asked for.
 *   - The conversation is rebuilt through core/session-recovery.ts's
 *     `applyRecoverySnapshot`, which runs the same reset/fromJSON/rebuild +
 *     journal-replay sequence a normal resume runs.
 *   - The last-session pointer is written, so `--continue` on the next launch
 *     reaches the session the user just recovered.
 *   - Footer token counters are rehydrated from the restored history, so the
 *     numbers on screen describe the conversation actually in memory.
 */
import { applyRecoverySnapshot, type RecoverySnapshotPayload } from '../core/session-recovery.ts';
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
    applySnapshot: ({ snapshot, sessionId }) => {
      input.runtime.sessionId = sessionId;
      const payload = snapshot as unknown as RecoverySnapshotPayload;
      const persist = (messages: ConversationMessageSnapshot[]): void => {
        input.sessionManager.save(sessionId, messages as never[], {
          title: input.conversation.title || payload.title || '',
          model: input.runtime.model,
          provider: input.runtime.provider,
          timestamp: Date.now(),
          // The user explicitly chose to recover this crashed session in the
          // modal. Expiring it out from under them on a later retention sweep
          // would undo the exact thing they just asked for.
          saveSource: 'user',
        });
      };
      const { messageCount } = applyRecoverySnapshot({
        snapshot: payload,
        sessionId,
        conversation: input.conversation,
        surface: input.surface,
        persistSnapshot: persist,
      });
      // Unconditional, and the reason is the whole point of this feature: a
      // crash-recovery snapshot is NOT a session-store entry. The snapshot
      // file has just been retired by consumeRecovery, so until this write
      // lands the recovered conversation exists only in memory — the pointer
      // below would name a session nothing could load, and `/session resume
      // <id>` would still not reach it. The gap-closure persist above only
      // fires when the journal actually had records to replay, so it cannot
      // be relied on for this.
      persist(input.conversation.getMessageSnapshot() as ConversationMessageSnapshot[]);
      input.writeLastSessionPointer(sessionId);
      input.commandContext.session?.hydrateSessionUsage?.();
      return messageCount;
    },
  };
}
