import type { Line } from '../types/grid.ts';
import type { WorkspaceTab } from '../panels/panel-manager.ts';
import { renderTabStrip, type TabHitRegion } from './tab-strip.ts';
import { UI_TONES } from './ui-primitives.ts';

// Theme tokens (no raw hex) — keeps the bar in sync with the shared palette.
const ACTIVE_FG = UI_TONES.fg.primary;       // selected tab text
const ACTIVE_BG = UI_TONES.bg.selected;      // selected tab fill (stronger contrast)
const INACTIVE_FG = UI_TONES.fg.muted;       // unselected tabs
const SEPARATOR_FG = UI_TONES.fg.dim;        // │ separators
const LABEL_FG = UI_TONES.fg.secondary;      // PANELS prefix label
const LABEL_BG = UI_TONES.bg.title;          // prefix label background when focused
const FOCUS_ACCENT_FG = UI_TONES.state.active; // the one focused tab

export function renderPanelWorkspaceBar(
  tabs: readonly WorkspaceTab[],
  width: number,
  focused: boolean,
  onLayout?: (regions: readonly TabHitRegion[]) => void,
): Line {
  return renderTabStrip({
    width,
    onLayout,
    tabs: tabs.map((tab, i) => ({
      // tab.active = selected in its own pane (drives highlighted background).
      // tab.focused = has keyboard focus (drives brighter text / focus indicator).
      // A tab can be active-but-not-focused (selected in the unfocused pane) or
      // active-and-focused (selected in the focused pane).
      //
      // A14: the pane marker uses ▲/▼ (top/bottom pane). The old '^'/'v'
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
      activeFg: ACTIVE_FG,
      activeBg: ACTIVE_BG,
      activeBold: focused,
      inactiveFg: INACTIVE_FG,
      separatorFg: SEPARATOR_FG,
      // Accent the PANELS chip when focused so it ties to the focus border.
      labelFg: focused ? FOCUS_ACCENT_FG : LABEL_FG,
      labelBg: focused ? LABEL_BG : '',
      labelBold: focused,
      overflowFg: SEPARATOR_FG,
      trailingFg: INACTIVE_FG,
    },
  });
}
