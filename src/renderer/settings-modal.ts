/**
 * Fullscreen configuration workspace.
 *
 * This intentionally does not use ModalFactory. Configuration needs a stable,
 * roomy workspace with contextual documentation, not a cramped modal list.
 */

import type { Line } from '../types/grid.ts';
import type { SettingsModal, SettingEntry, McpEntry, SubscriptionEntry, SettingsCategory } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../input/settings-modal.ts';
import { FEATURE_SETTINGS_BY_ID, isFeatureValueEnabled } from '../runtime/feature-settings.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { CATEGORY_LABELS, describeUiRouting, formatValue, getSettingLabel, inferSubscriptionRouteReason, valueColor } from './settings-modal-helpers.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { GLYPHS } from './ui-primitives.ts';
import { formatHints, joinHints } from './hint-grammar.ts';
import {
  clamp,
  getFullscreenWorkspaceMetrics,
  padDisplay,
  renderFullscreenWorkspace,
  stableWindow,
  WORKSPACE_PALETTE as PALETTE,
  type WorkspaceRow,
} from './fullscreen-workspace.ts';

const CATEGORY_INFO: Record<SettingsCategory, string> = {
  display: 'Presentation settings for the terminal transcript: streaming, line numbers, thinking visibility, reasoning summaries, token speed, and tool previews.',
  ui: 'Controls where operational messages render and whether voice surfaces are enabled. These settings change visibility, not provider behavior.',
  provider: 'Default model routing for normal chat turns, embeddings, reasoning effort, and persistent system prompt file.',
  subscriptions: 'Provider subscription login state and routing posture. Active sessions can be reviewed or signed out here; API keys remain managed through secrets.',
  behavior: 'Day-to-day shell behavior: approval posture, compaction, history, guidance, notifications, stale-context warnings, return context, and Human-in-the-Loop mode.',
  storage: 'Local storage posture, including secret storage policy and maximum artifact size for knowledge/home graph/document ingestion.',
  atRest: 'Data-at-rest policy for the on-disk transcript journal and execution ledger: whether secret/credential patterns are redacted at write time, and the age/size caps that trigger pruning.',
  permissions: 'Permission mode and tool-class policy. These settings decide whether the shell prompts before read/write/exec/network/agent actions.',
  orchestration: 'Agent orchestration limits and recursion controls.',
  planner: 'How /workstream decomposes a goal into work items: agent-driven decomposition (with heuristic fallback) or the forced heuristic path, plus the planning agent\'s turn, token, and wall-clock bounds.',
  wrfc: 'Work-review-fix-cycle thresholds, retry limits, and automatic commit behavior.',
  helper: 'Helper model defaults used by helper subsystems when they do not use the main chat route.',
  tts: 'Text-to-speech provider, voice, and optional spoken-turn LLM overrides.',
  service: 'Background service posture: enabled state, autostart, restart behavior, service name, platform, and logs.',
  daemon: 'Local session daemon. It hosts the shared session broker and companion chat so a session started here is visible and steerable from other surfaces. On by default, bound to loopback (127.0.0.1) only.',
  controlPlane: 'Daemon control-plane settings for local admin/API access.',
  httpListener: 'HTTP listener settings for webhook and integration ingress.',
  web: 'Browser surface settings for the local or network web UI.',
  batch: 'Batch execution settings, including local vs Cloudflare queue behavior.',
  automation: 'Scheduled and automated run settings, concurrency, timeout, catch-up, cooldown, and retention behavior.',
  checkin: 'Proactive check-in: on a cadence, a briefing is judged and you are contacted only when something warrants it. Off by default; every run — scheduled or manual — leaves a receipt (see /checkin) recording whether it stayed quiet, delivered a message, or was skipped.',
  watchers: 'File/process watcher heartbeat, polling, and recovery-window behavior.',
  runtime: 'Runtime guardrails such as companion chat limiter and event bus listener caps.',
  telemetry: 'Telemetry payload policy.',
  cache: 'Provider and model cache behavior, TTL, and hit-rate monitoring.',
  diagnostics: 'Post-edit diagnostics: whether the shell runs language diagnostics on a file after the model edits or writes it, surfacing new problems inline.',
  mcp: 'MCP server trust and scope review. Trust changes can expose local files, tools, databases, browsers, or remote automation depending on the server.',
  sandbox: 'Isolation strategy for REPL, MCP, Windows, and QEMU-backed execution. Use these settings to separate risky tools from the host shell.',
  surfaces: 'External app surfaces such as Slack, Discord, ntfy, Home Assistant, Telegram, webhooks, chat bridges, and messaging providers.',
  cloudflare: 'Optional Cloudflare control plane, batch queue, Worker, Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 settings.',
  release: 'Release-channel preference.',
  danger: 'High-impact switches for daemon and HTTP listener behavior. These are operational overrides, not normal preferences.',
  tools: 'Tool LLM and helper model routing. Empty provider/model values inherit the active chat route unless a specific helper/tool route is set.',
  network: 'Combined network view for daemon control-plane, HTTP listener, browser web surface, and general outbound network settings.',
  fetch: 'Fetch response sanitization and host trust tiers for the fetch tool: sanitize mode plus default trusted/blocked host lists. Gated by the Fetch Response Sanitization feature.',
  agents: 'Sub-agent context-window awareness and per-turn passive knowledge/code injection: token budget, relevance floor, code-chunk limit, and the compaction threshold. Gated by the agent context/injection features.',
  security: 'API token scope and rotation auditing: rotation cadence, warning lead time, and whether overdue/over-scoped tokens are blocked or only reported. Gated by the Token Scope and Rotation Audit feature.',
  integrations: 'Integration delivery reliability (Slack/Discord/webhook): retry counts, backoff bounds, dead-letter queue size, and SLO enforcement. Gated by the Integration Delivery SLO feature.',
  policy: 'Policy-as-code bundle loading: where the startup policy bundle is loaded from and its file path. Gated by the Policy-as-Code feature.',
  notifications: 'Notification router burst-suppression tuning: burst window, threshold, and cooldown. Gated by the Adaptive Notification Suppression feature.',
  relay: 'Outbound zero-knowledge relay reachability, for reaching this daemon from outside the LAN without opening an inbound port. Off by default; also gated by the relay-connect feature flag. The relay operator sees only ciphertext and connection metadata — self-host your own relay for full control.',
  learning: 'Idle-time memory consolidation: merging duplicate standing memory records and decaying/archiving stale ones. Off by default — nothing runs until enabled.',
};

const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
  'display.themeMode': {
    auto: 'Probe the terminal background colour (OSC 11) once at startup and pick light or dark. Falls back to dark on unreadable/unsupported terminals. Only evaluated at startup — selecting auto takes effect next launch.',
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
    plan: 'Plan mode: read-only planning posture — writes, commands, and network calls are blocked so the model can plan without changing anything. Toggle with /plan or Shift+Tab.',
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
};

function paddedWrapped(text: string, width: number, prefix = ''): string[] {
  const safeWidth = Math.max(1, width - getDisplayWidth(prefix));
  const wrapped = wrapText(text, safeWidth);
  if (prefix.length === 0) return wrapped;
  return wrapped.map((line, index) => `${index === 0 ? prefix : ' '.repeat(getDisplayWidth(prefix))}${line}`);
}

function formatDefaultValue(value: unknown): string {
  if (value === '') return '(empty)';
  if (value === null || value === undefined) return '(unset)';
  return String(value);
}

function currentSettingValue(modal: SettingsModal, entry: SettingEntry, selected: boolean): string {
  if (selected && modal.editingMode) return `${modal.editBuffer}${GLYPHS.surface.cursor}`;
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

  // A settings sub-row owned by a feature unit names its feature so "what
  // does this do" is answerable without scrolling back to the header row.
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

function buildContextLines(modal: SettingsModal, width: number): string[] {
  const category = modal.currentCategory;

  // Search mode: show context for the selected search result, or a help blurb
  if (modal.searchFocused) {
    const selected = modal.getSelected();
    const lines: string[] = ['Search Results'];
    if (selected) {
      lines.push(...buildSettingContext(modal, selected));
    } else {
      lines.push(
        modal.searchQuery.trim().length === 0
          ? 'Type a query to search across all settings categories.'
          : 'No settings matched the search query.',
      );
    }
    const wrapped: string[] = [];
    for (const line of lines) {
      if (line === '') { wrapped.push(''); continue; }
      wrapped.push(...paddedWrapped(line, width));
    }
    return wrapped;
  }

  const lines: string[] = [
    `${CATEGORY_LABELS[category]} configuration`,
  ];

  if (category === 'mcp') {
    lines.push(...buildMcpContext(modal, modal.getSelectedMcp()));
  } else if (category === 'subscriptions') {
    lines.push(...buildSubscriptionContext(modal, modal.getSelectedSubscription()));
  } else {
    const selected = modal.getSelected();
    // A feature-unit header shows the feature's documentation (full
    // description, option shape, settings list, live/restart state); its
    // settings sub-rows and plain settings show the setting context.
    if (selected?.flag) lines.push(...buildFlagContext(selected));
    else if (selected) lines.push(...buildSettingContext(modal, selected));
    else lines.push('No setting is selected in this category.');
  }

  lines.push('', `Category purpose: ${CATEGORY_INFO[category]}`);

  const wrapped: string[] = [];
  for (const line of lines) {
    if (line === '') {
      wrapped.push('');
      continue;
    }
    wrapped.push(...paddedWrapped(line, width));
  }
  return wrapped;
}

function categoryItemCount(modal: SettingsModal, category: SettingsCategory): number {
  if (category === 'mcp') return modal.mcpEntries.length;
  if (category === 'subscriptions') return modal.subscriptionEntries.length;
  return modal.groups.get(category)?.length ?? 0;
}

type CategoryRailEntry =
  | { readonly type: 'group'; readonly label: string }
  | { readonly type: 'category'; readonly category: SettingsCategory; readonly index: number };

type CategoryRailRow = {
  readonly text: string;
  readonly type: CategoryRailEntry['type'] | 'more' | 'empty';
  readonly selected: boolean;
};

function buildCategoryRailEntries(): CategoryRailEntry[] {
  const entries: CategoryRailEntry[] = [];
  for (const group of SETTINGS_CATEGORY_GROUPS) {
    const categories = group.categories.filter(category => SETTINGS_CATEGORIES.includes(category));
    if (categories.length === 0) continue;
    entries.push({ type: 'group', label: group.label });
    for (const category of categories) {
      entries.push({
        type: 'category',
        category,
        index: SETTINGS_CATEGORIES.indexOf(category),
      });
    }
  }
  return entries;
}

function renderCategories(modal: SettingsModal, width: number, height: number): CategoryRailRow[] {
  const rows: CategoryRailRow[] = [];
  const entries = buildCategoryRailEntries();
  const selectedEntryIndex = Math.max(0, entries.findIndex(entry => entry.type === 'category' && entry.index === modal.categoryIndex));
  const window = stableWindow(entries.length, selectedEntryIndex, height);
  if (window.start > 0) rows.push({ text: `${GLYPHS.navigation.moreAbove} ${window.start} more row(s) above`, type: 'more', selected: false });
  for (let railIndex = window.start; railIndex < window.end; railIndex += 1) {
    const entry = entries[railIndex]!;
    if (entry.type === 'group') {
      rows.push({ text: entry.label.toUpperCase(), type: 'group', selected: false });
      continue;
    }
    const category = entry.category;
    const active = entry.index === modal.categoryIndex;
    const count = categoryItemCount(modal, category);
    const cursor = active ? (modal.focusPane === 'categories' ? GLYPHS.navigation.selected : '•') : ' ';
    rows.push({ text: `  ${cursor} ${CATEGORY_LABELS[category]} (${count})`, type: 'category', selected: active });
  }
  if (window.end < entries.length) rows.push({ text: `${GLYPHS.navigation.moreBelow} ${entries.length - window.end} more row(s) below`, type: 'more', selected: false });
  while (rows.length < height) rows.push({ text: '', type: 'empty', selected: false });
  return rows.slice(0, height);
}

function renderSettingRows(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const items = modal.currentItems;
  if (items.length === 0) return ['No settings in this category.'];
  const selectedIndex = clamp(modal.selectedIndex, 0, items.length - 1);
  const typeWidth = 9;
  const sourceWidth = 12;
  const defaultWidth = 12;
  const available = Math.max(24, width - typeWidth - sourceWidth - defaultWidth - 13);
  const keyWidth = clamp(Math.floor(available * 0.56), 18, 52);
  const valueWidth = Math.max(10, available - keyWidth);
  rows.push(`  ${padDisplay('Setting', keyWidth)}  ${padDisplay('Value', valueWidth)}  ${padDisplay('Type', typeWidth)}  ${padDisplay('Source', sourceWidth)}  ${padDisplay('Default', defaultWidth)}`);
  const visibleCount = Math.max(1, height - 2);
  const window = stableWindow(items.length, selectedIndex, visibleCount);
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more setting(s) above`);

  for (let index = window.start; index < window.end; index += 1) {
    const entry = items[index]!;
    const selected = index === selectedIndex;
    const marker = selected ? (modal.focusPane === 'settings' ? GLYPHS.navigation.selected : '•') : entry.isDefault ? ' ' : '◇';
    rows.push(renderSettingTableRow(modal, entry, selected, marker, keyWidth, valueWidth, typeWidth, sourceWidth, defaultWidth));
  }

  if (window.end < items.length) rows.push(`${GLYPHS.navigation.moreBelow} ${items.length - window.end} more setting(s) below`);
  return rows.slice(0, height);
}

/**
 * One settings-table row. A feature-unit toggle header (entry.flag) shows the
 * flag name, its live state, tier/toggleability, and default state. A config
 * sub-option owned by a feature unit (entry.ownerFlagId) is indented under its
 * header. Everything else renders as a plain setting row.
 */
function renderSettingTableRow(
  modal: SettingsModal,
  entry: SettingEntry,
  selected: boolean,
  marker: string,
  keyWidth: number,
  valueWidth: number,
  typeWidth: number,
  sourceWidth: number,
  defaultWidth: number,
): string {
  if (entry.flag) {
    const { feature, state, pendingRestart } = entry.flag;
    const configOn = isFeatureValueEnabled(feature, entry.currentValue);
    const stateMark = state === 'killed' ? '✕' : configOn ? '●' : '○';
    const label = `${stateMark} ${feature.name}`;
    const source = feature.restartRequired ? 'restart' : 'live';
    // A startup-gated feature changed this session shows its saved value with
    // a restart marker, so the row never implies the change already took
    // effect; the context pane spells out the full sentence.
    const rawValue = currentSettingValue(modal, entry, selected);
    const value = pendingRestart ? `${rawValue} · restart` : rawValue;
    return `${marker} ${padDisplay(label, keyWidth)}  ${padDisplay(value, valueWidth)}  ${padDisplay('feature', typeWidth)}  ${padDisplay(source, sourceWidth)}  ${padDisplay(feature.defaultEnabled ? 'enabled' : 'disabled', defaultWidth)}`;
  }
  const value = currentSettingValue(modal, entry, selected);
  const source = `${entry.effectiveSource ?? 'default'}${entry.locked ? ' locked' : ''}${entry.conflict ? ' conflict' : ''}`;
  // Sub-options of a feature unit are indented under their toggle header so the
  // "one unit = toggle + its knobs" grouping reads at a glance.
  const label = entry.ownerFlagId ? `  · ${getSettingLabel(entry)}` : getSettingLabel(entry);
  return `${marker} ${padDisplay(label, keyWidth)}  ${padDisplay(value, valueWidth)}  ${padDisplay(entry.setting.type, typeWidth)}  ${padDisplay(source, sourceWidth)}  ${padDisplay(formatDefaultValue(entry.setting.default), defaultWidth)}`;
}

function renderMcpRows(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const items = modal.mcpEntries;
  if (items.length === 0) return ['No MCP servers registered.'];
  const selectedIndex = clamp(modal.selectedIndex, 0, items.length - 1);
  const nameWidth = clamp(Math.floor(width * 0.32), 18, 44);
  const trustWidth = 14;
  const roleWidth = 12;
  const statusWidth = 12;
  const scopeWidth = Math.max(12, width - nameWidth - trustWidth - roleWidth - statusWidth - 10);
  rows.push(`  ${padDisplay('Server', nameWidth)}  ${padDisplay('Trust', trustWidth)}  ${padDisplay('Role', roleWidth)}  ${padDisplay('Status', statusWidth)}  ${padDisplay('Scope', scopeWidth)}`);
  const window = stableWindow(items.length, selectedIndex, Math.max(1, height - 2));
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more MCP server(s) above`);
  for (let index = window.start; index < window.end; index += 1) {
    const entry = items[index]!;
    const selected = index === selectedIndex;
    const trust = selected && modal.editingMode ? `${modal.editBuffer}${GLYPHS.surface.cursor}` : entry.trustMode;
    const scope = entry.allowedPaths.length > 0 ? entry.allowedPaths.join(', ') : entry.allowedHosts.length > 0 ? entry.allowedHosts.join(', ') : 'none';
    const marker = selected ? (modal.focusPane === 'settings' ? GLYPHS.navigation.selected : '•') : ' ';
    rows.push(`${marker} ${padDisplay(entry.name, nameWidth)}  ${padDisplay(trust, trustWidth)}  ${padDisplay(entry.role, roleWidth)}  ${padDisplay(entry.connected ? 'connected' : 'offline', statusWidth)}  ${padDisplay(scope, scopeWidth)}`);
  }
  if (window.end < items.length) rows.push(`${GLYPHS.navigation.moreBelow} ${items.length - window.end} more MCP server(s) below`);
  return rows.slice(0, height);
}

function renderSubscriptionRows(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const items = modal.subscriptionEntries;
  if (items.length === 0) return ['No provider subscriptions available or configured.'];
  const selectedIndex = clamp(modal.selectedIndex, 0, items.length - 1);
  const providerWidth = clamp(Math.floor(width * 0.28), 14, 36);
  const stateWidth = 10;
  const routeWidth = 16;
  const freshnessWidth = 14;
  const oauthWidth = 8;
  const noteWidth = Math.max(12, width - providerWidth - stateWidth - routeWidth - freshnessWidth - oauthWidth - 12);
  rows.push(`  ${padDisplay('Provider', providerWidth)}  ${padDisplay('State', stateWidth)}  ${padDisplay('Route', routeWidth)}  ${padDisplay('Freshness', freshnessWidth)}  ${padDisplay('OAuth', oauthWidth)}  ${padDisplay('Note', noteWidth)}`);
  const window = stableWindow(items.length, selectedIndex, Math.max(1, height - 2));
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more subscription provider(s) above`);
  for (let index = window.start; index < window.end; index += 1) {
    const entry = items[index]!;
    const selected = index === selectedIndex;
    const marker = selected ? (modal.focusPane === 'settings' ? GLYPHS.navigation.selected : '•') : ' ';
    rows.push(`${marker} ${padDisplay(entry.provider, providerWidth)}  ${padDisplay(entry.state, stateWidth)}  ${padDisplay(entry.activeRoute ?? 'n/a', routeWidth)}  ${padDisplay(entry.authFreshness ?? 'n/a', freshnessWidth)}  ${padDisplay(entry.oauthConfigured ? 'yes' : 'no', oauthWidth)}  ${padDisplay(inferSubscriptionRouteReason(entry) ?? '', noteWidth)}`);
  }
  if (window.end < items.length) rows.push(`${GLYPHS.navigation.moreBelow} ${items.length - window.end} more subscription provider(s) below`);
  return rows.slice(0, height);
}

function renderSearchRows(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const query = modal.searchQuery;
  // Search-prompt row shows the current query
  const promptRow = `/ ${query}${GLYPHS.surface.cursor}`;
  rows.push(promptRow);

  const results = modal.searchResults;
  if (query.trim().length === 0 || results.length === 0) {
    rows.push(query.trim().length === 0 ? 'Type to search across all categories.' : 'No results.');
    return rows.slice(0, height);
  }

  const selectedIndex = clamp(modal.selectedIndex, 0, results.length - 1);
  const typeWidth = 9;
  const sourceWidth = 12;
  const categoryWidth = 14;
  const available = Math.max(24, width - typeWidth - sourceWidth - categoryWidth - 16);
  const keyWidth = clamp(Math.floor(available * 0.56), 18, 52);
  const valueWidth = Math.max(10, available - keyWidth);
  rows.push(`  ${padDisplay('Setting', keyWidth)}  ${padDisplay('Value', valueWidth)}  ${padDisplay('Type', typeWidth)}  ${padDisplay('Category', categoryWidth)}  ${padDisplay('Source', sourceWidth)}`);

  const visibleCount = Math.max(1, height - 3);
  const window = stableWindow(results.length, selectedIndex, visibleCount);
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more result(s) above`);

  for (let index = window.start; index < window.end; index += 1) {
    const entry = results[index]!;
    const selected = index === selectedIndex;
    const marker = selected ? GLYPHS.navigation.selected : entry.isDefault ? ' ' : '◇';
    const value = currentSettingValue(modal, entry, selected);
    const source = `${entry.effectiveSource ?? 'default'}${entry.locked ? ' locked' : ''}${entry.conflict ? ' conflict' : ''}`;
    const label = getSettingLabel(entry);
    // Derive category label from setting key prefix
    const keyPrefix = entry.setting.key.split('.')[0] ?? '';
    const categoryLabel = CATEGORY_LABELS[keyPrefix as SettingsCategory] ?? keyPrefix;
    rows.push(`${marker} ${padDisplay(label, keyWidth)}  ${padDisplay(value, valueWidth)}  ${padDisplay(entry.setting.type, typeWidth)}  ${padDisplay(categoryLabel, categoryWidth)}  ${padDisplay(source, sourceWidth)}`);
  }

  if (window.end < results.length) rows.push(`${GLYPHS.navigation.moreBelow} ${results.length - window.end} more result(s) below`);
  return rows.slice(0, height);
}

function renderControlRows(modal: SettingsModal, width: number, height: number): string[] {
  if (modal.searchFocused) return renderSearchRows(modal, width, height);
  if (modal.currentCategory === 'mcp') return renderMcpRows(modal, width, height);
  if (modal.currentCategory === 'subscriptions') return renderSubscriptionRows(modal, width, height);
  return renderSettingRows(modal, width, height);
}

function rowColorForSetting(modal: SettingsModal, rowText: string): string {
  if (modal.currentCategory === 'danger') return PALETTE.bad;
  if (rowText.startsWith(GLYPHS.navigation.selected)) return PALETTE.text;
  const selected = modal.getSelected();
  if (!selected) return PALETTE.text;
  return valueColor(selected);
}

function footerText(modal: SettingsModal, width: number): string {
  // Every branch speaks the shared hint grammar: bracketed [Key] Verb segments
  // joined by the middle dot, with Esc sorted last. Leading words like
  // "Focus settings" are state labels appended verbatim, not key hints.
  // Armed reset gate takes priority over all other footer states.
  if (modal.resetCategoryConfirm !== null || modal.resetAllConfirm !== null)
    return joinHints('Reset armed', formatHints([
      { key: 'Enter/y', verb: 'confirm' },
      { key: 'Esc/n', verb: 'cancel' },
    ]));
  if (modal.searchFocused)
    return joinHints('Search', 'type to filter', formatHints([
      { key: 'Up/Down', verb: 'Navigate' },
      { key: 'Enter', verb: 'Select' },
      { key: 'Esc', verb: 'Exit search' },
    ]));
  if (modal.editingMode)
    return formatHints([
      { key: 'Enter', verb: 'Confirm edit' },
      { key: 'Esc', verb: 'Cancel edit' },
    ]);
  if (modal.focusPane === 'categories')
    return joinHints('Focus categories', formatHints([
      { key: 'Up/Down', verb: 'Choose' },
      { key: 'Right/Enter', verb: 'Settings' },
      { key: 'Tab', verb: 'Pane' },
      { key: '/', verb: 'Search' },
      { key: 'Esc', verb: 'Close' },
    ]));
  if (modal.currentCategory === 'subscriptions')
    return joinHints('Focus settings', formatHints([
      { key: 'Up/Down', verb: 'Provider' },
      { key: 'Left', verb: 'Categories' },
      { key: 'Tab', verb: 'Pane' },
      { key: '/', verb: 'Search' },
      { key: 'Enter', verb: 'Review/sign out' },
      { key: 'Esc', verb: 'Close' },
    ]));
  if (modal.currentCategory === 'mcp')
    return joinHints('Focus settings', formatHints([
      { key: 'Up/Down', verb: 'Server' },
      { key: 'Left', verb: 'Categories' },
      { key: 'Tab', verb: 'Pane' },
      { key: '/', verb: 'Search' },
      { key: 'Enter', verb: 'Edit trust' },
      { key: 'Esc', verb: 'Close' },
    ]));
  // Every topical category that hosts feature units flows through the default
  // settings footer below — Enter/Space toggles a feature-unit header exactly
  // as it edits/toggles any setting row.
  // Default settings pane: tier the reset affordances by available width.
  // W<80:  minimal — only the most critical action survives.
  // W<160: compact but still shows both reset affordances.
  // W≥160: standard with all navigation tokens.
  if (width < 80)
    return formatHints([{ key: 'R', verb: 'reset' }, { key: 'Esc', verb: 'Close' }]);
  if (width < 160)
    return formatHints([
      { key: 'Up/Down', verb: 'Move' },
      { key: 'Enter/Space', verb: 'Edit' },
      { key: '⇧R', verb: 'reset cat' },
      { key: '^⇧R', verb: 'reset all' },
      { key: 'Esc', verb: 'Close' },
    ]);
  return joinHints('Focus settings', formatHints([
    { key: 'Up/Down', verb: 'Setting' },
    { key: 'Left', verb: 'Categories' },
    { key: 'Enter/Space', verb: 'Edit/toggle' },
    { key: '⇧R', verb: 'reset cat' },
    { key: '^⇧R', verb: 'reset all' },
    { key: 'Esc', verb: 'Close' },
  ]));
}

export function renderSettingsModal(
  modal: SettingsModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const notices = [
    ...(modal.lastSaveTriggeredRestart ? [`Restarting ${modal.lastSaveTriggeredRestart}`] : []),
    ...(modal.lastSettingEffectMessage ? [modal.lastSettingEffectMessage] : []),
  ];
  const metrics = getFullscreenWorkspaceMetrics({ width, height: viewportHeight });
  const categoryRows = renderCategories(modal, metrics.leftWidth - 2, metrics.bodyRows);
  const contextRows = buildContextLines(modal, metrics.contextWidth).map((text, row): WorkspaceRow => {
    const selectedSetting = modal.getSelected();
    const isTitle = row === 0 || (selectedSetting !== null && text === getSettingLabel(selectedSetting));
    return {
      text,
      fg: row === 0 ? PALETTE.title : text.endsWith(':') ? PALETTE.subtitle : PALETTE.text,
      bold: isTitle,
      dim: text.length === 0,
    };
  });
  const controlRows = renderControlRows(modal, metrics.contextWidth, metrics.controlRows).map((text): WorkspaceRow => {
    const selected = text.startsWith(GLYPHS.navigation.selected);
    return {
      text,
      selected,
      fg: selected
        ? PALETTE.text
        : text.startsWith('value:') || text.trimStart().startsWith('value:')
          ? PALETTE.info
          : rowColorForSetting(modal, text),
      bold: selected,
      dim: text.length === 0,
    };
  });

  return renderFullscreenWorkspace({
    width,
    height: viewportHeight,
    title: 'Configuration Workspace / Settings',
    leftHeader: 'Categories',
    mainHeader: modal.searchFocused
       ? `Search: ${modal.searchQuery || '…'} (${modal.searchResults.length} result${modal.searchResults.length === 1 ? '' : 's'})${notices.length > 0 ? ` · ${notices.join(' · ')}` : ''}`
       : `${CATEGORY_LABELS[modal.currentCategory]} (${categoryItemCount(modal, modal.currentCategory)})${notices.length > 0 ? ` · ${notices.join(' · ')}` : ''}`,
    leftRows: categoryRows.map((row): WorkspaceRow => ({
      text: row.text,
      selected: row.selected,
      kind: row.type === 'group' ? 'group' : row.type === 'more' ? 'more' : row.type === 'empty' ? 'empty' : 'item',
      bold: row.selected || row.type === 'group',
    })),
    contextRows,
    controlRows,
    footer: footerText(modal, width),
  });
}
