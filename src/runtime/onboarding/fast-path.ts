/**
 * fast-path.ts — minimum-steps first run.
 *
 * The full onboarding wizard is comprehensive but long (5+ steps for a brand
 * new user). The fast path gets a new user to a working session in the fewest
 * possible steps:
 *   - If a provider API key is already configured (env / secrets), skip
 *     onboarding entirely — write the check marker and drop straight into a
 *     working session. ZERO steps.
 *   - Otherwise ask exactly one question: start now on the free default model,
 *     or run the full guided setup. Dismissing (Esc) starts now — so it is
 *     always skippable.
 *
 * The full wizard remains one keystroke away (the "Full guided setup" choice,
 * or `/onboarding` at any time). If the command context can't answer whether a
 * provider is configured (e.g. a headless/test surface), we fall back to the
 * classic behavior of opening the wizard, so nothing regresses.
 */
import type { CommandContext } from '../../input/command-registry.ts';
import type { SelectionItem } from '../../input/selection-modal.ts';
import { writeOnboardingCheckMarker } from './markers.ts';
import type { WriteOnboardingCheckMarkerOptions } from './types.ts';

type OnboardingMarkerShellPaths = Parameters<typeof writeOnboardingCheckMarker>[0];

export interface OnboardingFastPathDeps {
  readonly input: { openOnboardingWizard: (options: { mode: 'new'; reset: boolean }) => void };
  readonly commandContext: CommandContext;
  readonly shellPaths: OnboardingMarkerShellPaths;
  readonly render: () => void;
}

/** Read configured provider ids defensively — returns [] if the surface can't answer. */
function readConfiguredProviderIds(commandContext: CommandContext): string[] | null {
  const registry = commandContext.provider?.providerRegistry;
  if (!registry || typeof registry.getConfiguredProviderIds !== 'function') return null;
  try {
    return registry.getConfiguredProviderIds();
  } catch {
    return null;
  }
}

const MARKER_OPTIONS: WriteOnboardingCheckMarkerOptions = { source: 'command' };

/**
 * Run the fast-path first-run flow. Returns nothing; side effects (wizard open,
 * marker write, modal) happen through the injected deps.
 */
export function startOnboardingFastPath(deps: OnboardingFastPathDeps): void {
  const { input, commandContext, shellPaths, render } = deps;
  const openWizard = (): void => input.openOnboardingWizard({ mode: 'new', reset: true });

  const configured = readConfiguredProviderIds(commandContext);
  // Fall back to the classic wizard if we can't detect providers or can't prompt.
  if (configured === null || !commandContext.openSelection) {
    openWizard();
    return;
  }

  if (configured.length > 0) {
    // A provider key already exists — nothing to ask. Straight to a working session.
    writeOnboardingCheckMarker(shellPaths, MARKER_OPTIONS);
    commandContext.print?.(
      `Ready — provider configured (${configured.join(', ')}). Run /onboarding anytime for full setup.`,
    );
    render();
    return;
  }

  const items: SelectionItem[] = [
    { id: 'start-now', label: 'Start now', detail: 'Use the free default model — no API key needed', primaryAction: 'select' },
    { id: 'full-setup', label: 'Full guided setup', detail: 'Choose provider, model, channels, and more', primaryAction: 'select' },
  ];
  commandContext.openSelection(
    'Welcome to GoodVibes — get started',
    items,
    { allowSearch: false, primaryVerbLabel: 'Choose' },
    (result) => {
      if (result?.item.id === 'full-setup') {
        openWizard();
        return;
      }
      // Start now (or dismissed): mark first-run done and drop into a working
      // session on the free default model.
      writeOnboardingCheckMarker(shellPaths, MARKER_OPTIONS);
      commandContext.print?.(
        'You\'re on the free default model. Add a provider key anytime with /provider, or run /onboarding for full setup.',
      );
      render();
    },
  );
}
