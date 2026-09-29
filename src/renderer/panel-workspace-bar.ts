import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { WorkspaceTab } from '../panels/panel-manager.ts';
import { renderTabStrip, type TabHitRegion } from './tab-strip.ts';
import { activeUiTones } from './theme.ts';

// Theme tokens (no raw hex), keeps the bar in sync with the shared palette.

export function renderPanelWorkspaceBar(
  tabs: readonly WorkspaceTab[],
  width: number,
  focused: boolean,
  onLayout?: (regions: readonly TabHitRegion[]) => void,
): Line {
  const t = activeUiTones();
  return renderTabStrip({
    width,
    onLayout,
    tabs: tabs.map((tab, i) => ({
      // tab.active = selected in its own pane (drives highlighted background).
      // tab.focused = has keyboard focus (drives brighter text / focus indicator).
      // A tab can be active-but-not-focused (selected in the unfocused pane) or
      // active-and-focused (selected in the focused pane).
      //
      // The pane marker uses ▲/▼ (top/bottom pane). The old '^'/'v'
      // prefixes read as a Ctrl caret (^) implying a non-existent Ctrl+<tab>
      // hotkey. The REAL per-tab jump key is Alt+N (panel-tab-1..9), rendered
      // here as ⌥N for the first nine tabs so the shown affordance matches the
      // binding (tabs past nine have no Alt+N chord, so no index is shown).
      label: `${tab.pane === 'bottom' ? '▼' : '▲'}${i < 9 ? ` ⌥${i + 1}` : ''} ${tab.icon} ${tab.name}${tab.focused ? ' ▸' : ''}`,
      active: tab.active,
    })),
    prefixLabel: ' PANELS ',
    suffixLabel: ` ${tabs.length} `,
    style: {
      activeFg: t.fg.primary,
      activeBg: t.bg.selected,
      activeBold: focused,
      inactiveFg: t.fg.muted,
      separatorFg: t.fg.dim,
      // Accent the PANELS chip when focused so it ties to the focus border.
      labelFg: focused ? t.state.active : t.fg.secondary,
      labelBg: focused ? t.bg.title : '',
      labelBold: focused,
      overflowFg: t.fg.dim,
      trailingFg: t.fg.muted,
    },
  });
}
