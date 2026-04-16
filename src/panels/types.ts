import type { Line } from '../types/grid.ts';
import type { ComponentResourceContract, ComponentHealthState } from '../runtime/perf/panel-contracts.ts';

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
  resourceContract?: Readonly<ComponentResourceContract>;

  // Health state (optional — set by ComponentHealthMonitor when panel is registered)
  healthState?: Readonly<ComponentHealthState>;

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
