/**
 * settings-modal-activation — pure action helpers for SettingsModal.
 *
 * These functions encapsulate the two activation/interaction operations:
 *   - activateSelected: toggle boolean, cycle enum, enter edit mode, launch pickers
 *   - handleSubscriptionLogoutKey: route a keypress through the logout confirm gate
 *
 * Each function takes its dependencies as explicit arguments rather than
 * accessing class-level state directly, following the same pattern as
 * settings-modal-reset.ts and settings-modal-mutations.ts.
 */

import { handleConfirmInput } from '../panels/confirm-state.ts';
import type { FlagEntry, McpEntry, SettingEntry, SubscriptionEntry } from './settings-modal-types.ts';
import { buildMcpEntries, buildSubscriptionEntries } from './settings-modal-data.ts';
import { modelPickerLaunchForKey } from './settings-modal-behavior.ts';
import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import type { ModelPickerTarget } from './model-picker.ts';

// ---------------------------------------------------------------------------
// activateSelected
// ---------------------------------------------------------------------------

export interface ActivateSelectedContext {
  readonly currentCategory: string;
  readonly configManager: { get(key: ConfigKey): unknown } | null;
  getSelectedMcp(): McpEntry | null;
  getSelectedSubscription(): SubscriptionEntry | null;
  getSelected(): SettingEntry | null;
  setValue(key: ConfigKey, value: unknown): void;
  setEditingMode(value: boolean): void;
  setEditBuffer(value: string): void;
  setMcpAllowAllConfirmationTarget(value: string | null): void;
  setSubscriptionLogoutConfirmationTarget(value: string | null): void;
  setPendingSettingsPickerAction(value: 'tts-provider' | 'tts-voice' | null): void;
  setPendingModelPickerTarget(value: ModelPickerTarget | null): void;
  setPendingProviderModelPickerTarget(value: ModelPickerTarget | null): void;
}

export function activateSelected(ctx: ActivateSelectedContext): void {
  if (ctx.currentCategory === 'mcp') {
    const entry = ctx.getSelectedMcp();
    if (!entry) return;
    ctx.setEditingMode(true);
    ctx.setEditBuffer(entry.trustMode);
    ctx.setMcpAllowAllConfirmationTarget(null);
    return;
  }

  if (ctx.currentCategory === 'subscriptions') {
    const entry = ctx.getSelectedSubscription();
    if (!entry) return;
    if (entry.state === 'active' || entry.state === 'pending') {
      // First press: arm the confirm gate. Subsequent key handling routes
      // through handleSubscriptionLogoutKey() before normal dispatch.
      ctx.setSubscriptionLogoutConfirmationTarget(entry.provider);
    }
    return;
  }

  const entry = ctx.getSelected();
  if (!entry || !ctx.configManager) return;

  const { setting } = entry;

  // Delegate provider/model picker settings to the model picker UI
  if (setting.key === 'tts.provider') {
    ctx.setPendingSettingsPickerAction('tts-provider');
    return;
  }
  if (setting.key === 'tts.voice') {
    ctx.setPendingSettingsPickerAction('tts-voice');
    return;
  }

  const pickerLaunch = modelPickerLaunchForKey(setting.key);
  if (pickerLaunch !== null) {
    if (pickerLaunch.flow === 'providerModel') {
      ctx.setPendingProviderModelPickerTarget(pickerLaunch.target);
    } else {
      ctx.setPendingModelPickerTarget(pickerLaunch.target);
    }
    return;
  }

  if (setting.type === 'boolean') {
    const newVal = !entry.currentValue;
    ctx.setValue(setting.key as ConfigKey, newVal);
  } else if (setting.type === 'enum' && setting.enumValues) {
    const idx = setting.enumValues.indexOf(entry.currentValue as string);
    const nextIdx = (idx + 1) % setting.enumValues.length;
    ctx.setValue(setting.key as ConfigKey, setting.enumValues[nextIdx]);
  } else if (setting.type === 'object') {
    // Object-typed keys (e.g. pricing.modelPrices) edit as JSON: seed the
    // buffer with the current value's JSON so the edit starts from truth.
    ctx.setEditingMode(true);
    ctx.setEditBuffer(JSON.stringify(entry.currentValue ?? {}));
  } else if (setting.type === 'string' || setting.type === 'number') {
    // Enter inline edit mode
    ctx.setEditingMode(true);
    ctx.setEditBuffer(String(entry.currentValue ?? ''));
  }
}

// ---------------------------------------------------------------------------
// handleSubscriptionLogoutKey
// ---------------------------------------------------------------------------

export interface HandleSubscriptionLogoutKeyContext {
  readonly subscriptionLogoutConfirmationTarget: string | null;
  readonly subscriptionManager: SubscriptionManager | null;
  readonly serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null;
  setSubscriptionEntries(entries: SubscriptionEntry[]): void;
  setSubscriptionLogoutConfirmationTarget(value: string | null): void;
}

export function handleSubscriptionLogoutKey(
  ctx: HandleSubscriptionLogoutKeyContext,
  key: string,
): 'confirmed' | 'cancelled' | 'absorbed' | 'inactive' {
  const target = ctx.subscriptionLogoutConfirmationTarget;
  if (!target) return 'inactive';
  const confirmState = { subject: target, label: target };
  const result = handleConfirmInput(confirmState, key);
  if (result === 'confirmed') {
    ctx.subscriptionManager?.logout(target);
    ctx.setSubscriptionEntries(buildSubscriptionEntries(ctx.subscriptionManager, ctx.serviceRegistry));
    ctx.setSubscriptionLogoutConfirmationTarget(null);
  } else if (result === 'cancelled') {
    ctx.setSubscriptionLogoutConfirmationTarget(null);
  }
  // 'absorbed': confirm remains pending
  return result;
}

// Re-export FlagEntry so callers need not import from two modules.
export type { FlagEntry };
