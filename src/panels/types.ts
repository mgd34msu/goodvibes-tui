import type { Line } from '../types/grid.ts';
import type { StatusState } from '../renderer/status-glyphs.ts';
import type { ComponentResourceContract, ComponentHealthState } from '../runtime/perf/panel-contracts.ts';
// Routed through the `@/` alias (not `./panel-manager.ts`) so this foundational
// types module stays a leaf in the relative-import graph the architecture
// cycle-checker walks. Type-only, erased at runtime — no real dependency edge.
import type { PanelManager } from '@/panels/panel-manager.ts';

/**
 * Context passed to a panel's `handlePanelIntegrationAction` hook so it can
 * drive cross-panel behavior (e.g. file-explorer opening the preview panel)
 * without the input layer needing `instanceof` knowledge of each panel type.
 */
export interface PanelIntegrationContext {
  readonly panelManager: PanelManager;
  readonly executeCommand?: (name: string, args: string[]) => Promise<unknown>;
}

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

/**
 * WO-152: the former single 'monitoring' bucket held 33 panels pre-merge —
 * too coarse for the picker to be useful and too large for any one operator
 * mental model. Split into named operator domains so each category holds a
 * bounded, coherent set (no category may exceed 10 registrations):
 *   - providers:              provider/model connectivity, cost, and token usage
 *   - security-policy:        auth, policy governance, and isolation posture
 *   - automation-control:     hooks, plugins, marketplace, automation jobs, worktrees
 *   - incidents-diagnostics:  failure review, eval gates, API call debugging
 *   - runtime-ops:            live operator consoles (cockpit, tasks, orchestration, comms)
 * 'development' | 'agent' | 'session' | 'ai' are unchanged from before the split.
 */
export type PanelCategory =
  | 'development'
  | 'agent'
  | 'session'
  | 'ai'
  | 'providers'
  | 'security-policy'
  | 'automation-control'
  | 'incidents-diagnostics'
  | 'runtime-ops';

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

  /**
   * Optional: report `true` while this panel has an active inline text
   * capture (e.g. a `/`-to-filter or search buffer) that deliberately wants
   * every character of a burst — paste, or several keystrokes typed fast
   * enough to land in one `input.feed()` call — delivered to `handleInput`
   * one at a time, same as it always has. When this returns `false` or is
   * not implemented, the input router treats a printable burst as never a
   * deliberate single-key panel hotkey and routes it to the composer
   * instead of exploding it into per-char `handleInput` calls (see
   * `handlePanelFocusToken` in `src/input/handler-feed-routes.ts`).
   */
  isCapturingTextBurst?(): boolean;

  // Scroll input (optional)
  // Positive delta scrolls down; negative delta scrolls up.
  handleScroll?(deltaRows: number): boolean;

  /**
   * Cross-panel integration hook (optional). Called before the panel's own
   * `handleInput` when a navigation/confirm key is pressed, so a panel can
   * drive another panel (e.g. open a file in the preview panel). Return `true`
   * to consume the key. The legacy `handlePanelIntegrationAction` router in
   * `src/input/panel-integration-actions.ts` consults this first, then falls
   * back to its built-in `instanceof` routing.
   */
  handlePanelIntegrationAction?(key: string, ctx: PanelIntegrationContext): boolean;

  /**
   * Optional: called by the global Ctrl+X (`panel-close`) shortcut BEFORE it
   * closes this panel (handler-shortcuts.ts). Return `true` to consume
   * Ctrl+X for an in-panel action instead — e.g. FleetPanel (Wave-3 session
   * tabs) detaches its active tab and leaves the panel open. Return `false`
   * (or omit this hook) to fall through to the ordinary close behavior.
   * Ctrl+X never reaches a panel's own `handleInput` (ctrl/meta combos are
   * intercepted earlier — see handlePanelFocusToken in
   * src/input/handler-feed-routes.ts), so this is the one seam a panel has
   * to intervene before the global shortcut acts.
   */
  interceptPanelClose?(): boolean;
}

export interface PanelRegistration extends Pick<Panel, 'id' | 'name' | 'icon' | 'category'> {
  factory: () => Panel;
  description: string;
  /**
   * WO-152 lifecycle flags. `preload` and `retainOnClose` are independent —
   * a panel can eagerly instantiate without being kept alive on close, or be
   * kept alive on close without eager bootstrap instantiation. They happened
   * to be identical for all builtin panels before this split (both driven by
   * a single `preload: true`); that existing 10-panel retained set is
   * preserved unchanged by giving each of those 10 registrations both flags.
   *
   * - `preload` — instantiate this panel during `PanelManager.prewarmRegistered()`
   *   (called once at bootstrap) so its factory runs and it starts
   *   accumulating background data (subscriptions, timers) before the user
   *   ever opens the workspace. Panels without `preload` are instantiated
   *   lazily on first `open()`.
   * - `retainOnClose` — when this panel is closed, keep the live instance in
   *   `PanelManager`'s retained-panel map (background subscriptions/timers
   *   keep running) instead of calling `onDestroy()`. Reopening returns the
   *   same instance with its accumulated state intact. Panels without
   *   `retainOnClose` are destroyed on close and rebuilt fresh next open.
   */
  preload?: boolean;
  retainOnClose?: boolean;
}
