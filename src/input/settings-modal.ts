/**
 * SettingsModal — state management for the /settings config browser modal.
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
import { listBuiltinSubscriptionProviders } from '@pellux/goodvibes-sdk/platform/config/subscription-providers';
import type { ProviderAuthFreshness, ProviderAuthRoute } from '@pellux/goodvibes-sdk/platform/runtime/provider-accounts/registry';
import { getResolvedSettingLookup } from '@pellux/goodvibes-sdk/platform/runtime/settings/control-plane';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import {
  getNumericAdjustmentMeta,
  modelPickerLaunchForKey,
  roundToPrecision,
} from './settings-modal-behavior.ts';
import {
  setSecretBackedSettingValue,
  type SettingsSecretsManager,
} from './settings-modal-secrets.ts';
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
  type SubscriptionEntry,
} from './settings-modal-types.ts';

export {
  SETTINGS_CATEGORIES,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
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
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
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
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSaveTriggeredRestart = null;
    this.serviceRegistry = null;
    this.secretsManager = null;
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
    return this._currentItems()[this.selectedIndex] ?? null;
  }

  /** Get the currently selected flag entry (flags tab only). */
  getSelectedFlag(): FlagEntry | null {
    if (this.currentCategory !== 'flags') return null;
    return this.flagEntries[this.selectedIndex] ?? null;
  }

  getSelectedMcp(): McpEntry | null {
    if (this.currentCategory !== 'mcp') return null;
    return this.mcpEntries[this.selectedIndex] ?? null;
  }

  getSelectedSubscription(): SubscriptionEntry | null {
    if (this.currentCategory !== 'subscriptions') return null;
    return this.subscriptionEntries[this.selectedIndex] ?? null;
  }

  get currentCategory(): SettingsCategory {
    return SETTINGS_CATEGORIES[this.categoryIndex];
  }

  get currentItems(): SettingEntry[] {
    return this._currentItems();
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
      // Route helper.* settings into the tools group for unified display
      // Route controlPlane.* and httpListener.* into the network group
      let cat: SettingsCategory;
      if (rawCat === 'helper') {
        cat = 'tools';
      } else if (rawCat === 'controlPlane' || rawCat === 'httpListener' || rawCat === 'web') {
        cat = 'network';
      } else if (rawCat === 'surfaces') {
        cat = 'surfaces';
      } else if (rawCat === 'cloudflare' || rawCat === 'batch') {
        cat = 'cloudflare';
      } else {
        cat = rawCat as SettingsCategory;
      }
      if (!this.groups.has(cat)) continue;
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
      this.groups.get(cat)!.push(entry);
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
    const manager = this.subscriptionManager;
    if (!manager) {
      this.subscriptionEntries = [];
      return;
    }
    const services = this.serviceRegistry?.getAll() ?? {};
    const providers = new Map<string, SubscriptionEntry>();
    const builtinProviders = new Set(listBuiltinSubscriptionProviders().map((builtin) => builtin.provider));

    const determineFreshness = (expiresAt?: number): ProviderAuthFreshness => {
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'healthy';
      if (expiresAt <= Date.now()) return 'expired';
      if (expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
      return 'healthy';
    };

    for (const provider of builtinProviders) {
      providers.set(provider, {
        provider,
        state: 'available',
        oauthConfigured: true,
        preferredRoute: 'subscription',
        activeRoute: 'unconfigured',
        authFreshness: 'unconfigured',
        routeReason: 'Built-in subscription adapter is available, but no active subscription session is stored yet.',
        nextActions: [`Use /subscription login ${provider} start to begin browser sign-in.`],
      });
    }

    for (const service of Object.values(services)) {
      if (service.authType === 'oauth' && service.oauth) {
        const provider = service.providerId ?? service.name;
        providers.set(provider, {
          provider,
          state: 'available',
          oauthConfigured: true,
          preferredRoute: 'subscription',
          activeRoute: providers.get(provider)?.activeRoute ?? 'unconfigured',
          authFreshness: providers.get(provider)?.authFreshness ?? 'unconfigured',
          routeReason: providers.get(provider)?.routeReason ?? 'OAuth metadata is configured for this provider.',
          nextActions: providers.get(provider)?.nextActions ?? [`Use /subscription login ${provider} start to begin browser sign-in.`],
        });
      }
    }

    for (const pending of manager.listPending()) {
      providers.set(pending.provider, {
        provider: pending.provider,
        state: 'pending',
        oauthConfigured: providers.get(pending.provider)?.oauthConfigured ?? false,
        preferredRoute: 'subscription',
        activeRoute: 'unconfigured',
        authFreshness: 'pending',
        routeReason: 'OAuth login is pending completion for this provider.',
        nextActions: [`Finish /subscription login ${pending.provider} finish <code> to activate this session.`],
      });
    }

    for (const subscription of manager.list()) {
      const freshness = determineFreshness(subscription.expiresAt);
      const issues = freshness === 'expired'
        ? ['Stored subscription session is expired and needs refresh.']
        : freshness === 'expiring'
          ? ['Stored subscription session expires within 24 hours.']
          : [];
      const nextActions = freshness === 'expired'
        ? [`Refresh or replace the ${subscription.provider} subscription session.`]
        : freshness === 'expiring'
          ? [`Verify or renew the ${subscription.provider} subscription session soon.`]
          : [];
      providers.set(subscription.provider, {
        provider: subscription.provider,
        state: 'active',
        tokenType: subscription.tokenType,
        expiresAt: subscription.expiresAt,
        oauthConfigured: providers.get(subscription.provider)?.oauthConfigured ?? builtinProviders.has(subscription.provider),
        activeRoute: freshness === 'expired' ? 'unconfigured' : 'subscription',
        preferredRoute: 'subscription',
        authFreshness: freshness,
        routeReason: subscription.overrideAmbientApiKeys
          ? 'Subscription route overrides ambient API-key resolution for this provider.'
          : 'Subscription route is stored for supported flows without automatically replacing ambient API-key resolution.',
        issues,
        nextActions,
      });
    }

    this.subscriptionEntries = [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
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
      // Hide host fields when the corresponding hostMode is not 'custom'
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
      // Update the cached entry in-place — avoids full schema re-scan on each edit
      const rawCat = key.split('.')[0] as string;
      // Resolve the display category from the key prefix
      let cat: SettingsCategory;
      if (rawCat === 'helper') {
        cat = 'tools';
      } else if (rawCat === 'controlPlane') {
        cat = 'network';
        // SDK auto-restarts the daemon server on controlPlane binding changes
        if (isRestartKey && previousValue !== value) {
          this.lastSaveTriggeredRestart = 'control-plane';
        }
      } else if (rawCat === 'httpListener') {
        cat = 'network';
        // SDK auto-restarts the HTTP listener on binding changes
        if (isRestartKey && previousValue !== value) {
          this.lastSaveTriggeredRestart = 'http-listener';
        }
      } else if (rawCat === 'web') {
        cat = 'network';
        // SDK auto-restarts the web server on binding changes
        if (isRestartKey && previousValue !== value) {
          this.lastSaveTriggeredRestart = 'web';
        }
      } else if (rawCat === 'surfaces') {
        cat = 'surfaces';
      } else if (rawCat === 'cloudflare' || rawCat === 'batch') {
        cat = 'cloudflare';
      } else {
        cat = rawCat as SettingsCategory;
      }
      const entries = this.groups.get(cat);
      if (entries) {
        const entry = entries.find(e => e.setting.key === key);
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
