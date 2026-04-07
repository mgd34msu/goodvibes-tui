import { getPanelManager } from '../../panels/panel-manager.ts';
import type { CommandRegistry } from '../command-registry.ts';

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'welcome',
    aliases: ['guide'],
    description: 'Open the guided start surface for setup, security, marketplace, remote, and operator workflows',
    usage: '[open|print]',
    handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        const panelManager = getPanelManager();
        panelManager.open('welcome');
        panelManager.show();
        return;
      }
      if (sub === 'print') {
        ctx.print([
          'Welcome To GoodVibes',
          '  /setup onboarding   - first-run checklist and doctor flows',
          '  /sandbox review     - inspect VM isolation posture',
          '  /marketplace open   - browse curated plugins, skills, hook packs, and policy packs',
          '  /remote setup       - review bridge, tunnel, env, and bootstrap flows',
          '  /security           - review trust posture, policy pressure, and incidents',
          '  /cockpit            - unified operator control room',
        ].join('\n'));
        return;
      }
      ctx.print('Usage: /welcome [open|print]');
    },
  });
}
