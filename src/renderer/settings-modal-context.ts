/**
 * settings-modal-context.ts, the documentation the settings modal shows for
 * its selected row: every setting's key, current and default value, type,
 * source, lock and conflict state, description, possible values (with the
 * per-value meaning for enums), editing notes, and the full feature-unit,
 * MCP-trust, subscription and connection documentation. Split out of
 * settings-modal.ts for the 800-line file cap. Pure text; the renderer wraps
 * and styles it.
 */

import type { SettingsModal, SettingEntry, McpEntry, SubscriptionEntry, SettingsCategory } from '../input/settings-modal.ts';
import { FEATURE_SETTINGS_BY_ID, isFeatureValueEnabled } from '@pellux/goodvibes-terminal-shell';
import { CATEGORY_INFO, describeUiRouting, formatValue, getSettingLabel, inferSubscriptionRouteReason } from './settings-modal-helpers.ts';
import { buildConnectionContext } from './settings-modal-connections.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { maskConcealedText } from '../input/concealed-input.ts';
import { CVV_PROMPT_TRADEOFF_WARNING } from '@pellux/goodvibes-sdk/platform/payments';
import { GLYPHS } from './ui-primitives.ts';

const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'display.themeMode': {
    auto: 'Probe the terminal background colour (OSC 11) once at startup and pick light or dark. Falls back to dark on unreadable/unsupported terminals. Only evaluated at startup: selecting auto takes effect next launch.',
    dark: 'Force the dark theme regardless of terminal background. Applies immediately.',
    light: 'Force the light theme regardless of terminal background. Applies immediately.',
  },
  'behavior.hitlMode': {
    quiet: 'Minimize operational interruptions and surface fewer Human-in-the-Loop prompts.',
    balanced: 'Show important Human-in-the-Loop prompts without turning routine work into noise.',
    operator: 'Surface more operational detail for users actively supervising agents, tools, services, and automation.',
  },
  'behavior.guidanceMode': {
    off: 'Do not add extra guidance beyond direct command output.',
    minimal: 'Show concise guidance only when it helps avoid mistakes.',
    guided: 'Provide more explanation and next-step context during configuration and operations.',
  },
  'permissions.mode': {
    prompt: 'Normal: ask before powerful or risky actions according to tool policy.',
    plan: 'Plan mode: read-only planning posture; writes, commands, and network calls are blocked so the model can plan without changing anything. Toggle with /plan or Shift+Tab.',
    'accept-edits': 'Accept edits: file writes and edits are auto-approved, but exec, network, and escalations are still gated.',
    'allow-all': 'Auto: allow all actions without prompting. Fast, but removes an important safety gate.',
    custom: 'Use per-tool-class permission settings from the rows below.',
  },
  'permissions.backgroundAgents': {
    inherit: 'Background and subagent tool calls run through the SAME session permission mode as foreground work.',
    'allow-all': 'Background and subagent tool calls are exempt from prompting (auto-approved) even when foreground work is gated.',
  },
  'diagnostics.postEdit': {
    on: 'After the model edits or writes a file, run language diagnostics on it and surface any new problems.',
    off: 'Do not run diagnostics automatically after edits.',
  },
  'storage.secretPolicy': {
    preferred_secure: 'Use secure secret storage when available, with supported fallback behavior.',
    require_secure: 'Require secure secret storage and reject plaintext fallback.',
    plaintext_allowed: 'Allow plaintext fallback when secure storage is unavailable.',
  },
  'batch.mode': {
    off: 'Keep daemon work on the immediate local path.',
    explicit: 'Use batch only when callers explicitly request batch execution.',
    'eligible-by-default': 'Allow eligible daemon work to use the batch path unless callers opt out.',
  },
  'controlPlane.hostMode': {
    localhost: 'Bind only to this computer.',
    network: 'Bind for LAN access using the default network host.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'httpListener.hostMode': {
    localhost: 'Bind only to this computer.',
    network: 'Bind for LAN/webhook access using the default network host.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'web.hostMode': {
    localhost: 'Serve the browser UI only on this computer.',
    network: 'Serve the browser UI on the LAN.',
    custom: 'Use the explicit host value in the related host setting.',
  },
  'ui.systemMessages': {
    panel: 'Show system messages in panels only.',
    conversation: 'Show system messages inline in the transcript.',
    both: 'Show system messages in both panels and the transcript.',
  },
  'ui.operationalMessages': {
    panel: 'Show operational messages in panels only.',
    conversation: 'Show operational messages inline in the transcript.',
    both: 'Show operational messages in both panels and the transcript.',
  },
  'ui.wrfcMessages': {
    panel: 'Show WRFC messages in panels only.',
    conversation: 'Show WRFC messages inline in the transcript.',
    both: 'Show WRFC messages in both panels and the transcript.',
  },
  'surfaces.telegram.mode': {
    webhook: 'Receive Telegram updates through webhook delivery.',
    polling: 'Poll Telegram for updates from the service.',
  },
  'surfaces.whatsapp.provider': {
    'meta-cloud': 'Use Meta Cloud API credentials and identifiers.',
    bridge: 'Use a bridge service URL/token flow instead of direct Meta Cloud API delivery.',
  },
  'payments.cvvHandling': {
    stored: 'Store the CVV through the secret manager so the daemon can complete a purchase unattended.',
    prompt: CVV_PROMPT_TRADEOFF_WARNING,
  },
};

function formatDefaultValue(value: unknown): string {
  if (value === '') return '(empty)';
  if (value === null || value === undefined) return '(unset)';
  return String(value);
}

export function currentSettingValue(modal: SettingsModal, entry: SettingEntry, selected: boolean): string {
  if (selected && modal.editingMode) {
    // Secret-backed keys (surfaces.*.botToken, .signingSecret, etc., see
    // secret-config.ts) must never echo the in-progress plaintext buffer:
    // not in the row, not in the "Current: ..." context line, not in search
    // results. Reuse the composer's concealed-input mask (concealed-input.ts)
    // rather than a second masking implementation, same bullet-per-character
    // shape, so keystrokes still visibly register without revealing content.
    const buffer = isSecretConfigKey(entry.setting.key) ? maskConcealedText(modal.editBuffer) : modal.editBuffer;
    return `${buffer}${GLYPHS.surface.cursor}`;
  }
  return formatValue(entry);
}

function buildSettingContext(modal: SettingsModal, entry: SettingEntry): string[] {
  const lines: string[] = [
    getSettingLabel(entry),
    `Key: ${entry.setting.key}`,
    `Current: ${currentSettingValue(modal, entry, true)}`,
    `Default: ${formatDefaultValue(entry.setting.default)}`,
    `Type: ${entry.setting.type}${entry.setting.enumValues ? ` with ${entry.setting.enumValues.length} possible value(s)` : ''}`,
    `Source: ${entry.effectiveSource ?? 'default'}${entry.sourceLabel ? ` from ${entry.sourceLabel}` : ''}`,
  ];

  if (entry.locked) lines.push(`Locked: ${entry.lockReason ?? 'This setting is locked by a higher-priority layer.'}`);
  if (entry.conflict) lines.push(`Conflict: resolve with /settings-sync resolve ${entry.setting.key} local|synced.`);

  // A settings sub-row owned by a feature unit names its feature so "what does this do" is answerable without scrolling back to the header row.
  if (entry.ownerFlagId) {
    const owner = FEATURE_SETTINGS_BY_ID.get(entry.ownerFlagId);
    if (owner) lines.push(`Part of feature: ${owner.name} (the header row above).`);
  }

  lines.push('', entry.setting.description);

  if (
    entry.setting.key === 'ui.systemMessages'
    || entry.setting.key === 'ui.operationalMessages'
    || entry.setting.key === 'ui.wrfcMessages'
  ) {
    lines.push(`Routing meaning: ${describeUiRouting(String(entry.currentValue))}.`);
  }

  if (entry.setting.type === 'boolean') {
    lines.push('');
    lines.push('Possible values:');
    lines.push('true: enabled or allowed for this setting.');
    lines.push('false: disabled or not allowed for this setting.');
  }

  if (entry.setting.type === 'enum' && entry.setting.enumValues) {
    lines.push('');
    lines.push('Possible values:');
    const descriptions = ENUM_VALUE_DESCRIPTIONS[entry.setting.key] ?? {};
    for (const value of entry.setting.enumValues) {
      lines.push(`${value}: ${descriptions[value] ?? `Use ${value} for this setting.`}`);
    }
  }

  if (isSecretConfigKey(entry.setting.key)) {
    lines.push('');
    lines.push('Secret handling: raw values entered here are stored through the secret manager and the config receives a goodvibes:// secret reference. Empty input clears the config value.');
  }

  if (entry.setting.type === 'number') {
    lines.push('');
    lines.push('Editing: Enter opens inline edit, then type the value and press Enter to save. Arrow keys only navigate.');
  }

  if (entry.setting.type === 'string' && !isSecretConfigKey(entry.setting.key)) {
    lines.push('');
    lines.push('Editing: Enter opens inline edit. Delete the current text to save an empty value when that is valid for the setting.');
  }

  return lines;
}

/**
 * The option shape of a feature header, rendered from the same schema the
 * write path uses: enum headers list every mode choice (marking the current
 * value and which values keep the feature active), boolean headers state the
 * two positions.
 */
function buildFeatureOptionLines(entry: SettingEntry): string[] {
  const feature = entry.flag!.feature;
  const setting = entry.setting;
  const lines: string[] = [];
  if (setting.type === 'enum' && setting.enumValues) {
    lines.push('', `Mode choices for ${setting.key}:`);
    const activeValues = feature.enablement.enabledValues ?? [];
    const descriptions = ENUM_VALUE_DESCRIPTIONS[setting.key] ?? {};
    for (const value of setting.enumValues) {
      const marks: string[] = [];
      if (value === String(entry.currentValue)) marks.push('current');
      if (feature.enablement.kind === 'enum') {
        marks.push(activeValues.includes(value) ? 'feature on' : 'feature off');
      }
      const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
      lines.push(`${value}${suffix}: ${descriptions[value] ?? `Use ${value} for this setting.`}`);
    }
  } else if (setting.type === 'boolean') {
    lines.push('');
    lines.push('Possible values:');
    lines.push('true: the feature is enabled.');
    lines.push('false: the feature is disabled.');
  }
  return lines;
}

/**
 * Under-cursor documentation for a feature-unit header, rendered entirely
 * from the SDK's per-feature settings metadata: full behavior description,
 * the real option shape, every settings key that tunes the feature, and the
 * honest live/restart state from the gate manager.
 */
function buildFlagContext(entry: SettingEntry | null): string[] {
  const flagEntry = entry?.flag ?? null;
  if (!entry || !flagEntry) return ['Features', 'No feature is selected.'];
  const { feature, flag, state, persistedState, pendingRestart } = flagEntry;
  const configOn = isFeatureValueEnabled(feature, entry.currentValue);
  const displayState = state === 'killed' ? 'killed' : configOn ? 'enabled' : 'disabled';
  const lines: string[] = [
    feature.name,
    `Feature: ${feature.id} (${feature.domain} domain)`,
    `Setting: ${feature.enablement.key} = ${formatValue(entry)}`,
    `State: ${displayState}`,
    // A capability the registry declares not operable reads as disabled no
    // matter what its settings key says. Without this line the row shows a
    // value of true beside a state of disabled and explains nothing, the
    // written reason exists in the registry, so render it where the user meets
    // the contradiction rather than leaving it to be discovered.
    ...(feature.operable === false && feature.inoperableDetail
      ? [`Not available in this build: ${feature.inoperableDetail}`]
      : []),
    `Default: ${feature.defaultEnabled ? 'enabled' : 'disabled'}`,
    `Applies: ${feature.restartRequired ? 'on next launch (startup-gated)' : 'immediately'}`,
    ...(pendingRestart
      ? [`Pending restart: saved as ${persistedState}; effective state stays ${state} until the next launch.`]
      : []),
    '',
    feature.description,
  ];

  lines.push(...buildFeatureOptionLines(entry));

  lines.push('');
  if (feature.enablement.kind === 'enum') {
    lines.push(`How it turns on: active while ${feature.enablement.key} is ${(feature.enablement.enabledValues ?? []).join(' or ')}.`);
  } else if (feature.enablement.kind === 'constant' && entry.setting.type !== 'boolean') {
    lines.push('How it turns on: always active; the settings listed below tune its behavior directly.');
  } else {
    lines.push(`How it turns on: ${feature.enablement.key} set to true.`);
  }

  if (feature.settings.length > 1) {
    lines.push('', 'Settings in this feature:');
    for (const key of feature.settings) {
      lines.push(key === feature.enablement.key ? `${key} (this row)` : key);
    }
  }

  if (state === 'killed' && flag.killReason) {
    lines.push('', `Kill reason: ${flag.killReason}`);
  }
  return lines;
}

function buildMcpContext(modal: SettingsModal, entry: McpEntry | null): string[] {
  if (!entry) return ['MCP trust', 'No MCP server is selected.'];
  const scope = entry.allowedPaths.length > 0
    ? `Allowed paths: ${entry.allowedPaths.join(', ')}`
    : entry.allowedHosts.length > 0
      ? `Allowed hosts: ${entry.allowedHosts.join(', ')}`
      : 'No explicit path or host scope is configured.';
  const confirmation = modal.mcpAllowAllConfirmationTarget === entry.name
    ? `Confirmation required: type ALLOW ALL ${entry.name} to grant unrestricted trust.`
    : 'Enter edits the trust mode. Valid values are constrained, ask-on-risk, allow-all, and blocked.';
  return [
    entry.name,
    `Connection: ${entry.connected ? 'connected' : 'disconnected'}`,
    `Role: ${entry.role}`,
    `Trust mode: ${entry.trustMode}`,
    confirmation,
    '',
    scope,
    '',
    'Trust meanings:',
    'constrained: keep MCP activity inside declared paths/hosts and prompt on risk.',
    'ask-on-risk: allow routine MCP operations but ask before risky behavior.',
    'allow-all: allow unrestricted MCP operations for this server after explicit confirmation.',
    'blocked: prevent this MCP server from being used.',
  ];
}

function buildSubscriptionContext(modal: SettingsModal, entry: SubscriptionEntry | null): string[] {
  if (!entry) return ['Subscriptions', 'No subscription provider is selected.'];
  const expires = entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'not reported';
  const routeReason = inferSubscriptionRouteReason(entry);
  const logout = entry.state === 'active' || entry.state === 'pending'
    ? modal.subscriptionLogoutConfirmationTarget === entry.provider
      ? `Sign out ${entry.provider}? Enter/y to confirm, n/Esc to cancel.`
      : 'Press Enter to begin sign-out for this provider session.'
    : `Use /subscription login ${entry.provider} start to begin OAuth sign-in for this provider.`;
  return [
    entry.provider,
    `State: ${entry.state}`,
    ...(routeReason ? [routeReason] : []),
    logout,
    `Active route: ${entry.activeRoute ?? 'n/a'}`,
    `Preferred route: ${entry.preferredRoute ?? 'n/a'}`,
    `OAuth configured: ${entry.oauthConfigured ? 'yes' : 'no'}`,
    `Freshness: ${entry.authFreshness ?? 'n/a'}`,
    `Expires: ${expires}`,
    ...((entry.issues ?? []).length > 0 ? ['', 'Issues:', ...(entry.issues ?? [])] : []),
    ...((entry.nextActions ?? []).length > 0 ? ['', 'Next actions:', ...(entry.nextActions ?? [])] : []),
  ];
}

/**
 * The documentation for whatever the settings list has selected, one entry
 * per line (unwrapped; '' separates paragraphs). The first line names the
 * selection; the renderer shows it under the selected row, wrapped in full.
 */
export function settingContextLines(modal: SettingsModal): string[] {
  const category = modal.currentCategory;
  if (modal.searchFocused) {
    const selected = modal.getSelected();
    if (selected) return buildSettingContext(modal, selected);
    return [
      modal.searchQuery.trim().length === 0
        ? 'Type a query to search across all settings categories.'
        : 'No settings matched the search query.',
    ];
  }
  const lines: string[] = [];
  if (category === 'mcp') lines.push(...buildMcpContext(modal, modal.getSelectedMcp()));
  else if (category === 'subscriptions') lines.push(...buildSubscriptionContext(modal, modal.getSelectedSubscription()));
  else if (category === 'connections') lines.push(...buildConnectionContext(modal));
  else {
    const selected = modal.getSelected();
    // A feature-unit header shows the feature's documentation (full
    // description, option shape, settings list, live/restart state); its
    // settings sub-rows and plain settings show the setting context.
    if (selected?.flag) lines.push(...buildFlagContext(selected));
    else if (selected) lines.push(...buildSettingContext(modal, selected));
    else lines.push('No setting is selected in this category.');
  }
  lines.push('', `Category purpose: ${CATEGORY_INFO[category]}`);
  return lines;
}

export function categoryItemCount(modal: SettingsModal, category: SettingsCategory): number {
  if (category === 'mcp') return modal.mcpEntries.length;
  if (category === 'subscriptions') return modal.subscriptionEntries.length;
  if (category === 'connections') return modal.connectionEntries.length;
  return modal.groups.get(category)?.length ?? 0;
}
