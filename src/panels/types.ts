import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import type { PanelResourceContract, PanelHealthState } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-contracts';

export type PanelCategory = 'development' | 'agent' | 'monitoring' | 'session' | 'ai';

export interface Panel {
  id: string;
  name: string;
  icon: string; // single char for tab bar
  category: PanelCategory;

  // Lifecycle
  onActivate(): void;
  onDeactivate(): void;
  onDestroy(): void;

  // Rendering
  render(width: number, height: number): Line[];

  // State
  isTransient: boolean;
  isPinned: boolean;
  needsRender: boolean;

  // Resource contract (optional — panels may declare resource requirements)
  resourceContract?: Readonly<PanelResourceContract>;

  // Health state (optional — set by PanelHealthMonitor when panel is registered)
  healthState?: Readonly<PanelHealthState>;

  // Input (optional)
  handleInput?(key: string): boolean;
}

export interface PanelRegistration extends Pick<Panel, 'id' | 'name' | 'icon' | 'category'> {
  factory: () => Panel;
  description: string;
  /**
   * Instantiate this panel during bootstrap and retain the instance when it is
   * closed so its background data continues to accumulate before the user
   * actively opens the workspace.
   */
  preload?: boolean;
}
