import type { CommandRegistry } from '../command-registry.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';

export function registerOperatorPanelCommand(registry: CommandRegistry): void {
  registry.register({
    name: 'panel',
    aliases: ['panels', 'p'],
    description: 'Open, place, resize, or list panels. Usage: /panel [open <id> [top|bottom]|close <id>|list|toggle|move|focus|split|width|height]',
    usage: '[open <id> [top|bottom]|close <id>|list|toggle|move <top|bottom|other> [id]|focus <top|bottom|toggle>|split [show|hide|toggle]|width <left|right|reset>|height <up|down|reset>]',
    argsHint: '<open|close|list|toggle|move|focus|split|width|height> [id]',
    handler(args, ctx) {
      const pm = getPanelManager();
      const sub = args[0]?.toLowerCase() ?? '';
      if (!sub || sub === 'toggle') {
        try {
          if (ctx.showPanel) ctx.showPanel('panel-list');
          else {
            pm.open('panel-list');
            pm.show();
            ctx.renderRequest();
          }
        } catch {
          pm.toggle();
          ctx.renderRequest();
        }
      } else if (sub === 'list') {
        try {
          if (ctx.showPanel) ctx.showPanel('panel-list');
          else {
            pm.open('panel-list');
            pm.show();
            ctx.renderRequest();
          }
        } catch {
          pm.show();
          ctx.renderRequest();
        }
      } else if (sub === 'open') {
        const id = args[1];
        const pane = args[2]?.toLowerCase();
        if (!id) { ctx.print('Usage: /panel open <panel-id>'); return; }
        if (pane && pane !== 'top' && pane !== 'bottom') {
          ctx.print('Usage: /panel open <panel-id> [top|bottom]');
          return;
        }
        try {
          if (ctx.showPanel) ctx.showPanel(id, pane as 'top' | 'bottom' | undefined);
          else {
            pm.open(id, pane as 'top' | 'bottom' | undefined);
            pm.show();
            ctx.renderRequest();
          }
          ctx.print(`Panel opened: ${id}${pane ? ` (${pane} pane)` : ''}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
        }
      } else if (sub === 'close') {
        const id = args[1];
        if (!id) { ctx.print('Usage: /panel close <panel-id>'); return; }
        try {
          pm.close(id);
          ctx.renderRequest();
          ctx.print(`Panel closed: ${id}`);
        } catch (e) {
          ctx.print(`Error: ${(e as Error).message}`);
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
          ctx.print(`Error: ${(e as Error).message}`);
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
