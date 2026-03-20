import type { Line } from '../types/grid.ts';

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

  // Input (optional)
  handleInput?(key: string): boolean;
}

export interface PanelRegistration extends Pick<Panel, 'id' | 'name' | 'icon' | 'category'> {
  factory: () => Panel;
  description: string;
}
