import { type Line } from '../types/grid.ts';
import type { Panel } from '../panels/types.ts';
import { renderTabStrip } from './tab-strip.ts';

const ACTIVE_FG = '#e2e8f0';
const ACTIVE_FG_UNFOCUSED = '#94a3b8';
const ACTIVE_BG = '#1e293b';
const INACTIVE_FG = '244';
const SEPARATOR_FG = '238';
const CLOSE_FG = '238';
const LABEL_FG = '#cbd5e1';
const LABEL_BG = '#0f172a';

/**
 * Render the panel tab bar.
 *
 * Shows open panel tabs with the active one highlighted.
 * Format: │ icon Name │ icon Name │ ...
 *
 * Active tab:   slate-white, bold, bg #1e293b
 * Inactive tab: grey (244), no background
 * Separators:   │ in dim grey (238)
 * Overflow:     > right scroll indicator (stateless - shows when tabs extend beyond width)
 * Close button: x at far right for active tab
 */
export function renderPanelTabBar(
  panels: Panel[],
  activeIndex: number,
  width: number,
  focused: boolean = true,
  paneLabel?: string,
): Line {
  if (panels.length === 0) return renderTabStrip({ width, tabs: [], style: {
    activeFg: ACTIVE_FG,
    activeBg: ACTIVE_BG,
    activeBold: focused,
    inactiveFg: INACTIVE_FG,
    separatorFg: SEPARATOR_FG,
    labelFg: LABEL_FG,
    labelBg: focused ? LABEL_BG : '',
    labelBold: focused,
    overflowFg: SEPARATOR_FG,
    trailingFg: focused ? ACTIVE_FG_UNFOCUSED : INACTIVE_FG,
  } });

  const tabs = panels.map((panel, index) => ({
    label: `${panel.icon} ${panel.name}`,
    active: index === activeIndex,
  }));

  return renderTabStrip({
    width,
    tabs,
    prefixLabel: paneLabel ? ` ${paneLabel.toUpperCase()} ` : undefined,
    suffixLabel: ` ${panels.length}  x `,
    style: {
      activeFg: focused ? ACTIVE_FG : ACTIVE_FG_UNFOCUSED,
      activeBg: ACTIVE_BG,
      activeBold: focused,
      inactiveFg: INACTIVE_FG,
      separatorFg: SEPARATOR_FG,
      labelFg: LABEL_FG,
      labelBg: focused ? LABEL_BG : '',
      labelBold: focused,
      overflowFg: SEPARATOR_FG,
      trailingFg: CLOSE_FG,
    },
  });
}
