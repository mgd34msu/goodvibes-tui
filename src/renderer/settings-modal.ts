/**
 * renderSettingsModal — renders the /settings config browser modal as Line[]
 * using ModalFactory.
 *
 * Layout:
 *   - Title bar: ┌─ Settings ───────────────────────────────────────┐
 *   - Category tabs row
 *   - Separator
 *   - Settings list (current category)
 *   - Footer hints: [Tab] Category  [↑↓] Navigate  [Enter] Edit/Toggle  [Esc] Close
 */

import type { Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { SettingsModal, SettingEntry, FlagEntry, McpEntry, SubscriptionEntry } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES } from '../input/settings-modal.ts';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { getOverlaySurfaceMetrics, getStableOverlayContentRows } from './overlay-viewport.ts';
import { getVisibleWindow } from './surface-layout.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatValue(entry: SettingEntry): string {
  const val = entry.currentValue;
  if (val === null || val === undefined) return '(unset)';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'string' && val === '') return '(empty)';
  return String(val);
}

function valueColor(entry: SettingEntry): string {
  if (!entry.isDefault) return '#00ffcc'; // cyan-green = modified
  return '244';                            // dim = default
}

function flagStateColor(state: string, killed: boolean): string {
  if (killed) return '#ef4444'; // red
  if (state === 'enabled') return '#00ffcc'; // cyan-green
  return '244'; // dim
}

function mcpTrustColor(mode: McpEntry['trustMode']): string {
  switch (mode) {
    case 'allow-all':
      return '#ef4444';
    case 'ask-on-risk':
      return '#eab308';
    case 'constrained':
      return '#00ffcc';
    case 'blocked':
      return '244';
    default:
      return '244';
  }
}

function subscriptionStateColor(state: SubscriptionEntry['state']): string {
  switch (state) {
    case 'active':
      return '#00ffcc';
    case 'pending':
      return '#eab308';
    case 'available':
      return '#38bdf8';
    default:
      return '244';
  }
}

function inferSubscriptionRouteReason(entry: SubscriptionEntry): string | undefined {
  if (entry.routeReason?.trim()) return entry.routeReason;
  if (entry.state === 'active' && entry.oauthConfigured) {
    return 'ambient key override enabled for this provider.';
  }
  if (entry.state === 'pending' && entry.oauthConfigured) {
    return 'oauth configuration present; ambient key override will apply after activation.';
  }
  return undefined;
}

const CATEGORY_LABELS: Record<(typeof SETTINGS_CATEGORIES)[number], string> = {
  display: 'Display',
  ui: 'UI',
  provider: 'Provider',
  subscriptions: 'Subscriptions',
  behavior: 'Behavior',
  storage: 'Storage',
  permissions: 'Permissions',
  mcp: 'MCP',
  sandbox: 'Sandbox',
  danger: 'Danger',
  tools: 'Tools',
  flags: 'Flags',
};

const SETTING_LABELS: Partial<Record<string, string>> = {
  'ui.systemMessages': 'System Message Target',
  'ui.operationalMessages': 'Operational Message Target',
  'ui.wrfcMessages': 'WRFC Message Target',
  'ui.voiceEnabled': 'Voice Surface',
  'behavior.autoCompactThreshold': 'Auto-Compact %',
  'behavior.staleContextWarnings': 'Context Warnings',
  'behavior.returnContextMode': 'Return Context',
  'behavior.guidanceMode': 'Guidance Mode',
  'storage.secretPolicy': 'Secret Policy',
  'sandbox.vmBackend': 'Sandbox Backend',
  'sandbox.qemuBinary': 'QEMU Binary',
  'sandbox.qemuImagePath': 'QEMU Image',
  'sandbox.qemuExecWrapper': 'QEMU Wrapper',
  'tools.llmProvider': 'Tool LLM Provider',
  'tools.llmModel': 'Tool LLM Model',
  'tools.autoHeal': 'Auto-Heal',
  'tools.defaultTokenBudget': 'Default Token Budget',
  'tools.hooksFile': 'Hooks File',
  'helper.enabled': 'Helper Enabled',
  'helper.globalProvider': 'Helper Provider',
  'helper.globalModel': 'Helper Model',
};

function getSettingLabel(entry: SettingEntry): string {
  return SETTING_LABELS[entry.setting.key] ?? entry.setting.key.replace(/^[^.]+\./, '');
}

function describeUiRouting(value: string): string {
  switch (value) {
    case 'panel':
      return 'render in panels only';
    case 'conversation':
      return 'render inline in conversation';
    case 'both':
      return 'render in both conversation and panels';
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the settings modal as Line[] for overlay in the viewport.
 *
 * @param modal  SettingsModal state object.
 * @param width  Terminal width.
 */
export function renderSettingsModal(
  modal: SettingsModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const metrics = getOverlaySurfaceMetrics(width, viewportHeight, {
    chromeRows: 8,
    minContentRows: 5,
    maxContentRows: 8,
  });
  const boxMargin = metrics.margin;
  const boxW = metrics.boxWidth;
  const contentW = metrics.contentWidth;
  const maxVisibleRows = metrics.contentRows;
  const targetContentRows = getStableOverlayContentRows(maxVisibleRows, 8);

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  const isDangerTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'danger';
  const isMcpTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'mcp';
  const isSubscriptionsTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'subscriptions';
  const isFlagsTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'flags';
  const isUiTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'ui';
  const isToolsTab = SETTINGS_CATEGORIES[modal.categoryIndex] === 'tools';
  let persistentHelpers: import('./modal-factory.ts').ModalHelperRow[] | undefined;
  sections.push({
    type: 'text',
    content: isDangerTab
      ? 'High-impact configuration. Treat changes here as operational overrides, not everyday preferences.'
      : isMcpTab
        ? 'Review MCP role, trust, and scope. High-risk escalation is intentionally more explicit here.'
        : isSubscriptionsTab
          ? 'Manage provider login state and subscription-backed routing without dropping into raw config files.'
          : isUiTab
            ? 'Control shell presentation, including where operational and WRFC updates render across conversation and panels.'
          : isFlagsTab
            ? 'Feature flags control staged or experimental behavior. Some changes may require restart.'
            : isToolsTab
              ? 'Configure tool LLM routing and helper model. Provider and model fields are optional — empty means use the active provider.'
              : 'Browse and adjust operator-facing runtime settings by category.',
    style: { fg: '246', dim: true },
  });

  sections.push({ type: 'separator' });

  // ── Flags tab ──────────────────────────────────────────────────
  if (isFlagsTab) {
    const flagEntries: FlagEntry[] = modal.flagEntries;

    if (flagEntries.length === 0) {
      sections.push({
        type: 'text',
        content: '(no feature flags registered)',
        style: { fg: '240', dim: true },
      });
    } else {
      // Column widths for flags table
      const nameW = Math.floor(contentW * 0.30);
      const tierW = 5;
      const stateW = 10;
      const notesW = Math.max(0, contentW - nameW - tierW - stateW - 6);

      // Column header
      const nameHdr = 'Name'.padEnd(nameW);
      const tierHdr = 'Tier'.padEnd(tierW);
      const stateHdr = 'State'.padEnd(stateW);
      const notesHdr = 'Notes';
      sections.push({
        type: 'text',
        content: `${nameHdr}  ${tierHdr}  ${stateHdr}  ${notesHdr}`,
        style: { fg: '240', dim: true },
      });
      sections.push({ type: 'separator' });

      const window = getVisibleWindow(flagEntries.length, modal.selectedIndex, maxVisibleRows);
      const visibleFlags = flagEntries.slice(window.start, window.end);
      const listItems: import('./modal-factory.ts').ModalListItem[] = visibleFlags.map((entry, idx) => {
        const isSelected = window.start + idx === modal.selectedIndex;
        const isKilled = entry.state === 'killed';

        const nameStr = entry.flag.name.length > nameW
          ? entry.flag.name.slice(0, nameW - 1) + '\u2026'
          : entry.flag.name.padEnd(nameW);
        const tierStr = String(entry.flag.tier).padEnd(tierW);

        let stateStr: string;
        if (isKilled) {
          stateStr = 'KILLED'.padEnd(stateW);
        } else {
          stateStr = entry.state.padEnd(stateW);
        }

        const notes = !entry.flag.runtimeToggleable && !isKilled ? '(restart required)' : '';
        const notesStr = notes.length > notesW ? notes.slice(0, notesW - 1) + '\u2026' : notes;

        const label = `${nameStr}  ${tierStr}  ${stateStr}  ${notesStr}`;

        return {
          label,
          selected: isSelected,
          style: isSelected ? undefined : { fg: flagStateColor(entry.state, isKilled) },
        };
      });

      sections.push({ type: 'list', items: listItems });
      if (flagEntries.length > maxVisibleRows) {
        sections.push({
          type: 'text',
          content: `[${window.start + 1}-${window.end} of ${flagEntries.length}]`,
          style: { fg: '244', dim: true },
        });
      }

      // Description of selected flag
      const selected = modal.getSelectedFlag();
      if (selected) {
        sections.push({ type: 'separator' });
        const desc = selected.flag.description;
        const truncated = desc.length > contentW
          ? desc.slice(0, contentW - 1) + '\u2026'
          : desc;
        sections.push({
          type: 'text',
          content: truncated,
          style: { fg: '246', dim: true },
        });
        if (selected.state === 'killed' && selected.flag.killReason) {
          const killStr = `Kill reason: ${selected.flag.killReason}`;
          const killTrunc = killStr.length > contentW ? killStr.slice(0, contentW - 1) + '\u2026' : killStr;
          sections.push({
            type: 'text',
            content: killTrunc,
            style: { fg: '#ef4444', dim: true },
          });
        }
      }
    }

    const hints = ['[Tab] Category', '[\u2191\u2193] Navigate', '[←/→] Adjust', '[Enter] Toggle', '[Esc] Close'];
    return ModalFactory.createModal(
      {
        title: 'Settings',
        width: boxW,
        margin: boxMargin,
        targetContentRows,
        tabs: SETTINGS_CATEGORIES.map((category, index) => ({
          label: CATEGORY_LABELS[category],
          active: index === modal.categoryIndex,
        })),
        sections,
        hints,
        helpers: persistentHelpers,
      },
      width,
    );
  }

  if (isMcpTab) {
    const mcpEntries = modal.mcpEntries;

    if (mcpEntries.length === 0) {
      sections.push({
        type: 'text',
        content: '(no MCP servers registered)',
        style: { fg: '240', dim: true },
      });
    } else {
      const visibleRows = Math.max(1, maxVisibleRows - 4);
      const nameW = Math.floor(contentW * 0.28);
      const roleW = 12;
      const trustW = 13;
      const scopeW = Math.max(0, contentW - nameW - roleW - trustW - 6);

      sections.push({
        type: 'text',
        content: `${fitDisplay('Server', nameW)}  ${fitDisplay('Role', roleW)}  ${fitDisplay('Trust', trustW)}  Scope`,
        style: { fg: '240', dim: true },
      });
      sections.push({ type: 'separator' });

      const window = getVisibleWindow(mcpEntries.length, modal.selectedIndex, visibleRows);
      const visibleMcpEntries = mcpEntries.slice(window.start, window.end);
      const listItems: import('./modal-factory.ts').ModalListItem[] = visibleMcpEntries.map((entry, idx) => {
        const isSelected = window.start + idx === modal.selectedIndex;
        const isEditing = isSelected && modal.editingMode;
        const trustValue = isEditing ? `${modal.editBuffer}\u2588` : entry.trustMode;
        const scopeValue = entry.allowedPaths.length > 0
          ? `paths:${entry.allowedPaths.length}`
          : entry.allowedHosts.length > 0
            ? `hosts:${entry.allowedHosts.length}`
            : 'unbounded';
        const label = `${fitDisplay(entry.name, nameW)}  ${fitDisplay(entry.role, roleW)}  ${fitDisplay(trustValue, trustW)}  ${fitDisplay(scopeValue, scopeW)}`;
        return {
          label,
          selected: isSelected,
          style: isSelected ? undefined : { fg: mcpTrustColor(entry.trustMode) },
        };
      });

      sections.push({ type: 'list', items: listItems });
      if (mcpEntries.length > visibleRows) {
        sections.push({
          type: 'text',
          content: `[${window.start + 1}-${window.end} of ${mcpEntries.length}]`,
          style: { fg: '244', dim: true },
        });
      }

      const selected = modal.getSelectedMcp();
      if (selected) {
        sections.push({ type: 'separator' });
        sections.push({
          type: 'text',
          content: `Trust ${selected.trustMode} for ${selected.name} (${selected.connected ? 'connected' : 'disconnected'}, role ${selected.role}).`,
          style: { fg: '246', dim: true },
        });
        const scope = selected.allowedPaths.length > 0
          ? `Path scope: ${selected.allowedPaths.join(', ')}`
          : selected.allowedHosts.length > 0
            ? `Host scope: ${selected.allowedHosts.join(', ')}`
            : 'No explicit path or host scope is configured.';
        sections.push({
          type: 'text',
          content: truncateDisplay(scope, contentW),
          style: { fg: '240', dim: true },
        });
        const guidance = modal.mcpAllowAllConfirmationTarget
          ? `Type ALLOW ALL ${modal.mcpAllowAllConfirmationTarget} to confirm unrestricted trust for this server.`
          : 'Press Enter to edit trust mode. Type constrained, ask-on-risk, allow-all, or blocked, then press Enter.';
        sections.push({
          type: 'text',
          content: truncateDisplay(guidance, contentW),
          style: { fg: modal.mcpAllowAllConfirmationTarget ? '#ef4444' : '#38bdf8', dim: true },
        });
        if (modal.mcpAllowAllConfirmationTarget) {
          persistentHelpers = [{ content: truncateDisplay(guidance, contentW), accent: true }];
        }
      }
    }

    const hints = modal.editingMode
      ? ['[Enter] Confirm', '[Esc] Cancel']
      : ['[Tab] Category', '[Up/Down] Navigate', '[←/→] Cycle Trust', '[Enter] Edit Trust', '[Esc] Close'];

    return ModalFactory.createModal(
      {
        title: 'Settings',
        width: boxW,
        margin: boxMargin,
        targetContentRows,
        tabs: SETTINGS_CATEGORIES.map((category, index) => ({
          label: CATEGORY_LABELS[category],
          active: index === modal.categoryIndex,
        })),
        sections,
        helpers: persistentHelpers,
        hints,
      },
      width,
    );
  }

  if (isSubscriptionsTab) {
    const subscriptionEntries = modal.subscriptionEntries;

    if (subscriptionEntries.length === 0) {
      sections.push({
        type: 'text',
        content: '(no provider subscriptions available or configured)',
        style: { fg: '240', dim: true },
      });
    } else {
      const visibleRows = Math.max(1, maxVisibleRows - 4);
      const providerW = Math.floor(contentW * 0.28);
      const stateW = 12;
      const routeW = 14;
      const scopeW = Math.max(0, contentW - providerW - stateW - routeW - 6);

      sections.push({
        type: 'text',
        content: `${fitDisplay('Provider', providerW)}  ${fitDisplay('State', stateW)}  ${fitDisplay('Route', routeW)}  Notes`,
        style: { fg: '240', dim: true },
      });
      sections.push({ type: 'separator' });

      const window = getVisibleWindow(subscriptionEntries.length, modal.selectedIndex, visibleRows);
      const visibleSubscriptions = subscriptionEntries.slice(window.start, window.end);
      const listItems: import('./modal-factory.ts').ModalListItem[] = visibleSubscriptions.map((entry, idx) => {
        const isSelected = window.start + idx === modal.selectedIndex;
        const routeReason = inferSubscriptionRouteReason(entry);
        const note = routeReason?.toLowerCase().includes('ambient key override')
          ? 'ambient key ov'
          : entry.state === 'active'
          ? entry.authFreshness === 'expiring'
            ? 'session nearing expiry'
            : entry.authFreshness === 'expired'
              ? 'stored session expired'
              : 'session active'
          : entry.state === 'pending'
            ? 'awaiting code exchange'
            : entry.oauthConfigured
              ? 'ready for login'
              : 'config required';
        const label = `${fitDisplay(entry.provider, providerW)}  ${fitDisplay(entry.state, stateW)}  ${fitDisplay(entry.activeRoute ?? 'n/a', routeW)}  ${fitDisplay(note, scopeW)}`;
        return {
          label,
          selected: isSelected,
          style: isSelected ? undefined : { fg: subscriptionStateColor(entry.state) },
        };
      });

      sections.push({ type: 'list', items: listItems });
      if (subscriptionEntries.length > visibleRows) {
        sections.push({
          type: 'text',
          content: `[${window.start + 1}-${window.end} of ${subscriptionEntries.length}]`,
          style: { fg: '244', dim: true },
        });
      }

      const selected = modal.getSelectedSubscription();
      if (selected) {
        sections.push({ type: 'separator' });
        const expires = selected.expiresAt ? new Date(selected.expiresAt).toISOString() : 'n/a';
        const routeReason = inferSubscriptionRouteReason(selected);
        sections.push({
          type: 'text',
          content: truncateDisplay(
            `${routeReason?.toLowerCase().includes('ambient key override') ? 'ambient key ov. ' : ''}Subscription ${selected.provider} is ${selected.state}. Active route is ${selected.activeRoute ?? 'n/a'} and preferred route is ${selected.preferredRoute ?? 'n/a'}. OAuth config is ${selected.oauthConfigured ? 'present' : 'missing'}.`.trim(),
            contentW,
          ),
          style: { fg: '246', dim: true },
        });
        sections.push({
          type: 'text',
          content: truncateDisplay(`Expires: ${expires}  Freshness: ${selected.authFreshness ?? 'n/a'}`, contentW),
          style: { fg: '240', dim: true },
        });
        if (routeReason) {
          sections.push({
            type: 'text',
            content: truncateDisplay(routeReason, contentW),
            style: { fg: '240', dim: true },
          });
        }
        for (const issue of selected.issues ?? []) {
          sections.push({
            type: 'text',
            content: truncateDisplay(`Issue: ${issue}`, contentW),
            style: { fg: '#ef4444', dim: true },
          });
        }
        const guidance = selected.state === 'active' || selected.state === 'pending'
          ? modal.subscriptionLogoutConfirmationTarget === selected.provider
            ? `Press Enter again to sign out ${selected.provider}. Move selection or close settings to cancel.`
            : 'Press Enter to review sign-out for this provider session.'
          : 'Use /subscription login <provider> start to begin OAuth sign-in for this provider.';
        sections.push({
          type: 'text',
          content: truncateDisplay(guidance, contentW),
          style: { fg: selected.state === 'active' || selected.state === 'pending' ? '#f59e0b' : '#38bdf8', dim: true },
        });
        if ((selected.nextActions?.length ?? 0) > 0) {
          sections.push({
            type: 'text',
            content: truncateDisplay(`Next: ${selected.nextActions![0]}`, contentW),
            style: { fg: '#38bdf8', dim: true },
          });
        }
        if (modal.subscriptionLogoutConfirmationTarget === selected.provider) {
          persistentHelpers = [{ content: truncateDisplay(guidance, contentW), accent: true }];
        }
      }
    }

    const hints = ['[Tab] Category', '[Up/Down] Navigate', '[Enter] Review / Confirm', '[Esc] Close'];
    return ModalFactory.createModal(
      {
        title: 'Settings',
        width: boxW,
        margin: boxMargin,
        targetContentRows,
        tabs: SETTINGS_CATEGORIES.map((category, index) => ({
          label: CATEGORY_LABELS[category],
          active: index === modal.categoryIndex,
        })),
        sections,
        hints,
        helpers: persistentHelpers,
      },
      width,
    );
  }

  // ── Tools tab ─────────────────────────────────────────────────
  if (isToolsTab) {
    const toolsItems = modal.currentItems; // includes helper.* entries routed into tools group

    if (toolsItems.length === 0) {
      sections.push({
        type: 'text',
        content: '(no tool or helper settings available)',
        style: { fg: '240', dim: true },
      });
    } else {
      const labelW = Math.floor(contentW * 0.38);
      const valW = Math.floor(contentW * 0.30);
      const srcW = Math.max(0, contentW - labelW - valW - 4);

      sections.push({
        type: 'text',
        content: `${fitDisplay('Setting', labelW)}  ${fitDisplay('Value', valW)}  Source`,
        style: { fg: '240', dim: true },
      });
      sections.push({ type: 'separator' });

      const window = getVisibleWindow(toolsItems.length, modal.selectedIndex, maxVisibleRows);
      const visibleItems = toolsItems.slice(window.start, window.end);

      // Render each entry as an individual text row so section headers can interleave.
      // Section headers are emitted when the key prefix changes (tools.* vs helper.*).
      let lastGroupPrefix = '';
      for (let i = 0; i < visibleItems.length; i++) {
        const entry = visibleItems[i]!;
        const isSelected = window.start + i === modal.selectedIndex;
        const isEditing = isSelected && modal.editingMode;
        const prefix = entry.setting.key.split('.')[0]!;

        // Emit a section header when the group prefix changes
        if (prefix !== lastGroupPrefix) {
          lastGroupPrefix = prefix;
          const sectionLabel = prefix === 'helper' ? '── Helper Model ──' : '── Tool LLM ──';
          sections.push({
            type: 'text',
            content: fitDisplay(sectionLabel, contentW),
            style: { fg: '243', dim: true },
          });
        }

        const label = getSettingLabel(entry);
        const labelStr = fitDisplay(label, labelW);

        let valueStr: string;
        if (entry.setting.type === 'boolean') {
          const boolVal = Boolean(entry.currentValue);
          valueStr = isEditing ? `${modal.editBuffer}\u2588` : (boolVal ? '[on]' : '[off]');
        } else if (isEditing) {
          valueStr = `${modal.editBuffer}\u2588`;
        } else {
          valueStr = formatValue(entry);
        }

        const valStr = fitDisplay(valueStr, valW);
        const sourceText = entry.effectiveSource ?? 'default';
        const srcStr = fitDisplay(sourceText, srcW);
        const rowLabel = `${labelStr}  ${valStr}  ${srcStr}`;

        // Render as a single-item list so the ModalFactory applies selection highlight
        sections.push({
          type: 'list',
          items: [{
            label: rowLabel,
            selected: isSelected,
            style: isSelected ? undefined : { fg: valueColor(entry) },
          }],
        });
      }

      if (toolsItems.length > maxVisibleRows) {
        sections.push({
          type: 'text',
          content: `[${window.start + 1}-${window.end} of ${toolsItems.length}]`,
          style: { fg: '244', dim: true },
        });
      }

      // Description of selected entry
      const selected = modal.getSelected();
      if (selected) {
        sections.push({ type: 'separator' });
        sections.push({
          type: 'text',
          content: truncateDisplay(selected.setting.description, contentW),
          style: { fg: '246', dim: true },
        });
        if (selected.setting.type === 'boolean') {
          sections.push({
            type: 'text',
            content: truncateDisplay(`Currently ${Boolean(selected.currentValue) ? 'enabled' : 'disabled'}. Press Enter or Space to toggle.`, contentW),
            style: { fg: '#38bdf8', dim: true },
          });
        } else {
          const emptyNote = selected.currentValue === '' || selected.currentValue === null || selected.currentValue === undefined
            ? ' (empty = use active provider default)'
            : '';
          sections.push({
            type: 'text',
            content: truncateDisplay(`Current: ${formatValue(selected)}${emptyNote}`, contentW),
            style: { fg: '#38bdf8', dim: true },
          });
        }
      }
    }

    const hints = modal.editingMode
      ? ['[Enter] Confirm', '[Esc] Cancel']
      : ['[Tab] Category', '[\u2191\u2193] Navigate', '[Enter] Toggle / Edit', '[Esc] Close'];

    return ModalFactory.createModal(
      {
        title: 'Settings',
        width: boxW,
        margin: boxMargin,
        targetContentRows,
        tabs: SETTINGS_CATEGORIES.map((category, index) => ({
          label: CATEGORY_LABELS[category],
          active: index === modal.categoryIndex,
        })),
        sections,
        hints,
        helpers: persistentHelpers,
      },
      width,
    );
  }

  // ── Settings list ────────────────────────────────────────────
  const items = modal.currentItems;

  if (items.length === 0) {
    sections.push({
      type: 'text',
      content: '(no settings in this category)',
      style: { fg: '240', dim: true },
    });
  } else {
    const keyW = Math.floor(contentW * 0.45);
    const valW = Math.floor(contentW * 0.18);
    const srcW = Math.floor(contentW * 0.14);

    // Column header
    const keyHdr = fitDisplay('Setting', keyW);
    const valHdr = fitDisplay('Value', valW);
    const srcHdr = fitDisplay('Source', srcW);
    const defHdr = 'Default';
    sections.push({
      type: 'text',
      content: `${keyHdr}  ${valHdr}  ${srcHdr}  ${defHdr}`,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    const isDangerCategory = modal.currentCategory === 'danger';
    const window = getVisibleWindow(items.length, modal.selectedIndex, maxVisibleRows);
    const visibleSettings = items.slice(window.start, window.end);
    const listItems: import('./modal-factory.ts').ModalListItem[] = visibleSettings.map((entry, idx) => {
      const isSelected = window.start + idx === modal.selectedIndex;

      // If this is selected and editing, show edit buffer
      const isEditing = isSelected && modal.editingMode;
      const valueStr = isEditing
        ? modal.editBuffer + '\u2588'
        : formatValue(entry);

      const keyStr = fitDisplay(getSettingLabel(entry), keyW);
      const valStr = fitDisplay(valueStr, valW);
      const sourceText = `${entry.effectiveSource ?? 'default'}${entry.locked ? '!' : entry.conflict ? '?' : ''}`;
      const srcStr = fitDisplay(sourceText, srcW);
      const defStr = String(entry.setting.default);

      const label = `${keyStr}  ${valStr}  ${srcStr}  ${defStr}`;

      return {
        label,
        selected: isSelected,
        style: isSelected ? undefined : { fg: isDangerCategory ? '#ef4444' : valueColor(entry) },
      };
    });

    sections.push({ type: 'list', items: listItems });
    if (items.length > maxVisibleRows) {
      sections.push({
        type: 'text',
        content: `[${window.start + 1}-${window.end} of ${items.length}]`,
        style: { fg: '244', dim: true },
      });
    }

    // Description of selected item
    const selected = modal.getSelected();
    if (selected) {
      sections.push({ type: 'separator' });
      const desc = selected.setting.description;
      const truncated = truncateDisplay(desc, contentW);
      sections.push({
        type: 'text',
        content: truncated,
        style: { fg: '246', dim: true },
      });
      if (
        selected.setting.key === 'ui.systemMessages'
        || selected.setting.key === 'ui.operationalMessages'
        || selected.setting.key === 'ui.wrfcMessages'
      ) {
        sections.push({
          type: 'text',
          content: truncateDisplay(`Current route: ${describeUiRouting(String(selected.currentValue))}.`, contentW),
          style: { fg: '#38bdf8', dim: true },
        });
      }
      const provenanceParts = [
        `Source: ${selected.effectiveSource ?? 'default'}`,
        selected.locked ? 'locked' : null,
        selected.conflict ? 'conflict' : null,
      ].filter(Boolean);
      sections.push({
        type: 'text',
        content: truncateDisplay(provenanceParts.join(' · '), contentW),
        style: { fg: selected.locked ? '#eab308' : selected.conflict ? '#ef4444' : '244', dim: true },
      });
      if (selected.sourceLabel) {
        sections.push({
          type: 'text',
          content: truncateDisplay(`Layer: ${selected.sourceLabel}`, contentW),
          style: { fg: '244', dim: true },
        });
      }
      if (selected.lockReason) {
        sections.push({
          type: 'text',
          content: truncateDisplay(`Lock: ${selected.lockReason}`, contentW),
          style: { fg: '#eab308', dim: true },
        });
      }
      if (selected.conflict) {
        const helper = `Repair: /settingssync resolve ${selected.setting.key} local|synced`;
        sections.push({
          type: 'text',
          content: truncateDisplay(helper, contentW),
          style: { fg: '#ef4444', dim: true },
        });
        persistentHelpers = [{ content: truncateDisplay(helper, contentW), accent: true }];
      } else if (selected.effectiveSource === 'managed') {
        const helper = 'Review: /managed staged  Apply or rollback managed changes from the control plane.';
        sections.push({
          type: 'text',
          content: truncateDisplay(helper, contentW),
          style: { fg: '#eab308', dim: true },
        });
        persistentHelpers = [{ content: truncateDisplay(helper, contentW), accent: true }];
      } else if (selected.effectiveSource === 'synced') {
        const helper = `Review: /settingssync show ${selected.setting.key}  Inspect synced provenance and fallback state.`;
        sections.push({
          type: 'text',
          content: truncateDisplay(helper, contentW),
          style: { fg: '#38bdf8', dim: true },
        });
        persistentHelpers = [{ content: truncateDisplay(helper, contentW), accent: true }];
      }
      // Show enum options if applicable
      if (selected.setting.type === 'enum' && selected.setting.enumValues) {
        const opts = selected.setting.enumValues.join(' | ');
        const optStr = selected.setting.key === 'ui.systemMessages'
          || selected.setting.key === 'ui.operationalMessages'
          || selected.setting.key === 'ui.wrfcMessages'
          ? 'Options: panel | conversation | both'
          : `Options: ${opts}`;
        sections.push({
          type: 'text',
          content: truncateDisplay(optStr, contentW),
          style: { fg: '240', dim: true },
        });
      }
    }
  }

  const hints = modal.editingMode
    ? ['[Enter] Confirm', '[Esc] Cancel']
    : ['[Tab] Category', '[\u2191\u2193] Navigate', '[←/→] Adjust', '[Enter] Toggle / Edit', '[Esc] Close'];

  return ModalFactory.createModal(
    {
      title: 'Settings',
      width: boxW,
      margin: boxMargin,
      targetContentRows,
      tabs: SETTINGS_CATEGORIES.map((category, index) => ({
        label: CATEGORY_LABELS[category],
        active: index === modal.categoryIndex,
      })),
      sections,
      hints,
    },
    width,
  );
}
