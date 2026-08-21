import type { CommandRegistry } from '../command-registry.ts';
import type { PanelDeepLinkTarget } from '../../panels/panel-manager.ts';
import { requirePanelManager } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/**
 * Parse `--target <id>[:<kind>]` out of the args following `<panel-id>
 * [top|bottom]` (item 4). Splits the args array in place (removing the
 * flag + its value) so positional `pane` parsing downstream is unaffected by
 * where the flag appears. Only `open fleet` currently has a deep-link
 * consumer (FleetPanel.receiveDeepLink), other panel ids just ignore an
 * unused target via PanelManager's optional-chaining delivery.
 */
function extractTargetFlag(rest: string[]): PanelDeepLinkTarget | undefined {
  const flagIdx = rest.indexOf('--target');
  if (flagIdx < 0) return undefined;
  const raw = rest[flagIdx + 1];
  rest.splice(flagIdx, 2);
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  return sep >= 0 ? { id: raw.slice(0, sep), kind: raw.slice(sep + 1) } : { id: raw };
}

export function registerOperatorPanelCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'panel',
    aliases: ['panels'],
    description: 'Open, place, resize, or list panels. Usage: /panel [open <id> [top|bottom]|close <id>|list|toggle|move|focus|split|width|height]',
    usage: '[open <id> [top|bottom] [--target <id>[:<kind>]]|close <id>|list|toggle|move <top|bottom|other> [id]|focus <top|bottom|toggle>|split [show|hide|toggle]|width <left|right|reset>|height <up|down|reset>]',
    argsHint: '<open|close|list|toggle|move|focus|split|width|height> [id]',
    handler(args, ctx) {
      const pm = requirePanelManager(ctx);
      const sub = args[0]?.toLowerCase() ?? '';
      if (!sub || sub === 'toggle') {
        // (the purge): 'panel-list' (the browse-all-panels picker) was
        // DELETE-disposition, a picker over a handful of panels is dead
        // weight now (see the Ctrl+P selectionModal repoint in
        // shell/ui-openers.ts for its interactive replacement). Bare
        // `/panel` and `/panel toggle` now do what "toggle" actually means:
        // toggle the workspace, which opens 'fleet' by default when nothing
        // is open (PanelManager.toggle()) rather than force-opening a
        // specific browse panel.
        pm.toggle();
        ctx.renderRequest();
      } else if (sub === 'list') {
        // Print a text listing instead of opening a picker panel, grouped
        // by category from the live registry, so this can never drift from
        // what's actually registered.
        const byCategory = pm.getTypesByCategory();
        const lines: string[] = [];
        for (const [category, entries] of byCategory) {
          lines.push(`${category}:`);
          for (const entry of entries) {
            lines.push(`  ${entry.icon} ${entry.id}: ${entry.name}`);
          }
        }
        ctx.print(lines.length > 0 ? lines.join('\n') : 'No panels registered.');
      } else if (sub === 'open') {
        const id = args[1];
        const rest = args.slice(2);
        const target = extractTargetFlag(rest);
        const pane = rest[0]?.toLowerCase();
        if (!id) { ctx.print('Usage: /panel open <panel-id>'); return; }
        if (pane && pane !== 'top' && pane !== 'bottom') {
          ctx.print('Usage: /panel open <panel-id> [top|bottom] [--target <id>[:<kind>]]');
          return;
        }
        try {
          // A MIGRATE-TO-MODAL id (e.g. 'sessions' -> the session-picker modal)
          // resolves to a modal, not a panel: opening it fires the redirect and
          // no panel lands in the workspace. Report that honestly rather than
          // claiming "Panel opened: <id>".
          const redirectTarget = pm.getModalRedirect(id);
          // focus rule 1a: the command path leaves focus in the composer
          // ("mid-command-flow"), showPanel does not grab panel focus here.
          // forward the deep-link target so the panel lands on the row.
          if (ctx.showPanel) ctx.showPanel(id, pane as 'top' | 'bottom' | undefined, target);
          else {
            pm.open(id, pane as 'top' | 'bottom' | undefined, target);
            pm.show();
            ctx.renderRequest();
          }
          if (redirectTarget) {
            ctx.print(`"${id}" moved to the ${redirectTarget} modal; opening it.`);
          } else {
            ctx.print(`Panel opened: ${id}${pane ? ` (${pane} pane)` : ''}`);
          }
        } catch (e) {
          // A deleted/unknown panel id throws "No panel type registered with
          // id: <id>" from PanelManager.open, surface the same friendly line
          // the bare-/panel path uses instead of leaking the raw error. Any
          // genuinely unexpected failure still shows its real message.
          const message = summarizeError(e);
          if (message.includes('No panel type registered with id')) {
            ctx.print(`Unknown panel "${id}". Use /panel list to see available panels.`);
          } else {
            ctx.print(`Error: ${message}`);
          }
        }
      } else if (sub === 'close') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /panel close <panel-id>'); return; }
        try {
          pm.close(id);
          ctx.focusPrompt?.();
          ctx.renderRequest();
          ctx.print(`Panel closed: ${id}`);
        } catch (e) {
          ctx.print(`Error: ${summarizeError(e)}`);
        }
      } else if (sub === 'move') {
        const dest = args[1]?.toLowerCase();
        if (dest !== 'top' && dest !== 'bottom' && dest !== 'other') {
          ctx.print('Usage: /panel move <top|bottom|other> [panel-id]');
          return;
        }
        const panelId = args[2];
        try {
          if (dest === 'other') pm.moveToOtherPane(panelId);
          else pm.moveToPane(dest, panelId);
          ctx.renderRequest();
          ctx.print(`Panel moved to ${dest} pane`);
        } catch (e) {
          ctx.print(`Error: ${summarizeError(e)}`);
        }
      } else if (sub === 'focus') {
        const pane = args[1]?.toLowerCase();
        if (pane !== 'top' && pane !== 'bottom' && pane !== 'toggle') {
          ctx.print('Usage: /panel focus <top|bottom|toggle>');
          return;
        }
        if (pane === 'toggle') pm.togglePaneFocus();
        else pm.focusPane(pane);
        ctx.renderRequest();
        ctx.print(`Focused ${pm.getFocusedPane()} pane`);
      } else if (sub === 'split') {
        const mode = args[1]?.toLowerCase() ?? 'toggle';
        if (mode !== 'toggle' && mode !== 'show' && mode !== 'hide') {
          ctx.print('Usage: /panel split [show|hide|toggle]');
          return;
        }
        if (mode === 'show' && !pm.isBottomPaneVisible()) pm.toggleBottomPane();
        if (mode === 'hide' && pm.isBottomPaneVisible()) pm.toggleBottomPane();
        if (mode === 'toggle') pm.toggleBottomPane();
        ctx.renderRequest();
        ctx.print(pm.isBottomPaneVisible() ? 'Bottom pane visible' : 'Bottom pane hidden');
      } else if (sub === 'width') {
        const dir = args[1]?.toLowerCase();
        if (dir !== 'left' && dir !== 'right' && dir !== 'reset') {
          ctx.print('Usage: /panel width <left|right|reset>');
          return;
        }
        if (dir === 'left') pm.widenLeft();
        else if (dir === 'right') pm.widenRight();
        else pm.setSplitRatio(0.6);
        ctx.renderRequest();
        ctx.print(`Panel width ratio: ${pm.getSplitRatio().toFixed(2)}`);
      } else if (sub === 'height') {
        const dir = args[1]?.toLowerCase();
        if (dir !== 'up' && dir !== 'down' && dir !== 'reset') {
          ctx.print('Usage: /panel height <up|down|reset>');
          return;
        }
        if (dir === 'up') pm.setVerticalSplitRatio(pm.getVerticalSplitRatio() - 0.05);
        else if (dir === 'down') pm.setVerticalSplitRatio(pm.getVerticalSplitRatio() + 0.05);
        else pm.setVerticalSplitRatio(0.5);
        ctx.renderRequest();
        ctx.print(`Panel height ratio: ${pm.getVerticalSplitRatio().toFixed(2)}`);
      } else {
        const id = args[0]!;
        try {
          // bare `/panel <id>` is the same command path as `/panel open
          // <id>`, composer stays focused.
          if (ctx.showPanel) ctx.showPanel(id);
          else {
            pm.open(id);
            pm.show();
            ctx.renderRequest();
          }
        } catch {
          ctx.print(`Unknown panel "${id}". Use /panel list to see available panels.`);
        }
      }
    },
  });
}
