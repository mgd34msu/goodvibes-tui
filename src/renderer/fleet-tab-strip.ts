// ---------------------------------------------------------------------------
// fleet-tab-strip.ts
//
// Renders FleetPanel's session-tab strip by reusing
// renderTabStrip exactly as panel-workspace-bar.ts does for the workspace
// tab bar. Deliberately a SEPARATE, visually distinct strip from the
// workspace bar: workspace tabs switch PANELS, fleet session tabs switch
// ATTACHED PROCESSES within one panel, conflating their styling would blur
// that distinction for the operator.
// ---------------------------------------------------------------------------

import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import type { FleetTabsState } from '../panels/fleet-tabs.ts';
import { renderTabStrip, type TabHitRegion } from './tab-strip.ts';
import { activeUiTones } from './theme.ts';


/**
 * Render the fleet session-tab strip, or `null` when there are no attached
 * tabs, the panel omits the strip entirely in that case (root-tab-only),
 * which is what keeps the pre-session-tab fleet-panel goldens byte-identical.
 */
export function renderFleetTabStrip(
  state: FleetTabsState,
  width: number,
  onLayout?: (regions: readonly TabHitRegion[]) => void,
): Line | null {
  if (state.tabs.length === 0) return null;
  const t = activeUiTones();
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
      activeFg: t.fg.primary,
      activeBg: t.bg.selected,
      activeBold: true,
      inactiveFg: t.fg.muted,
      separatorFg: t.fg.dim,
      labelFg: t.fg.secondary,
      overflowFg: t.fg.dim,
      trailingFg: t.fg.muted,
    },
  });
}
