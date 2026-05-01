/**
 * SettingsModal — state management for the /settings and /config fullscreen workspace.
 *
 * Loads CONFIG_SCHEMA, groups settings by category, and tracks UI state:
 *   - Active category (Tab to cycle)
 *   - Selected setting index within category (↑↓)
 *   - Editing mode for inline string/number input
 *   - Feature flags tab with runtime toggle support
 *
 * Saves changes via configManager.set(key, value) or featureFlagManager methods.
 */

import { CONFIG_SCHEMA, type ConfigKey, type PersistedFlagState } from '@pellux/goodvibes-sdk/platform/config/schema';
import type { ModelPickerTarget } from './model-picker.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import { getResolvedSettingLookup } from '@pellux/goodvibes-sdk/platform/runtime/settings/control-plane';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
import { buildGoodVibesSecretKey, isSecretConfigKey } from '../config/secret-config.ts';
import {
  getNumericAdjustmentMeta,
  modelPickerLaunchForKey,
  roundToPrecision,
} from './settings-modal-behavior.ts';
import {
  setSecretBackedSettingValue,
  type SettingsSecretsManager,
} from './settings-modal-secrets.ts';
import { buildSubscriptionEntries } from './settings-modal-subscriptions.ts';
import type { FeatureFlagManager } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/index';
import type { FeatureFlag, FlagState } from '@pellux/goodvibes-sdk/platform/runtime/feature-flags/types';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp/registry';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';
import {
  SETTINGS_CATEGORIES,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SubscriptionEntry,
} from './settings-modal-types.ts';

export {
  SETTINGS_CATEGORIES,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SubscriptionEntry,
} from './settings-modal-types.ts';

// ---------------------------------------------------------------------------
// SettingsModal
// ---------------------------------------------------------------------------

export class SettingsModal {
  public active = false;

  /** Index into SETTINGS_CATEGORIES. */
  public categoryIndex = 0;

  /** Selected setting index within the current category. */
  public selectedIndex = 0;

  /** Which pane receives up/down navigation and Enter/Space actions. */
  public focusPane: SettingsFocusPane = 'settings';

  /** Whether we're in inline edit mode for the selected string/number setting. */
  public editingMode = false;

  /** Current value of the inline edit buffer. */
  public editBuffer = '';
  /** Server awaiting explicit allow-all confirmation, if any. */
  public mcpAllowAllConfirmationTarget: string | null = null;
  /**
   * Set by activateSelected() when the highlighted setting should open the
   * model picker rather than entering inline text edit mode.
   * Consumed and cleared by the route handler after each Enter/Space action.
   */
  public pendingModelPickerTarget: ModelPickerTarget | null = null;
  /** Set when the highlighted setting should open provider selection before model selection. */
  public pendingProviderModelPickerTarget: ModelPickerTarget | null = null;
  /** Set when a highlighted setting needs an external picker owned by the shell route. */
  public pendingSettingsPickerAction: 'tts-provider' | 'tts-voice' | null = null;
  /** Provider awaiting explicit logout confirmation, if any. */
  public subscriptionLogoutConfirmationTarget: string | null = null;

  /** Settings grouped by category. */
  public groups: Map<SettingsCategory, SettingEntry[]> = new Map();

  /** Feature flag entries (populated when flags tab is active). */
  public flagEntries: FlagEntry[] = [];
  /** MCP server trust entries (populated when mcp tab is active). */
  public mcpEntries: McpEntry[] = [];
  /** Provider subscription entries (populated when subscriptions tab is active). */
  public subscriptionEntries: SubscriptionEntry[] = [];

  /**
   * Set after a network-category save that touches controlPlane or httpListener
   * config keys.  Renderer reads this to display a transient restart notice.
   * Cleared on next open() or close().
   */
  public lastSaveTriggeredRestart: 'control-plane' | 'http-listener' | 'web' | null = null;

  private configManager: ConfigManager | null = null;
  private secretsManager: SettingsSecretsManager | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null = null;

  /**
   * Open the modal, loading current config values from configManager.
   *
   * @param configManager - Config manager instance for reading/writing settings.
   * @param featureFlagManager - Feature flag manager for the flags tab.
   */
  open(
    configManager: ConfigManager,
    featureFlagManager: FeatureFlagManager,
    subscriptionManager: SubscriptionManager,
    serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'>,
    mcpRegistry?: McpRegistry,
    secretsManager?: SettingsSecretsManager,
  ): void {
    this.configManager = configManager;
    this.secretsManager = secretsManager ?? null;
    this.featureFlagManager = featureFlagManager;
    this.subscriptionManager = subscriptionManager;
    this.serviceRegistry = serviceRegistry;
    this.mcpRegistry = mcpRegistry ?? null;
    this._loadGroups(configManager);
    this._loadFlagEntries();
    this._loadMcpEntries();
    this._loadSubscriptionEntries();
    this.categoryIndex = 0;
    this.selectedIndex = 0;
    this.focusPane = 'settings';
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSaveTriggeredRestart = null;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSaveTriggeredRestart = null;
    this.serviceRegistry = null;
    this.secretsManager = null;
    this.focusPane = 'settings';
  }

  /** Cycle to the next category (Tab). */
  nextCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex + 1) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    } else if (this.currentCategory === 'mcp') {
      this._loadMcpEntries();
    } else if (this.currentCategory === 'subscriptions') {
      this._loadSubscriptionEntries();
    }
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    if (this.currentCategory === 'flags') {
      this._loadFlagEntries();
    } else if (this.currentCategory === 'mcp') {
      this._loadMcpEntries();
    } else if (this.currentCategory === 'subscriptions') {
      this._loadSubscriptionEntries();
    }
  }

  focusCategories(): void {
    if (this.editingMode) return;
    this.focusPane = 'categories';
  }

  focusSettings(): void {
    if (this.editingMode) return;
    this.focusPane = 'settings';
  }

  toggleFocusPane(): void {
    if (this.editingMode) return;
    this.focusPane = this.focusPane === 'settings' ? 'categories' : 'settings';
  }

  moveFocusedUp(): void {
    if (this.focusPane === 'categories') this.prevCategory();
    else this.moveUp();
  }

  moveFocusedDown(): void {
    if (this.focusPane === 'categories') this.nextCategory();
    else this.moveDown();
  }

  moveUp(): void {
    if (this.editingMode) return;
    const items = this._currentItems();
    if (items.length === 0) {
      if (this.currentCategory === 'flags' && this.flagEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.flagEntries.length) % this.flagEntries.length;
      } else if (this.currentCategory === 'mcp' && this.mcpEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.mcpEntries.length) % this.mcpEntries.length;
      } else if (this.currentCategory === 'subscriptions' && this.subscriptionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.subscriptionEntries.length) % this.subscriptionEntries.length;
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
    this.subscriptionLogoutConfirmationTarget = null;
  }

  moveDown(): void {
    if (this.editingMode) return;
    const items = this._currentItems();
    if (items.length === 0) {
      if (this.currentCategory === 'flags' && this.flagEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.flagEntries.length;
      } else if (this.currentCategory === 'mcp' && this.mcpEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.mcpEntries.length;
      } else if (this.currentCategory === 'subscriptions' && this.subscriptionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.subscriptionEntries.length;
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex + 1) % items.length;
    this.subscriptionLogoutConfirmationTarget = null;
  }

  getSelected(): SettingEntry | null {
    const items = this._currentItems();
    if (items.length === 0) return null;
    return items[Math.max(0, Math.min(items.length - 1, this.selectedIndex))] ?? null;
  }

  /** Get the currently selected flag entry (flags tab only). */
  getSelectedFlag(): FlagEntry | null {
    if (this.currentCategory !== 'flags') return null;
    if (this.flagEntries.length === 0) return null;
    return this.flagEntries[Math.max(0, Math.min(this.flagEntries.length - 1, this.selectedIndex))] ?? null;
  }

  getSelectedMcp(): McpEntry | null {
    if (this.currentCategory !== 'mcp') return null;
    if (this.mcpEntries.length === 0) return null;
    return this.mcpEntries[Math.max(0, Math.min(this.mcpEntries.length - 1, this.selectedIndex))] ?? null;
  }

  getSelectedSubscription(): SubscriptionEntry | null {
    if (this.currentCategory !== 'subscriptions') return null;
    if (this.subscriptionEntries.length === 0) return null;
    return this.subscriptionEntries[Math.max(0, Math.min(this.subscriptionEntries.length - 1, this.selectedIndex))] ?? null;
  }

  get currentCategory(): SettingsCategory {
    return SETTINGS_CATEGORIES[this.categoryIndex];
  }

  get currentItems(): SettingEntry[] {
    return this._currentItems();
  }

  selectTarget(target?: string): void {
    const normalized = target?.trim();
    if (!normalized) return;

    const categoryIndex = SETTINGS_CATEGORIES.indexOf(normalized as SettingsCategory);
    if (categoryIndex >= 0) {
      this.categoryIndex = categoryIndex;
      this.selectedIndex = 0;
      this.focusPane = 'settings';
      return;
    }

    for (let index = 0; index < SETTINGS_CATEGORIES.length; index += 1) {
      const category = SETTINGS_CATEGORIES[index]!;
      const entries = this.groups.get(category) ?? [];
      const entryIndex = entries.findIndex((entry) => entry.setting.key === normalized);
      if (entryIndex >= 0) {
        this.categoryIndex = index;
        this.selectedIndex = entryIndex;
        this.focusPane = 'settings';
        return;
      }
    }
  }

  /**
   * Toggle boolean or begin cycling enum values, or enter edit mode for string/number.
   */
  activateSelected(): void {
    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry) return;
      this.editingMode = true;
      this.editBuffer = entry.trustMode;
      this.mcpAllowAllConfirmationTarget = null;
      return;
    }

    if (this.currentCategory === 'subscriptions') {
      const entry = this.getSelectedSubscription();
      if (!entry) return;
      if (entry.state === 'active' || entry.state === 'pending') {
        if (this.subscriptionLogoutConfirmationTarget !== entry.provider) {
          this.subscriptionLogoutConfirmationTarget = entry.provider;
          return;
        }
        this.subscriptionManager?.logout(entry.provider);
        this._loadSubscriptionEntries();
        this.subscriptionLogoutConfirmationTarget = null;
      }
      return;
    }

    const entry = this.getSelected();
    if (!entry || !this.configManager) return;

    const { setting } = entry;

    // Delegate provider/model picker settings to the model picker UI
    if (setting.key === 'tts.provider') {
      this.pendingSettingsPickerAction = 'tts-provider';
      return;
    }
    if (setting.key === 'tts.voice') {
      this.pendingSettingsPickerAction = 'tts-voice';
      return;
    }

    const pickerLaunch = modelPickerLaunchForKey(setting.key);
    if (pickerLaunch !== null) {
      if (pickerLaunch.flow === 'providerModel') {
        this.pendingProviderModelPickerTarget = pickerLaunch.target;
      } else {
        this.pendingModelPickerTarget = pickerLaunch.target;
      }
      return;
    }

    if (setting.type === 'boolean') {
      const newVal = !entry.currentValue;
      this._setValue(setting.key, newVal);
    } else if (setting.type === 'enum' && setting.enumValues) {
      const idx = setting.enumValues.indexOf(entry.currentValue as string);
      const nextIdx = (idx + 1) % setting.enumValues.length;
      this._setValue(setting.key, setting.enumValues[nextIdx]);
    } else if (setting.type === 'string' || setting.type === 'number') {
      // Enter inline edit mode
      this.editingMode = true;
      this.editBuffer = String(entry.currentValue ?? '');
    }
  }

  adjustSelected(direction: 'left' | 'right', step = 1): void {
    if (this.editingMode) return;

    if (this.currentCategory === 'flags') {
      const flagEntry = this.getSelectedFlag();
      if (!flagEntry || flagEntry.state === 'killed' || !this.featureFlagManager || !this.configManager) return;
      const targetState: FlagState = direction === 'right' ? 'enabled' : 'disabled';
      if (flagEntry.state !== targetState) this._setSelectedFlagState(flagEntry, targetState);
      return;
    }

    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry || !this.mcpRegistry) return;
      const modes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
      const currentIndex = Math.max(0, modes.indexOf(entry.trustMode));
      const nextIndex = direction === 'right'
        ? (currentIndex + 1) % modes.length
        : (currentIndex - 1 + modes.length) % modes.length;
      this.mcpRegistry.setServerTrustMode(entry.name, modes[nextIndex]!);
      this._loadMcpEntries();
      this.mcpAllowAllConfirmationTarget = null;
      return;
    }

    const entry = this.getSelected();
    if (!entry || !this.configManager) return;
    const { setting } = entry;

    if (setting.type === 'boolean') {
      this._setValue(setting.key, direction === 'right');
      return;
    }

    if (setting.type === 'enum' && setting.enumValues && setting.enumValues.length > 0) {
      const currentIndex = Math.max(0, setting.enumValues.indexOf(String(entry.currentValue)));
      const nextIndex = direction === 'right'
        ? (currentIndex + 1) % setting.enumValues.length
        : (currentIndex - 1 + setting.enumValues.length) % setting.enumValues.length;
      this._setValue(setting.key, setting.enumValues[nextIndex]!);
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
      this._setValue(setting.key, nextValue);
    }
  }

  /**
   * Toggle the currently selected feature flag.
   *
   * Killed flags cannot be toggled. Non-runtimeToggleable flags toggle in config
   * only (require restart). runtimeToggleable flags toggle immediately.
   */
  toggleSelectedFlag(): void {
    const flagEntry = this.getSelectedFlag();
    if (!flagEntry || !this.featureFlagManager || !this.configManager) return;

    const { flag, state } = flagEntry;

    // Killed flags are blocked
    if (state === 'killed') return;

    const newState: FlagState = state === 'enabled' ? 'disabled' : 'enabled';

    this._setSelectedFlagState(flagEntry, newState);
  }

  private _setSelectedFlagState(flagEntry: FlagEntry, newState: FlagState): void {
    if (!this.featureFlagManager || !this.configManager) return;
    const { flag } = flagEntry;

    if (!flag.runtimeToggleable) {
      // Persist to config only — takes effect on restart
      this._persistFlagState(flag.id, newState, flag.defaultState as FlagState);
      flagEntry.state = newState;
    } else {
      // Toggle immediately in manager
      try {
        if (newState === 'enabled') {
          this.featureFlagManager.enable(flag.id);
        } else {
          this.featureFlagManager.disable(flag.id);
        }
        this._persistFlagState(flag.id, newState, flag.defaultState as FlagState);
        flagEntry.state = newState;
      } catch (e) {
        logger.error('SettingsModal: failed to toggle feature flag', { flag: flag.id, error: summarizeError(e) });
      }
    }
  }

  /**
   * Commit the current editBuffer to the config.
   * Returns true on success, false if validation failed.
   */
  commitEdit(): boolean {
    if (!this.editingMode) return false;

    if (this.currentCategory === 'mcp') {
      const entry = this.getSelectedMcp();
      if (!entry || !this.mcpRegistry) return false;
      if (this.mcpAllowAllConfirmationTarget) {
        const expected = `ALLOW ALL ${this.mcpAllowAllConfirmationTarget}`;
        if (this.editBuffer.trim() !== expected) {
          return false;
        }
        this.mcpRegistry.setServerTrustMode(entry.name, 'allow-all');
        this._loadMcpEntries();
        this.editingMode = false;
        this.editBuffer = '';
        this.mcpAllowAllConfirmationTarget = null;
        return true;
      }

      const nextMode = this.editBuffer.trim() as McpEntry['trustMode'];
      const validModes: McpEntry['trustMode'][] = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'];
      if (!validModes.includes(nextMode)) {
        this.editingMode = false;
        this.editBuffer = '';
        this.mcpAllowAllConfirmationTarget = null;
        return false;
      }
      if (nextMode === 'allow-all' && entry.trustMode !== 'allow-all') {
        this.mcpAllowAllConfirmationTarget = entry.name;
        this.editBuffer = '';
        return false;
      }
      this.mcpRegistry.setServerTrustMode(entry.name, nextMode);
      this._loadMcpEntries();
      this.editingMode = false;
      this.editBuffer = '';
      this.mcpAllowAllConfirmationTarget = null;
      return true;
    }

    const entry = this.getSelected();
    if (!entry || !this.configManager) return false;

    const { setting } = entry;
    let parsed: unknown = this.editBuffer;

    if (setting.type === 'number') {
      parsed = Number(this.editBuffer);
      if (isNaN(parsed as number)) {
        this.editingMode = false;
        this.editBuffer = '';
        return false;
      }
    }

    if (setting.validate && !setting.validate(parsed)) {
      this.editingMode = false;
      this.editBuffer = '';
      return false;
    }

    if (setting.type === 'string' && isSecretConfigKey(setting.key)) {
      setSecretBackedSettingValue({
        key: setting.key,
        value: String(parsed ?? ''),
        configManager: this.configManager,
        secretsManager: this.secretsManager,
        setConfigValue: (key, value) => this._setValue(key, value),
      });
    } else {
      this._setValue(setting.key, parsed);
    }
    this.editingMode = false;
    this.editBuffer = '';
    return true;
  }

  /** Cancel inline edit without saving. */
  cancelEdit(): void {
    this.editingMode = false;
    this.editBuffer = '';
    this.mcpAllowAllConfirmationTarget = null;
  }

  resetSelected(): { key: ConfigKey; value: unknown } | null {
    if (this.editingMode || !this.configManager) return null;
    const entry = this.getSelected();
    if (!entry) return null;
    const key = entry.setting.key as ConfigKey;
    this._setValue(key, entry.setting.default);
    if (isSecretConfigKey(key) && this.secretsManager) {
      void this.secretsManager.delete(buildGoodVibesSecretKey(key), { scope: 'user' }).catch((error) => {
        logger.error('SettingsModal: failed to clear secret while resetting setting', { key, error: summarizeError(error) });
      });
    }
    return { key, value: entry.setting.default };
  }

  /** Handle a keystroke in edit mode: regular chars appended, Backspace removes last char. */
  editChar(char: string): void {
    if (!this.editingMode) return;
    this.editBuffer += char;
  }

  editBackspace(): void {
    if (!this.editingMode) return;
    this.editBuffer = this.editBuffer.slice(0, -1);
  }

  // ── Private helpers ────────────────────────────────────────────

  private _loadGroups(configManager: ConfigManager): void {
    this.groups.clear();
    for (const cat of SETTINGS_CATEGORIES) {
      if (cat === 'flags') continue; // flags tab handled separately
      this.groups.set(cat, []);
    }

    for (const setting of CONFIG_SCHEMA) {
      const rawCat = setting.key.split('.')[0] as string;
      const cat = rawCat as SettingsCategory;
      const currentValue = configManager.get(setting.key as ConfigKey);
      const resolved = getResolvedSettingLookup(configManager, setting.key as ConfigKey)?.entry;
      const entry: SettingEntry = {
        setting,
        currentValue,
        isDefault: currentValue === setting.default,
        effectiveSource: resolved?.effectiveSource,
        locked: resolved?.locked,
        conflict: resolved?.conflict,
        sourceLabel: resolved?.sourceLabel,
        lockReason: resolved?.lockReason,
      };
      if (this.groups.has(cat)) this.groups.get(cat)!.push(entry);
      if ((rawCat === 'controlPlane' || rawCat === 'httpListener' || rawCat === 'web') && this.groups.has('network')) {
        this.groups.get('network')!.push(entry);
      }
    }

    const uiEntries = this.groups.get('ui');
    if (uiEntries) {
      const uiPriority: Record<string, number> = {
        'ui.systemMessages': 0,
        'ui.operationalMessages': 1,
        'ui.wrfcMessages': 2,
        'ui.voiceEnabled': 3,
      };
      uiEntries.sort((a, b) => (uiPriority[a.setting.key] ?? 99) - (uiPriority[b.setting.key] ?? 99));
    }
  }

  /** Load or refresh the flags tab entries from the feature flag manager. */
  private _loadFlagEntries(): void {
    if (!this.featureFlagManager) {
      this.flagEntries = [];
      return;
    }
    this.flagEntries = Array.from(this.featureFlagManager.getAll().values()).map(({ flag, state }) => ({
      flag,
      state,
    }));
  }

  private _loadMcpEntries(): void {
    if (!this.mcpRegistry) {
      this.mcpEntries = [];
      return;
    }
    this.mcpEntries = this.mcpRegistry.listServerSecurity().map((entry) => ({
      name: entry.name,
      connected: entry.connected,
      role: entry.role,
      trustMode: entry.trustMode,
      allowedPaths: [...entry.allowedPaths],
      allowedHosts: [...entry.allowedHosts],
    }));
  }

  private _loadSubscriptionEntries(): void {
    this.subscriptionEntries = buildSubscriptionEntries(this.subscriptionManager, this.serviceRegistry);
  }

  /**
   * Persist a flag state override to config.
   * Deletes the entry when reverting to defaultState. Skips killed state.
   */
  private _persistFlagState(flagId: string, newState: FlagState, defaultState: FlagState): void {
    if (!this.configManager) return;
    if (newState === 'killed') return; // never persist killed state

    try {
      const current = (this.configManager.getCategory('featureFlags') as Record<string, PersistedFlagState>) ?? {};
      if (newState === defaultState) {
        // Revert to default — remove override
        delete current[flagId];
      } else {
        current[flagId] = newState;
      }
      this.configManager.mergeCategory('featureFlags', current);
    } catch (e) {
      logger.error('SettingsModal: failed to persist flag state', { flagId, error: summarizeError(e) });
    }
  }

  /** Returns [] for the flags category (flags use flagEntries instead). */
  private _currentItems(): SettingEntry[] {
    if (this.currentCategory === 'flags' || this.currentCategory === 'mcp' || this.currentCategory === 'subscriptions') return [];
    const items = this.groups.get(this.currentCategory) ?? [];
    if (this.currentCategory === 'network') {
      return items.filter(entry => {
        if (entry.setting.key === 'controlPlane.host') {
          const hostMode = this.configManager?.get('controlPlane.hostMode');
          return hostMode === 'custom';
        }
        if (entry.setting.key === 'httpListener.host') {
          const hostMode = this.configManager?.get('httpListener.hostMode');
          return hostMode === 'custom';
        }
        if (entry.setting.key === 'web.host') {
          const hostMode = this.configManager?.get('web.hostMode');
          return hostMode === 'custom';
        }
        return true;
      });
    }
    return items;
  }

  private _setValue(key: ConfigKey, value: unknown): void {
    if (!this.configManager) return;
    // Diff previous value before writing — avoids false restart notices on no-op saves
    const previousValue = this.configManager.get(key);
    const isRestartKey = ['host', 'port', 'hostMode', 'enabled'].includes(key.split('.')[1] ?? '');
    try {
      this.configManager.setDynamic(key, value);
      const rawCat = key.split('.')[0] as string;
      if (rawCat === 'controlPlane') {
        if (isRestartKey && previousValue !== value) {
          this.lastSaveTriggeredRestart = 'control-plane';
        }
      } else if (rawCat === 'httpListener') {
        if (isRestartKey && previousValue !== value) {
          this.lastSaveTriggeredRestart = 'http-listener';
        }
      } else if (rawCat === 'web') {
        if (isRestartKey && previousValue !== value) {
          this.lastSaveTriggeredRestart = 'web';
        }
      }

      for (const entries of this.groups.values()) {
        const entry = entries.find((candidate) => candidate.setting.key === key);
        if (entry) {
          entry.currentValue = this.configManager!.get(key);
          entry.isDefault = entry.currentValue === entry.setting.default;
        }
      }
    } catch (e) {
      logger.error('SettingsModal: failed to set config value', { key, error: summarizeError(e) });
    }
  }

}
