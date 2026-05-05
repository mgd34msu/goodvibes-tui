/**
 * Panel resource contracts — backward-compat shim.
 *
 * Re-exports the SDK's component contract types and helpers. TUI code that
 * previously used local `ComponentResourceContract` / `ComponentHealthState`
 * types (with `panelId`) now uses the SDK types (with `componentId`).
 *
 * Backward-compat aliases are re-exported:
 *   - `PanelResourceContract` = `Omit<ComponentResourceContract,'componentId'> & { panelId }`
 *   - `PanelHealthState`      = `Omit<ComponentHealthState,'componentId'> & { panelId }`
 *
 * These keep TUI-internal code that still uses `.panelId` compiling while
 * the broader migration to `.componentId` proceeds.
 */

export type {
  ComponentThrottleStatus,
  ComponentHealthStatus,
  ComponentResourceContract,
  ComponentHealthState,
  PanelThrottleStatus,
  PanelHealthStatus,
  PanelResourceContract,
  PanelHealthState,
} from '@/runtime/index.ts';

export {
  CATEGORY_CONTRACTS,
  buildContract,
  createInitialComponentHealthState,
  createInitialPanelHealthState,
} from '@/runtime/index.ts';
