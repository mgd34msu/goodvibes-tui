import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import { readOnboardingCheckMarker } from '../runtime/onboarding/index.ts';
import type { GoodVibesCliParseResult } from './types.ts';

export function applyInitialTuiCliState(options: {
  readonly cli: GoodVibesCliParseResult;
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly shellPaths: Parameters<typeof readOnboardingCheckMarker>[0];
  readonly render: () => void;
}): void {
  const { cli, input, commandRegistry, commandContext, shellPaths, render } = options;
  const globalOnboardingMarker = readOnboardingCheckMarker(shellPaths, 'user');
  if (cli.command === 'onboarding') {
    input.openOnboardingWizard({ mode: 'edit', reset: true });
  } else if (cli.command === 'sessions' && cli.commandArgs[0] === 'resume') {
    const target = cli.commandArgs.slice(1).join(' ').trim();
    if (target) {
      void commandRegistry.execute('session', ['resume', target], commandContext).then(() => render());
    }
  } else if (!globalOnboardingMarker.exists) {
    input.openOnboardingWizard({ mode: 'new', reset: true });
  }

  const seededPrompt = cli.flags.prompt ?? (cli.rawCommand === undefined && cli.positionals.length > 0 ? cli.positionals.join(' ') : undefined);
  if (seededPrompt) {
    input.prompt = seededPrompt;
    input.cursorPos = seededPrompt.length;
  }
}
