import type { Line } from '../types/grid.ts';
import type { WorkspaceTab } from '../panels/panel-manager.ts';
import { renderTabStrip } from './tab-strip.ts';

const ACTIVE_FG = '#e2e8f0';
const ACTIVE_BG = '#0f172a';
const INACTIVE_FG = '#94a3b8';
const SEPARATOR_FG = '238';
const LABEL_FG = '#cbd5e1';
const LABEL_BG = '#1e293b';

export function renderPanelWorkspaceBar(
  tabs: readonly WorkspaceTab[],
  width: number,
  focused: boolean,
): Line {
  return renderTabStrip({
    width,
    tabs: tabs.map((tab) => ({
      // tab.active = selected in its own pane (drives highlighted background).
      // tab.focused = has keyboard focus (drives brighter text / focus indicator).
      // A tab can be active-but-not-focused (selected in the unfocused pane) or
      // active-and-focused (selected in the focused pane).
      label: `${tab.pane === 'bottom' ? 'v' : '^'} ${tab.icon} ${tab.name}${tab.focused ? ' ▸' : ''}`,
      active: tab.active,
      status: tab.status,
    })),
    prefixLabel: ' PANELS ',
    suffixLabel: ` ${tabs.length} `,
    style: {
      activeFg: ACTIVE_FG,
      activeBg: ACTIVE_BG,
      activeBold: focused,
      inactiveFg: INACTIVE_FG,
      separatorFg: SEPARATOR_FG,
      labelFg: LABEL_FG,
      labelBg: focused ? LABEL_BG : '',
      labelBold: focused,
      overflowFg: SEPARATOR_FG,
      trailingFg: INACTIVE_FG,
    },
  });
}
