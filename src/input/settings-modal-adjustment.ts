/**
 * settings-modal-adjustment — pure adjustment helpers for SettingsModal.
 *
 * These functions encapsulate the directional-adjustment operation:
 *   - adjustSelected: cycle enum/boolean/number values via left/right arrow keys
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state directly, following the same pattern as
 * settings-modal-reset.ts and settings-modal-mutations.ts.
 */

import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { FlagEntry, McpEntry, SettingEntry } from './settings-modal-types.ts';
import { buildMcpEntries } from './settings-modal-data.ts';
import { getNumericAdjustmentMeta, roundToPrecision } from './settings-modal-behavior.ts';
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

  // Feature-unit headers are the real config rows for their enablement keys
  // (boolean or enum), so they fall through to the ordinary branches below —
  // a plain config write the settings bridge forwards to the gate manager.

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
