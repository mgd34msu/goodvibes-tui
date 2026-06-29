import type { Line } from '../types/grid.ts';
import type { StatusState } from '../renderer/status-glyphs.ts';
import type { ComponentResourceContract, ComponentHealthState } from '../runtime/perf/panel-contracts.ts';

/**
 * Named logical key identifiers emitted by the input tokenizer.
 * These are the ONLY key names that will appear in `handleInput` calls;
 * the tokenizer never emits DOM/browser-style names like 'ArrowUp' or 'Enter'.
 *
 * Printable single-character input is passed through as-is; the `string & {}`
 * fallback preserves that handling while making named-key completions discoverable
 * in editors and keeping non-null single-character values compatible.
 */
export type NamedKey =
  | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'insert' | 'delete' | 'backspace'
  | 'enter' | 'return' | 'escape' | 'space' | 'tab'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6'
  | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12';

/**
 * The full key type accepted by `Panel.handleInput`.
 *
 * Named keys (arrow keys, modifiers, function keys) are represented by
 * lowercase `NamedKey` members. Single printable characters are passed
 * verbatim via the `string & {}` escape hatch so panels can handle 'j', 'k',
 * 'r', etc. without losing type safety on the named members.
 */
export type KeyName = NamedKey | (string & {});

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

  // Dirty-flag contract (R2: activated panel render skipping)
  /** Mark this panel as needing a re-render on the next frame. */
  invalidate(): void;
  /** Called by the compositor after a successful render to clear the dirty flag. */
  markRendered(): void;

  // Resource contract (optional — panels may declare resource requirements)
  resourceContract?: Readonly<ComponentResourceContract>;

  // Health state (optional — set by ComponentHealthMonitor when panel is registered)
  healthState?: Readonly<ComponentHealthState>;

  // Input (optional)
  handleInput?(key: KeyName): boolean;

  // Scroll input (optional)
  // Positive delta scrolls down; negative delta scrolls up.
  handleScroll?(deltaRows: number): boolean;

  // Tab status (optional — for surfacing errors/state in tab bars)
  getTabStatus?(): StatusState | undefined;
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
