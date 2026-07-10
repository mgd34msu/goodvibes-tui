import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import { hasResumableWizardProgress, readOnboardingCheckMarker, readWizardProgress } from '../runtime/onboarding/index.ts';
import { startOnboardingFastPath } from '../runtime/onboarding/fast-path.ts';
import { readLastSessionPointer } from '@/runtime/index.ts';
import type { GoodVibesCliParseResult } from './types.ts';

export type TuiStartupShellPaths = Parameters<typeof readOnboardingCheckMarker>[0] & {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

export type FirstOpenTrustLevel = 'trusted' | 'restricted';

/** The decisions a first-open prompt choice resolves to. Absent halves were not asked. */
export interface FirstOpenDecision {
  readonly trust?: FirstOpenTrustLevel;
  readonly register?: 'yes' | 'no';
}

/**
 * decodeFirstOpenChoice — pure mapping from a chosen selection-item id (or null
 * on Escape/enter-through) to the trust + registration decisions, given which
 * halves the prompt actually offered. Kept pure so the combined-prompt semantics
 * are unit-testable without a live modal.
 *
 * Escape/enter-through (id === null) is the safe default: an offered trust half
 * settles to 'restricted' (matching the standalone trust prompt), and an offered
 * register half defaults to NO — recorded as a subtree-scoped decline so the
 * directory is not re-asked every startup.
 */
export function decodeFirstOpenChoice(
  id: string | null,
  offered: { readonly trustNeeded: boolean; readonly registerNeeded: boolean },
): FirstOpenDecision {
  const decision: { trust?: FirstOpenTrustLevel; register?: 'yes' | 'no' } = {};
  if (offered.trustNeeded && offered.registerNeeded) {
    // Combined 2x2 choice.
    const trust: FirstOpenTrustLevel = id === 'trust-register' || id === 'trust-only' ? 'trusted' : 'restricted';
    const register: 'yes' | 'no' = id === 'trust-register' || id === 'restrict-register' ? 'yes' : 'no';
    decision.trust = trust;
    decision.register = register;
  } else if (offered.trustNeeded) {
    decision.trust = id === 'trusted' ? 'trusted' : 'restricted';
  } else if (offered.registerNeeded) {
    decision.register = id === 'register' ? 'yes' : 'no';
  }
  return decision;
}

/** Build the selection rows for a first-open prompt given which halves apply. */
export function buildFirstOpenItems(offered: {
  readonly trustNeeded: boolean;
  readonly registerNeeded: boolean;
}): { readonly title: string; readonly items: SelectionItem[] } {
  if (offered.trustNeeded && offered.registerNeeded) {
    return {
      title: 'New workspace — trust level and registration',
      items: [
        { id: 'trust-register', label: 'Trust & register this workspace', detail: 'Full capability, and track it in your workspace registry', primaryAction: 'select' },
        { id: 'trust-only', label: 'Trust, don\'t register', detail: 'Full capability; leave it out of the registry', primaryAction: 'select' },
        { id: 'restrict-register', label: 'Keep restricted, register', detail: 'Read-only for now; still track it in the registry', primaryAction: 'select' },
        { id: 'restrict-only', label: 'Keep restricted, don\'t register', detail: 'Read-only exploration; nothing recorded (default)', primaryAction: 'select' },
      ],
    };
  }
  if (offered.trustNeeded) {
    return {
      title: 'New workspace — choose a trust level',
      items: [
        { id: 'trusted', label: 'Trust this workspace', detail: 'Full capability — all tools may run', primaryAction: 'select' },
        { id: 'restricted', label: 'Keep restricted (read-only)', detail: 'Explore safely; writes and commands are denied until trusted', primaryAction: 'select' },
      ],
    };
  }
  return {
    title: 'Register this directory as a workspace?',
    items: [
      { id: 'register', label: 'Register this workspace', detail: 'Track this project root in your workspace registry', primaryAction: 'select' },
      { id: 'skip', label: 'Don\'t register', detail: 'Leave it out; not asked again for this directory (default)', primaryAction: 'select' },
    ],
  };
}

/**
 * First-open workspace prompt — one surface folding the TUI-local trust gate and
 * the platform-wide registration half. When GoodVibes opens a workspace it has
 * no trust decision for, and/or one whose registration resolves UNKNOWN, ask
 * once (never two stacked modals): trust level AND "register this directory?".
 *
 * The two records are independent: a grandfathered-trusted workspace skips the
 * trust half but may still see the register half once; a covered/declined/broad
 * directory skips the register half. Escape/enter-through takes the safe default
 * (restricted, and a recorded decline for the register half).
 */
async function promptWorkspaceFirstOpen(commandContext: CommandContext, render: () => void): Promise<void> {
  const trustManager = commandContext.workspace?.workspaceTrustManager;
  const registrationManager = commandContext.workspace?.workspaceRegistrationManager;
  const trustNeeded = Boolean(trustManager && !trustManager.isDecided());
  const evaluation = registrationManager ? await registrationManager.evaluate() : null;
  const registerNeeded = Boolean(evaluation?.offerRegister);
  if (!trustNeeded && !registerNeeded) return;

  const offered = { trustNeeded, registerNeeded };
  const { title, items } = buildFirstOpenItems(offered);
  commandContext.openSelection?.(
    title,
    items,
    { allowSearch: false, primaryVerbLabel: 'Choose' },
    (result) => {
      const decision = decodeFirstOpenChoice(result?.item.id ?? null, offered);
      const apply = async () => {
        if (decision.trust && trustManager) await trustManager.setLevel(decision.trust);
        if (decision.register === 'yes' && registrationManager) await registrationManager.register();
        else if (decision.register === 'no' && registrationManager) await registrationManager.decline();
      };
      void apply().finally(render);
    },
  );
}

export function applyInitialTuiCliState(options: {
  readonly cli: GoodVibesCliParseResult;
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly shellPaths: TuiStartupShellPaths;
  readonly render: () => void;
}): Promise<void> | undefined {
  const { cli, input, commandRegistry, commandContext, shellPaths, render } = options;
  const globalOnboardingMarker = readOnboardingCheckMarker(shellPaths, 'user');

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
    // --continue: resume the last session tracked by the pointer file
    const lastId = readLastSessionPointer({
      workingDirectory: shellPaths.workingDirectory,
      homeDirectory: shellPaths.homeDirectory,
      surfaceRoot: 'tui',
    });
    if (lastId) {
      return commandRegistry.execute('session', ['resume', lastId], commandContext).then(() => render());
    }
  } else if (cli.flags.resume !== undefined) {
    // --resume [id]: explicit id dispatches directly; bare form (sentinel 'latest') resolves via pointer
    if (cli.flags.resume !== 'latest') {
      return commandRegistry.execute('session', ['resume', cli.flags.resume], commandContext).then(() => render());
    } else {
      const lastId = readLastSessionPointer({
        workingDirectory: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
        surfaceRoot: 'tui',
      });
      if (lastId) {
        return commandRegistry.execute('session', ['resume', lastId], commandContext).then(() => render());
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
    } else {
      // Returning user, no wizard to resume: this is the moment to ask, in one
      // surface, about a genuinely new workspace's trust level and whether to
      // register it — before they run anything here.
      void promptWorkspaceFirstOpen(commandContext, render);
    }
  }
}
