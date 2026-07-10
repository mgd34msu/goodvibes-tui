/**
 * `/flags` — surface every feature flag grouped by state, with runtime toggling
 * for the flags that support it and a doctor section that names the "dark"
 * subsystems (built but disabled) alongside the command to switch each on.
 *
 * The flag registry and runtime state come from the FeatureFlagManager
 * (ctx.platform.featureFlagManager); persistence of an override goes through
 * the config `featureFlags` category, reusing persistFlagState so the on-disk
 * behavior matches the settings modal exactly.
 */

import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import type { FeatureFlag, FlagState } from '@/runtime/index.ts';
import { persistFlagState } from '../settings-modal-mutations.ts';

/** A flag paired with its live runtime state. */
export interface FlagSnapshotEntry {
  readonly flag: FeatureFlag;
  readonly state: FlagState;
}

const ENABLED_MARK = '●';
const DISABLED_MARK = '○';
const KILLED_MARK = '✕';

function toggleability(flag: FeatureFlag): string {
  return flag.runtimeToggleable ? 'runtime-toggleable' : 'startup-only';
}

function formatEntry(entry: FlagSnapshotEntry, mark: string): string {
  const { flag } = entry;
  const header = `  ${mark} ${flag.id}  —  ${flag.name}  [${toggleability(flag)}]`;
  const lines = [header, `      ${flag.description}`];
  if (entry.state === 'killed' && flag.killReason) {
    lines.push(`      killed: ${flag.killReason}`);
  }
  return lines.join('\n');
}

/** Build the grouped `/flags` overview text. Pure — exported for testing. */
export function formatFlagsOverview(entries: readonly FlagSnapshotEntry[]): string {
  if (entries.length === 0) return 'No feature flags are registered in this runtime.';

  const enabled = entries.filter((e) => e.state === 'enabled');
  const disabled = entries.filter((e) => e.state === 'disabled');
  const killed = entries.filter((e) => e.state === 'killed');

  const out: string[] = [`Feature flags (${entries.length} total)`, ''];

  out.push(`Enabled (${enabled.length}):`);
  out.push(enabled.length > 0 ? enabled.map((e) => formatEntry(e, ENABLED_MARK)).join('\n') : '  (none)');
  out.push('');

  out.push(`Disabled — built, dark (${disabled.length}):`);
  out.push(disabled.length > 0 ? disabled.map((e) => formatEntry(e, DISABLED_MARK)).join('\n') : '  (none)');

  if (killed.length > 0) {
    out.push('');
    out.push(`Killed (${killed.length}):`);
    out.push(killed.map((e) => formatEntry(e, KILLED_MARK)).join('\n'));
  }

  out.push('');
  out.push('Toggle runtime-toggleable flags:  /flags on <id>   /flags off <id>');
  out.push('Startup-only flags apply on next launch. Interactive toggling also lives in /settings.');
  out.push('See /flags doctor for dark subsystems you can switch on.');
  return out.join('\n');
}

/** Build the `/flags doctor` text: disabled (built, dark) flags + how to enable each. Pure. */
export function formatFlagsDoctor(entries: readonly FlagSnapshotEntry[]): string {
  const dark = entries.filter((e) => e.state === 'disabled');
  if (dark.length === 0) {
    return 'Feature flag doctor: no dark subsystems — every built flag is enabled or killed.';
  }
  const out: string[] = [
    `Feature flag doctor — ${dark.length} dark subsystem${dark.length === 1 ? '' : 's'} (built but disabled):`,
    '',
  ];
  for (const entry of dark) {
    const { flag } = entry;
    out.push(`  ${DISABLED_MARK} ${flag.id}  —  ${flag.name}`);
    out.push(`      ${flag.description}`);
    if (flag.runtimeToggleable) {
      out.push(`      enable now:   /flags on ${flag.id}`);
    } else {
      out.push(`      enable (next launch, startup-only):   /flags on ${flag.id}`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** Snapshot the manager's flags into a stable, tier-then-id-sorted list. */
function snapshotEntries(ctx: CommandContext): FlagSnapshotEntry[] {
  const manager = ctx.platform.featureFlagManager;
  if (!manager) return [];
  return Array.from(manager.getAll().values())
    .map(({ flag, state }) => ({ flag, state }))
    .sort((a, b) => (a.flag.tier - b.flag.tier) || a.flag.id.localeCompare(b.flag.id));
}

function applyToggle(ctx: CommandContext, id: string, target: 'enabled' | 'disabled'): void {
  const manager = ctx.platform.featureFlagManager;
  if (!manager) {
    ctx.print('Feature flags are not available in this runtime.');
    return;
  }
  const entry = snapshotEntries(ctx).find((e) => e.flag.id === id);
  if (!entry) {
    ctx.print(`Unknown feature flag: ${id}. Run /flags to list them.`);
    return;
  }
  if (entry.state === target) {
    ctx.print(`Flag ${id} is already ${target}.`);
    return;
  }
  const { flag } = entry;

  if (flag.runtimeToggleable) {
    try {
      if (target === 'enabled') manager.enable(flag.id);
      else manager.disable(flag.id);
    } catch (err) {
      ctx.print(`Could not ${target === 'enabled' ? 'enable' : 'disable'} ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    persistFlagState(ctx.platform.configManager, flag.id, target, flag.defaultState);
    ctx.print(`Flag ${id} is now ${target} (runtime + persisted).`);
    ctx.renderRequest();
    return;
  }

  // Startup-only: cannot flip live; persist so it applies on next launch.
  persistFlagState(ctx.platform.configManager, flag.id, target, flag.defaultState);
  ctx.print(`Flag ${id} is startup-only. Saved ${target} — it applies on next launch.`);
}

export function registerFlagsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'flags',
    description: 'List feature flags by state, toggle runtime-toggleable ones, and surface dark subsystems',
    usage: '[list|on <id>|off <id>|doctor]',
    argsHint: '[on|off <id> | doctor]',
    handler(args, ctx) {
      const sub = (args[0] ?? 'list').toLowerCase();
      switch (sub) {
        case 'list':
        case 'ls':
          ctx.print(formatFlagsOverview(snapshotEntries(ctx)));
          return;
        case 'doctor':
          ctx.print(formatFlagsDoctor(snapshotEntries(ctx)));
          return;
        case 'on':
        case 'enable': {
          const id = args[1];
          if (!id) { ctx.print('Usage: /flags on <id>'); return; }
          applyToggle(ctx, id, 'enabled');
          return;
        }
        case 'off':
        case 'disable': {
          const id = args[1];
          if (!id) { ctx.print('Usage: /flags off <id>'); return; }
          applyToggle(ctx, id, 'disabled');
          return;
        }
        default:
          ctx.print(`Unknown /flags subcommand: ${sub}. Use: list | on <id> | off <id> | doctor`);
      }
    },
  });
}
