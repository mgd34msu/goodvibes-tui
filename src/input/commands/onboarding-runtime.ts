import type { CommandRegistry } from '../command-registry.ts';
import { openOnboardingWizard } from './runtime-services.ts';

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'onboarding',
    description: 'Open the onboarding wizard with current settings preloaded for review and editing',
    usage: '',
    handler(_args, ctx) {
      openOnboardingWizard(ctx, { mode: 'edit', reset: true });
      ctx.print('Opening onboarding wizard.');
    },
  });
}
