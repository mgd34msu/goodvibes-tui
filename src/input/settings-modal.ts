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
 *
 * Data assembly delegates to settings-modal-data.ts (buildSettingGroups, etc.).
 * Mutation logic delegates to settings-modal-mutations.ts (applySettingValue, etc.).
 */

import { type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ModelPickerTarget } from './model-picker.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceInspectionQuery } from '../runtime/ui-service-queries.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import {
  setSecretBackedSettingValue,
  type SettingsSecretsManager,
} from './settings-modal-secrets.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import { isWorktreeSetupListConfigKey, parseWorktreeSetupListInput } from './worktree-setup-config.ts';
import { isSandboxExecListConfigKey, parseSandboxExecListInput } from './sandbox-exec-config.ts';
import { isExecEnvScrubAllowlistConfigKey, parseExecEnvScrubAllowlistInput } from './exec-env-scrub-config.ts';

import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
  type FlagEntry,
  type McpEntry,
  type SettingEntry,
  type SettingsCategory,
  type SettingsFocusPane,
  type SubscriptionEntry,
} from './settings-modal-types.ts';
import {
  buildSettingGroups,
  buildFlagEntries,
  buildMcpEntries,
  buildSubscriptionEntries,
  buildNetworkFilteredItems,
  refreshEntryValues,
  searchSettingEntries,
} from './settings-modal-data.ts';
import { getSettingLabel } from '../renderer/settings-modal-helpers.ts';
import {
  applySettingValue,
  applyFlagState,
  type SettingAppliedCallback,
} from './settings-modal-mutations.ts';
import {
  activateSelected as _activateSelected,
  handleSubscriptionLogoutKey as _handleSubscriptionLogoutKey,
} from './settings-modal-activation.ts';
import {
  adjustSelected as _adjustSelected,
} from './settings-modal-adjustment.ts';
import {
  resetSelected as _resetSelected,
  initiateResetCategory as _initiateResetCategory,
  initiateResetAll as _initiateResetAll,
  handleResetConfirmKey as _handleResetConfirmKey,
  type ResetConfirmKeyResult,
} from './settings-modal-reset.ts';

export interface SettingsModalChange {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly value: unknown;
}

export interface SettingsModalChangeResult {
  readonly message?: string;
}

export type SettingsModalChangeHandler = (change: SettingsModalChange) => SettingsModalChangeResult | void;

export interface SettingsModalOpenOptions {
  readonly onSettingApplied?: SettingsModalChangeHandler;
}

export {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_GROUPS,
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

  /** Pending category-reset confirmation gate, or null when inactive. */
  public resetCategoryConfirm: { readonly subject: string } | null = null;
  /** Pending reset-all confirmation gate, or null when inactive. */
  public resetAllConfirm: { readonly subject: 'all' } | null = null;

  /** Settings grouped by category. */
  public groups: Map<SettingsCategory, SettingEntry[]> = new Map();

  /** Feature flag entries (populated when flags tab is active). */
  public flagEntries: FlagEntry[] = [];
  /** MCP server trust entries (populated when mcp tab is active). */
  public mcpEntries: McpEntry[] = [];
  /** Provider subscription entries (populated when subscriptions tab is active). */
  public subscriptionEntries: SubscriptionEntry[] = [];

  /**
   * Whether the user has entered search mode (pressed / or a printable key
   * in the search input). Distinct from searchQuery.length > 0 because the
   * user may have deleted all chars while remaining in search mode.
   * Renderer should display the search prompt when this is true.
   */
  public searchFocused = false;

  /**
   * Current search query. Non-empty activates cross-category search mode.
   * Renderer should display searchResults instead of the per-category list
   * when searchQuery is non-empty.
   */
  public searchQuery = '';

  /**
   * Ranked cross-category results when searchQuery is non-empty.
   * Populated by setSearchQuery(); empty when searchQuery is ''.
   */
  public searchResults: SettingEntry[] = [];

  /**
   * Set after a network-category save that touches controlPlane or httpListener
   * config keys.  Renderer reads this to display a transient restart notice.
   * Cleared on next open() or close().
   */
  public lastSaveTriggeredRestart: 'control-plane' | 'http-listener' | 'web' | null = null;
  public lastSettingEffectMessage: string | null = null;

  private configManager: ConfigManager | null = null;
  private secretsManager: SettingsSecretsManager | null = null;
  private featureFlagManager: FeatureFlagManager | null = null;
  private mcpRegistry: McpRegistry | null = null;
  private subscriptionManager: SubscriptionManager | null = null;
  private serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null = null;
  private onSettingApplied: SettingsModalChangeHandler | null = null;

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
    options?: SettingsModalOpenOptions,
  ): void {
    this.configManager = configManager;
    this.secretsManager = secretsManager ?? null;
    this.featureFlagManager = featureFlagManager;
    this.subscriptionManager = subscriptionManager;
    this.serviceRegistry = serviceRegistry;
    this.mcpRegistry = mcpRegistry ?? null;
    this.onSettingApplied = options?.onSettingApplied ?? null;
    this.groups = buildSettingGroups(configManager, featureFlagManager);
    this.flagEntries = buildFlagEntries(featureFlagManager);
    this.mcpEntries = buildMcpEntries(this.mcpRegistry);
    this.subscriptionEntries = buildSubscriptionEntries(subscriptionManager, serviceRegistry);
    this.categoryIndex = 0;
    this.selectedIndex = 0;
    this.focusPane = 'categories';
    this.editingMode = false;
    this.editBuffer = '';
    this.pendingModelPickerTarget = null;
    this.pendingProviderModelPickerTarget = null;
    this.pendingSettingsPickerAction = null;
    this.mcpAllowAllConfirmationTarget = null;
    this.subscriptionLogoutConfirmationTarget = null;
    this.lastSaveTriggeredRestart = null;
    this.lastSettingEffectMessage = null;
    this.searchQuery = '';
    this.searchResults = [];
    this.searchFocused = false;
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
    this.lastSettingEffectMessage = null;
    this.searchQuery = '';
    this.searchResults = [];
    this.searchFocused = false;
    this.serviceRegistry = null;
    this.secretsManager = null;
    this.onSettingApplied = null;
    this.focusPane = 'settings';
  }

  /** Enter search mode (focus the search input bar). */
  focusSearch(): void {
    this.searchFocused = true;
    this.selectedIndex = 0;
  }

  /** Exit search mode without clearing the query. */
  blurSearch(): void {
    this.searchFocused = false;
  }

  /**
   * Update the search query and recompute cross-category ranked results.
   * Setting an empty string clears search mode.
   */
  setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.searchFocused = true;
    if (query.trim().length === 0) {
      this.searchResults = [];
    } else {
      this.searchResults = searchSettingEntries(query, this.groups, getSettingLabel);
    }
    this.selectedIndex = 0;
  }

  /** Clear search query, results, and exit search focus mode. */
  clearSearch(): void {
    this.searchQuery = '';
    this.searchResults = [];
    this.searchFocused = false;
  }

  /** Cycle to the next category (Tab). */
  nextCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex + 1) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    this._reloadTabEntries();
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    this._reloadTabEntries();
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
    if (this.searchFocused) {
      if (this.searchResults.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.searchResults.length) % this.searchResults.length;
      }
      return;
    }
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
    if (this.searchFocused) {
      if (this.searchResults.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.searchResults.length;
      }
      return;
    }
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
    if (this.searchFocused && this.searchResults.length > 0) {
      return this.searchResults[Math.max(0, Math.min(this.searchResults.length - 1, this.selectedIndex))] ?? null;
    }
    const items = this._currentItems();
    if (items.length === 0) return null;
    return items[Math.max(0, Math.min(items.length - 1, this.selectedIndex))] ?? null;
  }

  /**
   * Get the flag entry for the currently selected feature-unit header row, or
   * null when the selected row is a plain config setting. Feature-unit headers
   * now live across topical categories (not a single flags tab), so this reads
   * the selected SettingEntry's attached flag rather than a separate list.
   */
  getSelectedFlag(): FlagEntry | null {
    return this.getSelected()?.flag ?? null;
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
    _activateSelected({
      currentCategory: this.currentCategory,
      configManager: this.configManager,
      getSelectedMcp: () => this.getSelectedMcp(),
      getSelectedSubscription: () => this.getSelectedSubscription(),
      getSelected: () => this.getSelected(),
      setValue: (key, value) => this._setValue(key, value),
      setEditingMode: (v) => { this.editingMode = v; },
      setEditBuffer: (v) => { this.editBuffer = v; },
      setMcpAllowAllConfirmationTarget: (v) => { this.mcpAllowAllConfirmationTarget = v; },
      setSubscriptionLogoutConfirmationTarget: (v) => { this.subscriptionLogoutConfirmationTarget = v; },
      setPendingSettingsPickerAction: (v) => { this.pendingSettingsPickerAction = v; },
      setPendingModelPickerTarget: (v) => { this.pendingModelPickerTarget = v; },
      setPendingProviderModelPickerTarget: (v) => { this.pendingProviderModelPickerTarget = v; },
    });
  }

  /**
   * Handle a keystroke while a subscription logout confirm is pending.
   *
   * Follows the project-standard confirm contract (confirm-state.ts):
   *   - CONFIRM:  Enter, Return, or y  → executes logout, clears target
   *   - CANCEL:   Esc or n             → clears target, no logout
   *   - ABSORBED: any other key        → keeps confirm pending, swallows key
   *   - INACTIVE: no confirm pending   → returns 'inactive' (caller continues)
   */
  handleSubscriptionLogoutKey(key: string): 'confirmed' | 'cancelled' | 'absorbed' | 'inactive' {
    return _handleSubscriptionLogoutKey({
      subscriptionLogoutConfirmationTarget: this.subscriptionLogoutConfirmationTarget,
      subscriptionManager: this.subscriptionManager,
      serviceRegistry: this.serviceRegistry,
      setSubscriptionEntries: (entries) => { this.subscriptionEntries = entries; },
      setSubscriptionLogoutConfirmationTarget: (v) => { this.subscriptionLogoutConfirmationTarget = v; },
    }, key);
  }

  adjustSelected(direction: 'left' | 'right', step = 1): void {
    _adjustSelected({
      editingMode: this.editingMode,
      currentCategory: this.currentCategory,
      configManager: this.configManager,
      featureFlagManager: this.featureFlagManager,
      mcpRegistry: this.mcpRegistry,
      getSelectedFlag: () => this.getSelectedFlag(),
      getSelectedMcp: () => this.getSelectedMcp(),
      getSelected: () => this.getSelected(),
      setValue: (key, value) => this._setValue(key, value),
      setMcpEntries: (entries) => { this.mcpEntries = entries; },
      setMcpAllowAllConfirmationTarget: (v) => { this.mcpAllowAllConfirmationTarget = v; },
    }, direction, step);
  }

  /**
   * Toggle the currently selected feature flag.
   *
   * Killed flags cannot be toggled. Non-runtimeToggleable flags toggle in config
   * only (require restart). runtimeToggleable flags toggle immediately.
   */
  toggleSelectedFlag(): void {
    const entry = this.getSelected();
    if (!entry?.flag) return;
    if (entry.flag.state === 'killed') return;
    this._toggleFlagValue(entry.setting.key as ConfigKey, entry.flag.state !== 'enabled');
  }

  /**
   * Toggle the feature flag behind a `featureFlags.<id>` header row. Finds the
   * header entry, applies the desired state through the flag manager (runtime +
   * persisted override), and refreshes the header row's value/default marker in
   * place. Killed flags and no-op toggles are ignored.
   */
  private _toggleFlagValue(key: ConfigKey, value: unknown): void {
    if (!this.featureFlagManager || !this.configManager) return;
    let target: SettingEntry | null = null;
    for (const entries of this.groups.values()) {
      const candidate = entries.find((e) => e.setting.key === key && e.flag);
      if (candidate) { target = candidate; break; }
    }
    if (!target?.flag) return;
    if (target.flag.state === 'killed') return;
    const desired = value ? 'enabled' : 'disabled';
    if (target.flag.state === desired) return;
    applyFlagState(target.flag, desired, this.featureFlagManager, this.configManager);
    target.currentValue = target.flag.state === 'enabled';
    target.isDefault = target.flag.state === target.flag.flag.defaultState;
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
        this.mcpEntries = buildMcpEntries(this.mcpRegistry);
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
      this.mcpEntries = buildMcpEntries(this.mcpRegistry);
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

    if (isWorktreeSetupListConfigKey(setting.key)) {
      // Comma-separated display/edit convention for the array-backed
      // worktree.setup.* keys — see worktree-setup-config.ts.
      this._setValue(setting.key, parseWorktreeSetupListInput(this.editBuffer));
    } else if (isSandboxExecListConfigKey(setting.key)) {
      // Same comma-separated convention for the array-backed
      // sandbox.egressAllowlist / sandbox.workspaceWritable keys — see
      // sandbox-exec-config.ts.
      this._setValue(setting.key, parseSandboxExecListInput(this.editBuffer));
    } else if (isExecEnvScrubAllowlistConfigKey(setting.key)) {
      // Same comma-separated convention for permissions.execEnvScrubAllowlist
      // — see exec-env-scrub-config.ts.
      this._setValue(setting.key, parseExecEnvScrubAllowlistInput(this.editBuffer));
    } else if (setting.type === 'string' && isSecretConfigKey(setting.key)) {
      setSecretBackedSettingValue({
        key: setting.key,
        value: String(parsed ?? ''),
        configManager: this.configManager,
        secretsManager: this.secretsManager,
        setConfigValue: (key, value) => this._setValue(key, value),
      });
    } else {
      this._setValue(setting.key as ConfigKey, parsed);
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
    return _resetSelected({
      editingMode: this.editingMode,
      hasConfigManager: this.configManager !== null,
      selected: this.getSelected(),
      secretsManager: this.secretsManager,
      setValue: (key, value) => this._setValue(key, value),
    });
  }

  /** Arm a category-reset confirmation gate for the current category. */
  initiateResetCategory(): void {
    _initiateResetCategory({
      hasConfigManager: this.configManager !== null,
      currentCategory: this.currentCategory,
      setResetCategoryConfirm: (v) => { this.resetCategoryConfirm = v; },
      setResetAllConfirm: (v) => { this.resetAllConfirm = v; },
    });
  }

  /** Arm a reset-all confirmation gate. */
  initiateResetAll(): void {
    _initiateResetAll({
      hasConfigManager: this.configManager !== null,
      setResetCategoryConfirm: (v) => { this.resetCategoryConfirm = v; },
      setResetAllConfirm: (v) => { this.resetAllConfirm = v; },
    });
  }

  /** Route a key through the active reset confirm gate. See ResetConfirmKeyResult for the return contract. */
  handleResetConfirmKey(key: string): ResetConfirmKeyResult {
    return _handleResetConfirmKey({
      key,
      resetCategoryConfirm: this.resetCategoryConfirm,
      resetAllConfirm: this.resetAllConfirm,
      hasConfigManager: this.configManager !== null,
      currentItems: () => this._currentItems(),
      groups: this.groups,
      setValue: (k, value) => this._setValue(k, value),
      setResetCategoryConfirm: (v) => { this.resetCategoryConfirm = v; },
      setResetAllConfirm: (v) => { this.resetAllConfirm = v; },
    });
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

  // ── Private helpers ────────────────────────────────────────────────────────────────

  /** Reload flag/mcp/subscription entries when the active tab changes. */
  private _reloadTabEntries(): void {
    if (this.currentCategory === 'flags') {
      this.flagEntries = buildFlagEntries(this.featureFlagManager);
    } else if (this.currentCategory === 'mcp') {
      this.mcpEntries = buildMcpEntries(this.mcpRegistry);
    } else if (this.currentCategory === 'subscriptions') {
      this.subscriptionEntries = buildSubscriptionEntries(this.subscriptionManager, this.serviceRegistry);
    }
  }

  /**
   * Returns [] for the mcp/subscriptions categories (which render their own
   * entry types). The 'flags' category now flows through the normal group path
   * — it holds the no-config feature-unit toggles (Advanced Features).
   */
  private _currentItems(): SettingEntry[] {
    if (
      this.currentCategory === 'mcp'
      || this.currentCategory === 'subscriptions'
    ) return [];
    const items = this.groups.get(this.currentCategory) ?? [];
    if (this.currentCategory === 'network') {
      return buildNetworkFilteredItems(items, this.configManager);
    }
    return items;
  }

  private _setValue(key: ConfigKey, value: unknown): void {
    if (!this.configManager) return;

    // Feature-unit toggle headers write to `featureFlags.<id>`; route those to
    // the feature-flag manager (runtime toggle + persisted override) instead of
    // a plain config write. Reset/adjust/activate all funnel a boolean value
    // here (true = enabled), so this is the single flag-toggle chokepoint.
    if (typeof key === 'string' && key.startsWith('featureFlags.')) {
      this._toggleFlagValue(key, value);
      return;
    }

    const callback: SettingAppliedCallback | null = this.onSettingApplied
      ? (change) => this.onSettingApplied!(change)
      : null;

    const result = applySettingValue({
      key,
      value,
      configManager: this.configManager,
      groups: this.groups,
      onSettingApplied: callback,
      refreshGroups: () => {
        if (this.configManager) refreshEntryValues(this.groups, this.configManager);
      },
    });

    if (result.restartDomain !== null) {
      this.lastSaveTriggeredRestart = result.restartDomain;
    }
    if (result.effectMessage !== null) {
      this.lastSettingEffectMessage = result.effectMessage;
    }
    // No-op (result.changed === false, effectMessage === null): leave lastSettingEffectMessage untouched.
  }

}
