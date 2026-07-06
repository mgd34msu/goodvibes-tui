// ---------------------------------------------------------------------------
// fleet-tab-strip.ts
//
// Renders FleetPanel's session-tab strip by reusing
// renderTabStrip exactly as panel-workspace-bar.ts does for the workspace
// tab bar. Deliberately a SEPARATE, visually distinct strip from the
// workspace bar: workspace tabs switch PANELS, fleet session tabs switch
// ATTACHED PROCESSES within one panel — conflating their styling would blur
// that distinction for the operator.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import type { FleetTabsState } from '../panels/fleet-tabs.ts';
import { renderTabStrip, type TabHitRegion } from './tab-strip.ts';
import { UI_TONES } from './ui-primitives.ts';

const ACTIVE_FG = UI_TONES.fg.primary;
const ACTIVE_BG = UI_TONES.bg.selected;
const INACTIVE_FG = UI_TONES.fg.muted;
const SEPARATOR_FG = UI_TONES.fg.dim;
const LABEL_FG = UI_TONES.fg.secondary;

/**
 * Render the fleet session-tab strip, or `null` when there are no attached
 * tabs — the panel omits the strip entirely in that case (root-tab-only),
 * which is what keeps the pre-session-tab fleet-panel goldens byte-identical.
 */
export function renderFleetTabStrip(
  state: FleetTabsState,
  width: number,
  onLayout?: (regions: readonly TabHitRegion[]) => void,
): Line | null {
  if (state.tabs.length === 0) return null;
  return renderTabStrip({
    width,
    onLayout,
    tabs: [
      { label: 'Tree', active: state.activeTabIndex === 0 },
      ...state.tabs.map((tab, index) => ({
        label: tab.label,
        active: state.activeTabIndex === index + 1,
      })),
    ],
    prefixLabel: ' SESSIONS ',
    style: {
      activeFg: ACTIVE_FG,
      activeBg: ACTIVE_BG,
      activeBold: true,
      inactiveFg: INACTIVE_FG,
      separatorFg: SEPARATOR_FG,
      labelFg: LABEL_FG,
      overflowFg: SEPARATOR_FG,
      trailingFg: INACTIVE_FG,
    },
  });
}
