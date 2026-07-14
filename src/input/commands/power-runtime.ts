import type { CommandRegistry } from '../command-registry.ts';
import { powerStatusLines } from '../../core/power-status.ts';

// ---------------------------------------------------------------------------
// /power — host sleep ownership (the ops/status idiom surface for power.*).
//
// Shows the honest account of sleep ownership — the "sleep disabled" chip
// meaning, each "held because X" work-inhibition reason, and the lid-split note
// rendered VERBATIM when the OS could block idle-sleep but not lid-close
// suspend — and toggles the daemon-held keep-awake switch. Owner ruling: the
// always-visible chip IS the safety mechanism, so there is no timer and no
// AC-only option — keep-awake is exactly one on/off toggle.
// ---------------------------------------------------------------------------

export function registerPowerRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'power',
    description: 'Host sleep ownership — show status and toggle keep-awake',
    usage: '[status | on | off | toggle]',
    argsHint: '[status|on|off|toggle]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'status').toLowerCase();

      if (sub === 'status' || args.length === 0) {
        const state = ctx.getPowerState?.();
        if (!state) {
          ctx.print('Power status is unavailable in this session.');
          return;
        }
        const lines = ['Host sleep ownership:', ...powerStatusLines(state).map((l) => `  ${l}`)];
        lines.push(state.keepAwake
          ? 'Keep-awake is ON. Turn it off with /power off.'
          : 'Keep-awake is OFF. Turn it on with /power on.');
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'on' || sub === 'off' || sub === 'toggle') {
        if (!ctx.setKeepAwake || !ctx.getPowerState) {
          ctx.print('Keep-awake cannot be changed in this session.');
          return;
        }
        const current = ctx.getPowerState().keepAwake;
        const next = sub === 'on' ? true : sub === 'off' ? false : !current;
        const state = await ctx.setKeepAwake(next);
        const lines = [state.keepAwake ? 'Keep-awake ON — this host will not idle-sleep.' : 'Keep-awake OFF.'];
        // Surface the honest lid-split note verbatim if the SDK served one.
        if (state.note) lines.push(`  ${state.note}`);
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print('Usage: /power [status | on | off | toggle]');
    },
  });
}
