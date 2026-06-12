/**
 * settings-modal-adjustment — pure adjustment helpers for SettingsModal.
 *
 * These functions encapsulate the two directional-adjustment operations:
 *   - adjustSelected: cycle enum/boolean/number values via left/right arrow keys
 *   - toggleSelectedFlag: toggle a feature flag between enabled and disabled
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state directly, following the same pattern as
 * settings-modal-reset.ts and settings-modal-mutations.ts.
 */

import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagState } from '@/runtime/index.ts';
import type { FlagEntry, McpEntry, SettingEntry } from './settings-modal-types.ts';
import { buildMcpEntries } from './settings-modal-data.ts';
import { getNumericAdjustmentMeta, roundToPrecision } from './settings-modal-behavior.ts';
import { applyFlagState } from './settings-modal-mutations.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';

// ---------------------------------------------------------------------------
// adjustSelected
// ---------------------------------------------------------------------------

export interface AdjustSelectedContext {
  readonly editingMode: boolean;
  readonly currentCategory: string;
  readonly configManager: ConfigManager | null;
  readonly featureFlagManager: FeatureFlagManager | null;
  readonly mcpRegistry: McpRegistry | null;
  getSelectedFlag(): FlagEntry | null;
  getSelectedMcp(): McpEntry | null;
  getSelected(): SettingEntry | null;
  setValue(key: ConfigKey, value: unknown): void;
  setMcpEntries(entries: McpEntry[]): void;
  setMcpAllowAllConfirmationTarget(value: string | null): void;
}

export function adjustSelected(
  ctx: AdjustSelectedContext,
  direction: 'left' | 'right',
  step = 1,
): void {
  if (ctx.editingMode) return;

  if (ctx.currentCategory === 'flags') {
    const flagEntry = ctx.getSelectedFlag();
    if (!flagEntry || flagEntry.state === 'killed' || !ctx.featureFlagManager || !ctx.configManager) return;
    const targetState: FlagState = direction === 'right' ? 'enabled' : 'disabled';
    if (flagEntry.state !== targetState) applyFlagState(flagEntry, targetState, ctx.featureFlagManager, ctx.configManager);
    return;
  }

  if (ctx.currentCategory === 'mcp') {
    const entry = ctx.getSelectedMcp();
    if (!entry || !ctx.mcpRegistry) return;
    const modes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
    const currentIndex = Math.max(0, modes.indexOf(entry.trustMode));
    const nextIndex = direction === 'right'
      ? (currentIndex + 1) % modes.length
      : (currentIndex - 1 + modes.length) % modes.length;
    ctx.mcpRegistry.setServerTrustMode(entry.name, modes[nextIndex]!);
    ctx.setMcpEntries(buildMcpEntries(ctx.mcpRegistry));
    ctx.setMcpAllowAllConfirmationTarget(null);
    return;
  }

  const entry = ctx.getSelected();
  if (!entry || !ctx.configManager) return;
  const { setting } = entry;

  if (setting.type === 'boolean') {
    ctx.setValue(setting.key as ConfigKey, direction === 'right');
    return;
  }

  if (setting.type === 'enum' && setting.enumValues && setting.enumValues.length > 0) {
    const currentIndex = Math.max(0, setting.enumValues.indexOf(String(entry.currentValue)));
    const nextIndex = direction === 'right'
      ? (currentIndex + 1) % setting.enumValues.length
      : (currentIndex - 1 + setting.enumValues.length) % setting.enumValues.length;
    ctx.setValue(setting.key as ConfigKey, setting.enumValues[nextIndex]!);
    return;
  }

  if (setting.type === 'number') {
    const currentNumber = Number(entry.currentValue ?? 0);
    if (!Number.isFinite(currentNumber)) return;
    const adjustment = getNumericAdjustmentMeta(setting);
    const delta = adjustment.step * step;
    const rounded = roundToPrecision(currentNumber + (direction === 'right' ? delta : -delta), adjustment.precision);
    const nextValue = Math.min(
      adjustment.max ?? rounded,
      Math.max(adjustment.min ?? rounded, rounded),
    );
    if (setting.validate && !setting.validate(nextValue)) return;
    ctx.setValue(setting.key as ConfigKey, nextValue);
  }
}

// ---------------------------------------------------------------------------
// toggleSelectedFlag
// ---------------------------------------------------------------------------

export interface ToggleSelectedFlagContext {
  readonly featureFlagManager: FeatureFlagManager | null;
  readonly configManager: ConfigManager | null;
  getSelectedFlag(): FlagEntry | null;
}

export function toggleSelectedFlag(ctx: ToggleSelectedFlagContext): void {
  const flagEntry = ctx.getSelectedFlag();
  if (!flagEntry || !ctx.featureFlagManager || !ctx.configManager) return;

  const { state } = flagEntry;

  // Killed flags are blocked
  if (state === 'killed') return;

  const newState: FlagState = state === 'enabled' ? 'disabled' : 'enabled';
  applyFlagState(flagEntry, newState, ctx.featureFlagManager, ctx.configManager);
}
