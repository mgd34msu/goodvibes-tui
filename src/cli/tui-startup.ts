import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import type { WorkspaceRegistrationManager } from '../runtime/trust/workspace-registration.ts';
import { hasResumableWizardProgress, readOnboardingCheckMarker, readWizardProgress } from '../runtime/onboarding/index.ts';
import { startOnboardingFastPath } from '../runtime/onboarding/fast-path.ts';
import { checkRecoveryForSession, readLastSessionPointer, type SessionSurface } from '@/runtime/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { offerRecoverySnapshot } from '../runtime/recovery-prompt.ts';
import { buildRecoveryOfferWiring } from '../runtime/recovery-offer-wiring.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { SessionManager } from '@pellux/goodvibes-sdk/platform/sessions';
import type { GoodVibesCliParseResult } from './types.ts';

export type TuiStartupShellPaths = Parameters<typeof readOnboardingCheckMarker>[0] & {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

export type FirstOpenTrustLevel = 'trusted' | 'restricted';

/**
 * What `resumeNamedSessionWithRecoveryCheck` needs to actually APPLY an
 * accepted crash-recovery snapshot — the same shape `buildRecoveryOfferWiring`
 * (runtime/recovery-offer-wiring.ts) takes, minus `surface` and
 * `commandContext` which this module already has in scope. Optional: a caller
 * that omits it (or a snapshot-free boot) gets exactly today's behavior —
 * straight resume from the durable store, no modal.
 */
export interface TuiStartupRecoveryDeps {
  readonly sessionManager: Pick<SessionManager, 'save'>;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly conversation: ConversationManager;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly receipt: (line: string) => void;
}

/**
 * resumeNamedSessionWithRecoveryCheck — the pre-resume guard for `--continue`
 * and the bare `--resume` (pointer) path.
 *
 * Resuming a named session straight from its durable store is exactly the
 * post-crash reflex that silently drops an autosave tail: if that session
 * also has a crash-recovery snapshot NEWER than its store, the snapshot (not
 * the shorter store copy) is the live state. `checkRecoveryForSession` is the
 * read-only probe for that; when it finds one, this routes through the same
 * ask-then-retire modal flow the general boot offer uses
 * (runtime/recovery-prompt.ts), scoped to this one session via
 * `targetSessionId` — never auto-applied.
 *
 *   - No live snapshot (or `recovery` deps not wired): straight resume, same
 *     as before this check existed.
 *   - Resume chosen: the snapshot is applied (via `buildRecoveryOfferWiring`'s
 *     `applySnapshot`, which rebinds the runtime session id and replays any
 *     journal tail) and the plain store resume is skipped — the snapshot IS
 *     the more complete copy.
 *   - "Not now" (or a dismissal, or a failed load): falls through to the
 *     plain store resume, after the follow-up Keep/Remove question the
 *     established flow always asks on decline.
 *
 * The modal itself is deferred to the next macrotask, mirroring
 * `scheduleRecoveryOffer`'s own reasoning: `applyInitialTuiCliState` runs
 * before the shell's first render, so asking a question here synchronously
 * would draw it at a blank terminal. The synchronous `checkRecoveryForSession`
 * probe above needs no such deferral — only opening the modal does.
 */
async function resumeNamedSessionWithRecoveryCheck(options: {
  readonly sessionId: string;
  readonly surface: SessionSurface;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly render: () => void;
  readonly recovery: TuiStartupRecoveryDeps | undefined;
}): Promise<void> {
  const { sessionId, surface, commandRegistry, commandContext, render, recovery } = options;
  const plainResume = (): Promise<void> =>
    commandRegistry.execute('session', ['resume', sessionId], commandContext).then(() => render());

  if (!recovery) {
    await plainResume();
    return;
  }

  const info = checkRecoveryForSession(surface, sessionId);
  if (!info) {
    await plainResume();
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const deps = buildRecoveryOfferWiring({
            surface,
            sessionManager: recovery.sessionManager,
            runtime: recovery.runtime,
            conversation: recovery.conversation,
            commandContext,
            writeLastSessionPointer: recovery.writeLastSessionPointer,
            receipt: recovery.receipt,
            render,
          });
          const outcome = await offerRecoverySnapshot({ ...deps, targetSessionId: sessionId });
          if (outcome !== 'resumed') {
            await plainResume();
          }
        } catch {
          // Best-effort by construction (mirrors offerRecoverySnapshot's own
          // guarantee): a failure here must fall back to the plain resume
          // rather than leave the boot with nothing resumed at all.
          await plainResume().catch(() => {
            // A failing plain resume here is no worse than the pre-existing
            // behavior when session resume itself fails.
          });
        } finally {
          resolve();
        }
      })();
    }, 0);
    timer.unref?.();
  });
}

/**
 * decodeFirstOpenChoice — pure mapping from a chosen selection-item id (or
 * null on Escape/enter-through) to the trust decision. Kept pure so the
 * consequence-time trust prompt's semantics (raised by trustGatedAsk, wired
 * in main.ts's trustPromptRef.requestTrustDecision) are unit-testable
 * without a live modal. Escape/enter-through (id === null) is the safe
 * default: 'restricted'.
 */
export function decodeFirstOpenChoice(id: string | null): FirstOpenTrustLevel {
  return id === 'trusted' ? 'trusted' : 'restricted';
}

/**
 * Build the selection rows for the trust prompt. This used to also offer a
 * "register this directory?" half (a combined 2x2 when both were needed) —
 * that half is gone: registration self-records (see
 * selfRecordWorkspaceRegistration below) rather than ever asking a question
 * about a registry the user hasn't met yet.
 */
export function buildFirstOpenItems(): { readonly title: string; readonly items: SelectionItem[] } {
  return {
    title: 'New workspace — choose a trust level',
    items: [
      { id: 'trusted', label: 'Trust this workspace', detail: 'Full capability — all tools may run', primaryAction: 'select' },
      { id: 'restricted', label: 'Keep restricted (read-only)', detail: 'Explore safely; writes and commands are denied until trusted', primaryAction: 'select' },
    ],
  };
}

/**
 * Registration self-records: a workspace the user actually works in becomes
 * its own registry entry with no question ever asked (the former "Register
 * this directory as a workspace?" prompt — sometimes a four-option 2x2 when
 * trust was undecided too — is gone entirely).
 *
 * "Actually works in" is anchored to TRUST, not mere directory-open: this is
 * only ever called for a workspace that is (or has just become) trusted,
 * never for one that's merely been glanced at read-only. Labeled 'via TUI'
 * in the shared registry so its provenance is honest.
 *
 * OWNER-BOUNDARY RIDER (binding): self-recording must not widen the
 * checkpoint-owning consumer's boundary. That boundary now reads the SAME
 * shared registration store this writes to, gated by each record's
 * `checkpointEligible` flag (absent means false). So the separation is no
 * longer "a separate list the agent owns" — it is one store, and this self
 * record stays out of scope by stamping its `origin` ('tui') for honest
 * provenance while NEVER setting `checkpointEligible`. Only the consumer that
 * owns checkpointing re-stamps its own roots eligible on boot.
 */
export async function selfRecordWorkspaceRegistration(
  registrationManager: Pick<WorkspaceRegistrationManager, 'evaluate' | 'register'> | undefined,
): Promise<void> {
  if (!registrationManager) return;
  const evaluation = await registrationManager.evaluate();
  if (!evaluation.offerRegister) return;
  await registrationManager.register('via TUI', 'tui');
}

export function applyInitialTuiCliState(options: {
  readonly cli: GoodVibesCliParseResult;
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly shellPaths: TuiStartupShellPaths;
  /**
   * The app's declare-once session-storage handle — the SAME one the runtime
   * writes the last-session pointer through. `--continue` and bare `--resume`
   * read that pointer below; deriving its path independently here is exactly
   * how this read used to land on a file nothing ever wrote.
   */
  readonly surface: SessionSurface;
  readonly render: () => void;
  /**
   * Enables the crash-recovery check ahead of `--continue` / bare `--resume`
   * (see `resumeNamedSessionWithRecoveryCheck` above). Omitted, the two flags
   * resume straight from the durable store exactly as before this check
   * existed — main.ts always wires this; only tests that don't care about
   * recovery snapshots leave it out.
   */
  readonly continueRecovery?: TuiStartupRecoveryDeps;
}): Promise<void> | undefined {
  const { cli, input, commandRegistry, commandContext, shellPaths, surface, render, continueRecovery } = options;
  const globalOnboardingMarker = readOnboardingCheckMarker(shellPaths, 'user');

  // Registration self-records on every launch of an already-trusted
  // workspace (fire-and-forget — never blocks or gates startup, never a
  // modal). A workspace that is undecided or restricted is never
  // self-registered here; for one that becomes trusted just now (via the
  // consequence-time trust prompt), main.ts's trustPromptRef wiring calls
  // this same helper right after the decision.
  if (commandContext.workspace?.workspaceTrustManager?.isTrusted()) {
    void selfRecordWorkspaceRegistration(commandContext.workspace.workspaceRegistrationManager);
  }

  // Seeded prompt is always applied synchronously, regardless of session branch.
  const seededPrompt = cli.flags.prompt ?? (cli.rawCommand === undefined && cli.positionals.length > 0 ? cli.positionals.join(' ') : undefined);
  if (seededPrompt) {
    input.prompt = seededPrompt;
    input.cursorPos = seededPrompt.length;
  }

  if (cli.command === 'onboarding') {
    input.openOnboardingWizard({ mode: 'edit', reset: true });
  } else if (cli.command === 'sessions' && cli.commandArgs[0] === 'resume') {
    const target = cli.commandArgs.slice(1).join(' ').trim();
    if (target) {
      return commandRegistry.execute('session', ['resume', target], commandContext).then(() => render());
    }
  } else if (cli.flags.continueLast) {
    // --continue: resume the last session tracked by the pointer file. Checked
    // for a live crash-recovery snapshot first — see
    // resumeNamedSessionWithRecoveryCheck's doc comment.
    const lastId = readLastSessionPointer({ surface });
    if (lastId) {
      return resumeNamedSessionWithRecoveryCheck({ sessionId: lastId, surface, commandRegistry, commandContext, render, recovery: continueRecovery });
    }
  } else if (cli.flags.resume !== undefined) {
    // --resume [id]: explicit id dispatches directly; bare form (sentinel 'latest') resolves via pointer
    if (cli.flags.resume !== 'latest') {
      return commandRegistry.execute('session', ['resume', cli.flags.resume], commandContext).then(() => render());
    } else {
      const lastId = readLastSessionPointer({ surface });
      if (lastId) {
        return resumeNamedSessionWithRecoveryCheck({ sessionId: lastId, surface, commandRegistry, commandContext, render, recovery: continueRecovery });
      }
    }
  } else if (cli.flags.fork !== undefined) {
    // --fork [id]: fork specific session (true = bare fork-current; string = explicit id to resume then fork)
    if (cli.flags.fork === true) {
      // Bare --fork: fork the current session without a prior resume
      return commandRegistry.execute('session', ['fork'], commandContext).then(() => render());
    } else {
      // Explicit id: resume the named session first, then fork
      return commandRegistry.execute('session', ['resume', cli.flags.fork], commandContext)
        .then(() => commandRegistry.execute('session', ['fork'], commandContext))
        .then(() => render());
    }
  } else if (!globalOnboardingMarker.exists) {
    // Fast path: get a brand-new user to a working session in the fewest steps.
    // Falls back to the full wizard when the surface can't detect providers.
    // Trust stays undecided here on purpose — the first non-read tool
    // request is what raises the trust question now (see main.ts's
    // trustPromptRef), not this startup branch.
    startOnboardingFastPath({ input, commandContext, shellPaths, render });
  } else {
    // User has completed onboarding before but left a wizard session in progress.
    // Reopen the wizard at the last saved step so they can continue or dismiss.
    const progressState = readWizardProgress(shellPaths);
    if (hasResumableWizardProgress(shellPaths, { state: progressState })) {
      const { payload } = progressState;
      if (payload !== null) {
        input.openOnboardingWizard({
          mode: payload.mode,
          reset: true,
          preload: (wizard) => {
            wizard.setStep(payload.stepIndex);
            for (const [fieldId, value] of payload.toggleState) wizard.toggleState.set(fieldId, value);
            for (const [fieldId, value] of payload.radioState) wizard.radioState.set(fieldId, value);
            for (const [fieldId, value] of payload.textState) wizard.textState.set(fieldId, value);
          },
        });
      }
    }
    // Returning user, no wizard to resume, nothing else to do at startup:
    // trust (if still undecided) is asked at the first non-read tool
    // request, not here — see main.ts's trustPromptRef wiring.
  }
}

/**
 * reportFatalStartupError — the main() catch handler. A bare Error
 * JSON-serializes to {} in structured logs, and background timers keep the
 * process alive after a boot failure — the historical result was a blank
 * screen and a useless `Fatal error {"error": {}}` log line. Log real
 * fields, tell the user what broke, and exit. Both writes are individually
 * best-effort — a failing logger or torn-down stderr must never hide the
 * original launch failure.
 */
export function reportFatalStartupError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  try {
    logger.error('Fatal error', { message, ...(stack ? { stack } : {}) });
  } catch {
    // Startup diagnostics must never hide the original launch failure.
  }
  try {
    process.stderr.write(`goodvibes failed to start: ${message}\n${stack ? `${stack}\n` : ''}`);
  } catch {
    // Ignore secondary stderr failures during process teardown.
  }
  process.exit(1);
}
