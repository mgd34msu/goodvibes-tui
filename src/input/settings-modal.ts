/**
 * SettingsModal — state management for the /settings and /config fullscreen workspace.
 *
 * Loads CONFIG_SCHEMA, groups settings by category, and tracks UI state:
 *   - Active category (Tab to cycle)
 *   - Selected setting index within category (↑↓)
 *   - Editing mode for inline string/number input
 *   - Feature-unit headers (each capability's real enablement row in its domain)
 *
 * Every save is a plain configManager.set(key, value) on a domain settings
 * key; the SDK settings bridge keeps the runtime gate manager in sync, and
 * this modal re-reads the manager after enablement writes so pending-restart
 * markers are shown honestly at the point of change.
 *
 * Data assembly delegates to settings-modal-data.ts (buildSettingGroups, etc.).
 * Mutation logic delegates to settings-modal-mutations.ts (applySettingValue, etc.).
 */

import { type ConfigKey } from '@pellux/goodvibes-sdk/platform/config';
import type { ModelPickerTarget } from './model-picker.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { SubscriptionManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceInspectionQuery } from '@/runtime/index.ts';
import type { SettingsDaemonCredentialWriter, SettingsSecretsManager } from './settings-modal-secrets.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@pellux/goodvibes-sdk/platform/payments';
import { PAYMENTS_CVV_HANDLING_CONFIG_KEY } from './payments-config.ts';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import type { McpRegistry } from '@pellux/goodvibes-sdk/platform/mcp';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { ConnectionStatus } from './commands/connection-status.ts';
import { initialConnectionEntries, refreshConnectionEntries } from './settings-modal-connections.ts';

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
  buildMcpEntries,
  buildSubscriptionEntries,
  buildNetworkFilteredItems,
  refreshEntryValues,
  searchSettingEntries,
} from './settings-modal-data.ts';
import { getSettingLabel } from '../renderer/settings-modal-helpers.ts';
import {
  applySettingValue,
  syncFlagEntryFromManager,
  type DaemonOwnedConfigWriter,
  type SettingAppliedCallback,
} from './settings-modal-mutations.ts';
import { featureEnablementWrite, isFeatureValueEnabled } from '../runtime/feature-settings.ts';
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
import { commitEditValue as _commitEditValue } from './settings-modal-commit.ts';

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
  /**
   * The daemon's credential write. A daemon-scoped credential (a mailbox
   * password, a bot token, a card) must land where the daemon reads it — this
   * surface storing a copy is a credential in a place nothing consults.
   */
  readonly daemonCredentials?: SettingsDaemonCredentialWriter | null;
  /**
   * Where a daemon-owned setting is written. Present when a daemon is
   * configured; without it every write stays local, which is right only when
   * there is no daemon to disagree with.
   */
  readonly daemonConfig?: DaemonOwnedConfigWriter | null;
  /** Renders a refused credential write, so a failed save is never silent. */
  readonly reportError?: (message: string) => void;
  /** In-process catalog the Connections category probes; see that module. */
  readonly gatewayMethods?: GatewayMethodCatalog;
  /** Called when an async connection refresh has new rows to paint. */
  readonly requestRender?: () => void;
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
  /**
   * Scroll offset (in wrapped lines) of the documentation pane for the
   * selected row. The renderer clamps it to the pane's real content height
   * and shows honest more-above/below markers — long feature documentation
   * scrolls, it never clips. Reset whenever the selection changes.
   */
  public contextScroll = 0;
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

  /** MCP server trust entries (populated when mcp tab is active). */
  public mcpEntries: McpEntry[] = [];
  /** Provider subscription entries (populated when subscriptions tab is active). */
  public subscriptionEntries: SubscriptionEntry[] = [];
  /** Connections-tab state; all of it driven by settings-modal-connections.ts. */
  public connectionEntries: ConnectionStatus[] = initialConnectionEntries();
  public gatewayMethods: GatewayMethodCatalog | null = null;
  public requestRender: (() => void) | null = null;
  public connectionsRefreshing = false;

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
  private daemonCredentials: SettingsDaemonCredentialWriter | null = null;
  private daemonConfig: DaemonOwnedConfigWriter | null = null;
  private reportError: ((message: string) => void) | null = null;
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
    this.daemonCredentials = options?.daemonCredentials ?? null;
    this.daemonConfig = options?.daemonConfig ?? null;
    this.reportError = options?.reportError ?? null;
    this.featureFlagManager = featureFlagManager;
    this.subscriptionManager = subscriptionManager;
    this.serviceRegistry = serviceRegistry;
    this.mcpRegistry = mcpRegistry ?? null;
    this.onSettingApplied = options?.onSettingApplied ?? null;
    this.groups = buildSettingGroups(configManager, featureFlagManager);
    this.mcpEntries = buildMcpEntries(this.mcpRegistry);
    this.subscriptionEntries = buildSubscriptionEntries(subscriptionManager, serviceRegistry);
    this.gatewayMethods = options?.gatewayMethods ?? null;
    this.requestRender = options?.requestRender ?? null;
    this.connectionEntries = initialConnectionEntries();
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
    this.contextScroll = 0;
    this.active = true;
  }

  /** Scroll the documentation pane by `delta` wrapped lines (renderer clamps the top end). */
  scrollContext(delta: number): void {
    this.contextScroll = Math.max(0, this.contextScroll + delta);
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
    this.contextScroll = 0;
    // A probe still in flight checks `active` before writing, so a reopen
    // starts from `checking` rather than from a finished session's answer.
    this.gatewayMethods = null;
    this.requestRender = null;
    this.connectionEntries = initialConnectionEntries();
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
    this.contextScroll = 0;
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
    this.contextScroll = 0;
    this.subscriptionLogoutConfirmationTarget = null;
    this._reloadTabEntries();
  }

  /** Cycle to the previous category (Shift+Tab). */
  prevCategory(): void {
    if (this.editingMode) return;
    this.categoryIndex = (this.categoryIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
    this.selectedIndex = 0;
    this.contextScroll = 0;
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
    this.contextScroll = 0;
    if (this.searchFocused) {
      if (this.searchResults.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.searchResults.length) % this.searchResults.length;
      }
      return;
    }
    const items = this._currentItems();
    if (items.length === 0) {
      if (this.currentCategory === 'mcp' && this.mcpEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.mcpEntries.length) % this.mcpEntries.length;
      } else if (this.currentCategory === 'subscriptions' && this.subscriptionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.subscriptionEntries.length) % this.subscriptionEntries.length;
        this.subscriptionLogoutConfirmationTarget = null;
      } else if (this.currentCategory === 'connections' && this.connectionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.connectionEntries.length) % this.connectionEntries.length;
      }
      return;
    }
    this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
    this.subscriptionLogoutConfirmationTarget = null;
  }

  moveDown(): void {
    if (this.editingMode) return;
    this.contextScroll = 0;
    if (this.searchFocused) {
      if (this.searchResults.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.searchResults.length;
      }
      return;
    }
    const items = this._currentItems();
    if (items.length === 0) {
      if (this.currentCategory === 'mcp' && this.mcpEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.mcpEntries.length;
      } else if (this.currentCategory === 'subscriptions' && this.subscriptionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.subscriptionEntries.length;
        this.subscriptionLogoutConfirmationTarget = null;
      } else if (this.currentCategory === 'connections' && this.connectionEntries.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.connectionEntries.length;
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
    this.contextScroll = 0;

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
   * Toggle the currently selected feature unit through its real domain
   * settings key: boolean/constant enablements flip the key, enum enablements
   * jump between the feature's stock active mode and its off mode. Killed
   * features cannot be toggled; constant capabilities with no off position
   * (non-boolean keys) are left to their domain settings.
   */
  toggleSelectedFlag(): void {
    const entry = this.getSelected();
    if (!entry?.flag) return;
    if (entry.flag.state === 'killed') return;
    const feature = entry.flag.feature;
    const currentlyOn = isFeatureValueEnabled(feature, entry.currentValue);
    const write = featureEnablementWrite(feature.id, !currentlyOn);
    if (!write) return;
    this._setValue(write.key, write.value);
  }

  /**
   * Commit the current editBuffer to the config.
   * Returns true on success, false if validation failed.
   */
  commitEdit(): boolean {
    return _commitEditValue({
      editingMode: this.editingMode,
      currentCategory: this.currentCategory,
      editBuffer: this.editBuffer,
      configManager: this.configManager,
      secretsManager: this.secretsManager,
      daemonCredentials: this.daemonCredentials,
      ...(this.reportError ? { reportError: this.reportError } : {}),
      mcpRegistry: this.mcpRegistry,
      mcpAllowAllConfirmationTarget: this.mcpAllowAllConfirmationTarget,
      getSelectedMcp: () => this.getSelectedMcp(),
      getSelected: () => this.getSelected(),
      setValue: (key, value) => this._setValue(key, value),
      setEditingMode: (v) => { this.editingMode = v; },
      setEditBuffer: (v) => { this.editBuffer = v; },
      setMcpEntries: (entries) => { this.mcpEntries = entries; },
      setMcpAllowAllConfirmationTarget: (v) => { this.mcpAllowAllConfirmationTarget = v; },
    });
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

  /** Reload mcp/subscription entries when the active tab changes. */
  private _reloadTabEntries(): void {
    if (this.currentCategory === 'mcp') {
      this.mcpEntries = buildMcpEntries(this.mcpRegistry);
    } else if (this.currentCategory === 'subscriptions') {
      this.subscriptionEntries = buildSubscriptionEntries(this.subscriptionManager, this.serviceRegistry);
    } else if (this.currentCategory === 'connections') {
      void refreshConnectionEntries(this);
    }
  }

  /**
   * Returns [] for the mcp/subscriptions categories (which render their own
   * entry types). Every other category flows through the normal group path,
   * feature-unit headers included.
   */
  private _currentItems(): SettingEntry[] {
    if (
      this.currentCategory === 'mcp'
      || this.currentCategory === 'subscriptions'
      || this.currentCategory === 'connections'
    ) return [];
    const items = this.groups.get(this.currentCategory) ?? [];
    if (this.currentCategory === 'network') {
      return buildNetworkFilteredItems(items, this.configManager);
    }
    return items;
  }

  private _setValue(key: ConfigKey, value: unknown): void {
    if (!this.configManager) return;

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
      daemonConfig: this.daemonConfig,
      ...(this.reportError ? { onAsyncError: this.reportError } : {}),
    });

    // Feature-unit headers write plain domain keys; the SDK settings bridge
    // has already applied the change to the gate manager (live flip for
    // runtime-toggleable features, pending-restart marker for startup-gated
    // ones). Re-read the manager for every header bound to this key so the
    // rows and the context pane show the honest state at the point of change.
    this._syncFeatureHeadersForKey(key);

    if (result.restartDomain !== null) {
      this.lastSaveTriggeredRestart = result.restartDomain;
    }
    if (result.effectMessage !== null) {
      this.lastSettingEffectMessage = result.effectMessage;
    }
    // No-op (result.changed === false, effectMessage === null): leave lastSettingEffectMessage untouched.

    // Selecting 'prompt' for payments.cvvHandling states the tradeoff at the
    // moment of selection, not just in the documentation pane — see the
    // SDK's own CVV_PROMPT_TRADEOFF_WARNING (platform/payments).
    if (key === PAYMENTS_CVV_HANDLING_CONFIG_KEY && value === 'prompt') {
      this.lastSettingEffectMessage = CVV_PROMPT_TRADEOFF_WARNING;
    }
  }

  /** Refresh live/persisted/pending state for every feature header bound to `key`. */
  private _syncFeatureHeadersForKey(key: ConfigKey): void {
    if (!this.featureFlagManager) return;
    for (const entries of this.groups.values()) {
      for (const entry of entries) {
        if (entry.flag && entry.flag.feature.enablement.key === key) {
          syncFlagEntryFromManager(entry.flag, this.featureFlagManager);
        }
      }
    }
  }

}
