import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { SelectionItem } from '../input/selection-modal.ts';
import { hasResumableWizardProgress, readOnboardingCheckMarker, readWizardProgress } from '../runtime/onboarding/index.ts';
import { readLastSessionPointer } from '@/runtime/index.ts';
import type { GoodVibesCliParseResult } from './types.ts';

export type TuiStartupShellPaths = Parameters<typeof readOnboardingCheckMarker>[0] & {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
};

/**
 * First-run workspace trust prompt. When GoodVibes opens a workspace it has no
 * trust decision for, ask before any tool runs whether to trust it (full
 * capability) or keep it restricted (read-only exploration). Dismissing the
 * prompt leaves it restricted — the safe default. Grandfathered workspaces
 * (prior GoodVibes state) are already decided, so this is a no-op for them.
 */
function promptWorkspaceTrustIfUndecided(commandContext: CommandContext, render: () => void): void {
  const manager = commandContext.workspace.workspaceTrustManager;
  if (!manager || manager.isDecided()) return;
  const items: SelectionItem[] = [
    { id: 'trusted', label: 'Trust this workspace', detail: 'Full capability — all tools may run', primaryAction: 'select' },
    { id: 'restricted', label: 'Keep restricted (read-only)', detail: 'Explore safely; writes and commands are denied until trusted', primaryAction: 'select' },
  ];
  commandContext.openSelection?.(
    'New workspace — choose a trust level',
    items,
    { allowSearch: false, primaryVerbLabel: 'Choose' },
    (result) => {
      const level = result?.item.id === 'trusted' ? 'trusted' : 'restricted';
      void manager.setLevel(level);
      render();
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
    input.openOnboardingWizard({ mode: 'new', reset: true });
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
      // Returning user, no wizard to resume: this is the moment to ask about a
      // genuinely new workspace's trust level, before they run anything here.
      promptWorkspaceTrustIfUndecided(commandContext, render);
    }
  }
}
