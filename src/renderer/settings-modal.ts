/**
 * Fullscreen configuration workspace.
 *
 * This intentionally does not use ModalFactory. Configuration needs a stable,
 * roomy workspace with contextual documentation, not a cramped modal list.
 */

import type { Line } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import type { SettingsModal, SettingEntry, FlagEntry, McpEntry, SubscriptionEntry, SettingsCategory } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES } from '../input/settings-modal.ts';
import { getDisplayWidth, wrapText } from '../utils/terminal-width.ts';
import { CATEGORY_LABELS, describeUiRouting, formatValue, getSettingLabel, inferSubscriptionRouteReason, valueColor } from './settings-modal-helpers.ts';
import { isSecretConfigKey } from '../config/secret-config.ts';
import { GLYPHS, UI_TONES } from './ui-primitives.ts';

const PALETTE = {
  border: '#64748b',
  title: '#67e8f9',
  subtitle: '#93c5fd',
  text: '#e2e8f0',
  muted: '#94a3b8',
  dim: '#64748b',
  selectedBg: '#223049',
  categoryBg: '#141b25',
  contextBg: '#121923',
  controlsBg: '#0f141d',
  footerBg: '#111827',
  good: UI_TONES.state.good,
  warn: UI_TONES.state.warn,
  bad: UI_TONES.state.bad,
  info: UI_TONES.state.info,
};

const CATEGORY_INFO: Record<SettingsCategory, string> = {
  display: 'Presentation settings for the terminal transcript: streaming, line numbers, thinking visibility, reasoning summaries, token speed, and tool previews.',
  ui: 'Controls where operational messages render and whether voice surfaces are enabled. These settings change visibility, not provider behavior.',
  provider: 'Default model routing for normal chat turns, embeddings, reasoning effort, and persistent system prompt file.',
  subscriptions: 'Provider subscription login state and routing posture. Active sessions can be reviewed or signed out here; API keys remain managed through secrets.',
  behavior: 'Day-to-day shell behavior: approval posture, compaction, history, guidance, notifications, stale-context warnings, return context, and Human-in-the-Loop mode.',
  storage: 'Local storage posture, including secret storage policy and maximum artifact size for knowledge/home graph/document ingestion.',
  permissions: 'Permission mode and tool-class policy. These settings decide whether the shell prompts before read/write/exec/network/agent actions.',
  orchestration: 'Agent orchestration limits and recursion controls.',
  wrfc: 'Work-review-fix-cycle thresholds, retry limits, and automatic commit behavior.',
  helper: 'Helper model defaults used by helper subsystems when they do not use the main chat route.',
  tts: 'Text-to-speech provider, voice, and optional spoken-turn LLM overrides.',
  service: 'Background service posture: enabled state, autostart, restart behavior, service name, platform, and logs.',
  controlPlane: 'Daemon control-plane settings for local admin/API access.',
  httpListener: 'HTTP listener settings for webhook and integration ingress.',
  web: 'Browser surface settings for the local or network web UI.',
  batch: 'Batch execution settings, including local vs Cloudflare queue behavior.',
  automation: 'Scheduled and automated run settings, concurrency, timeout, catch-up, cooldown, and retention behavior.',
  watchers: 'File/process watcher heartbeat, polling, and recovery-window behavior.',
  runtime: 'Runtime guardrails such as companion chat limiter and event bus listener caps.',
  telemetry: 'Telemetry payload policy.',
  cache: 'Provider and model cache behavior, TTL, and hit-rate monitoring.',
  mcp: 'MCP server trust and scope review. Trust changes can expose local files, tools, databases, browsers, or remote automation depending on the server.',
  sandbox: 'Isolation strategy for REPL, MCP, Windows, and QEMU-backed execution. Use these settings to separate risky tools from the host shell.',
  surfaces: 'External app surfaces such as Slack, Discord, ntfy, Home Assistant, Telegram, webhooks, chat bridges, and messaging providers.',
  cloudflare: 'Optional Cloudflare control plane, batch queue, Worker, Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 settings.',
  release: 'Release-channel preference.',
  danger: 'High-impact switches for daemon and HTTP listener behavior. These are operational overrides, not normal preferences.',
  tools: 'Tool LLM and helper model routing. Empty provider/model values inherit the active chat route unless a specific helper/tool route is set.',
  flags: 'Feature flags are SDK runtime gates. They are separate from normal config keys because they enable or disable staged runtime behavior.',
  network: 'Combined network view for daemon control-plane, HTTP listener, browser web surface, and general outbound network settings.',
};

const ENUM_VALUE_DESCRIPTIONS: Record<string, Record<string, string>> = {
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
    prompt: 'Ask before powerful or risky actions according to tool policy.',
    'allow-all': 'Allow actions without prompting. This is fast but removes an important safety gate.',
    custom: 'Use per-tool-class permission settings from the rows below.',
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function fillRange(line: Line, startX: number, endX: number, bg: string): void {
  for (let x = Math.max(0, startX); x <= Math.min(line.length - 1, endX); x += 1) {
    const cell = line[x] ?? createStyledCell(' ');
    line[x] = createStyledCell(cell.char, {
      fg: cell.fg,
      bg,
      bold: cell.bold,
      dim: cell.dim,
      underline: cell.underline,
      italic: cell.italic,
      strikethrough: cell.strikethrough,
      link: cell.link,
    });
  }
}

function writeText(line: Line, startX: number, maxWidth: number, text: string, style: Partial<Omit<Line[number], 'char'>> = {}): void {
  let x = startX;
  let used = 0;
  for (const ch of text) {
    const width = getDisplayWidth(ch);
    if (width <= 0) continue;
    if (used + width > maxWidth || x >= line.length) break;
    line[x] = createStyledCell(ch, style);
    if (width > 1 && x + 1 < line.length) {
      line[x + 1] = createStyledCell(' ', style);
    }
    x += width;
    used += width;
  }
}

function makeLine(width: number, bg = ''): Line {
  const line = createEmptyLine(width);
  if (bg) fillRange(line, 0, width - 1, bg);
  return line;
}

function borderLine(width: number, left: string, fill: string, right: string): Line {
  const line = makeLine(width);
  if (width <= 0) return line;
  line[0] = createStyledCell(left, { fg: PALETTE.border });
  for (let x = 1; x < width - 1; x += 1) {
    line[x] = createStyledCell(fill, { fg: PALETTE.border });
  }
  if (width > 1) line[width - 1] = createStyledCell(right, { fg: PALETTE.border });
  return line;
}

function contentLine(width: number, bg: string): Line {
  const line = makeLine(width, bg);
  if (width > 0) line[0] = createStyledCell(GLYPHS.frame.vertical, { fg: PALETTE.border });
  if (width > 1) line[width - 1] = createStyledCell(GLYPHS.frame.vertical, { fg: PALETTE.border });
  return line;
}

function drawVertical(line: Line, x: number, bg = ''): void {
  if (x <= 0 || x >= line.length - 1) return;
  line[x] = createStyledCell(GLYPHS.frame.vertical, { fg: PALETTE.border, bg });
}

function drawHorizontalRange(line: Line, startX: number, endX: number, bg = ''): void {
  for (let x = Math.max(1, startX); x <= Math.min(line.length - 2, endX); x += 1) {
    line[x] = createStyledCell(GLYPHS.frame.horizontal, { fg: PALETTE.border, bg });
  }
}

function paddedWrapped(text: string, width: number, prefix = ''): string[] {
  const safeWidth = Math.max(1, width - getDisplayWidth(prefix));
  const wrapped = wrapText(text, safeWidth);
  if (prefix.length === 0) return wrapped;
  return wrapped.map((line, index) => `${index === 0 ? prefix : ' '.repeat(getDisplayWidth(prefix))}${line}`);
}

function clipDisplay(text: string, width: number): string {
  if (width <= 0) return '';
  let used = 0;
  let output = '';
  for (const ch of text) {
    const chWidth = getDisplayWidth(ch);
    if (chWidth <= 0) continue;
    if (used + chWidth > width) break;
    output += ch;
    used += chWidth;
  }
  return output;
}

function padDisplay(text: string, width: number): string {
  const clipped = clipDisplay(text, width);
  return `${clipped}${' '.repeat(Math.max(0, width - getDisplayWidth(clipped)))}`;
}

function stableWindow(total: number, selectedIndex: number, visibleCount: number): { start: number; end: number } {
  if (total <= 0 || visibleCount <= 0) return { start: 0, end: 0 };
  if (total <= visibleCount) return { start: 0, end: total };
  const selected = clamp(selectedIndex, 0, total - 1);
  const half = Math.floor(visibleCount / 2);
  const start = clamp(selected - half, 0, total - visibleCount);
  return { start, end: start + visibleCount };
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
  if (entry.conflict) lines.push(`Conflict: resolve with /settingssync resolve ${entry.setting.key} local|synced.`);

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

function buildFlagContext(entry: FlagEntry | null): string[] {
  if (!entry) return ['Feature flags', 'No feature flag is selected.'];
  return [
    entry.flag.name,
    `ID: ${entry.flag.id}`,
    `State: ${entry.state}`,
    `Default: ${entry.flag.defaultState}`,
    `Tier: ${entry.flag.tier}`,
    `Runtime toggleable: ${entry.flag.runtimeToggleable ? 'yes' : 'no'}`,
    '',
    entry.flag.description,
    ...(entry.state === 'killed' && entry.flag.killReason ? ['', `Kill reason: ${entry.flag.killReason}`] : []),
    '',
    entry.flag.runtimeToggleable
      ? 'Impact: changes apply immediately and are also persisted as an override when they differ from the default.'
      : 'Impact: this flag is persisted as an override and requires restart before startup-only code sees the new state.',
  ];
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
      ? `Press Enter again to sign out ${entry.provider}. Move selection or close config to cancel.`
      : 'Press Enter to review sign-out for this provider session.'
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
  const lines: string[] = [
    `${CATEGORY_LABELS[category]} configuration`,
  ];

  if (category === 'flags') {
    lines.push(...buildFlagContext(modal.getSelectedFlag()));
  } else if (category === 'mcp') {
    lines.push(...buildMcpContext(modal, modal.getSelectedMcp()));
  } else if (category === 'subscriptions') {
    lines.push(...buildSubscriptionContext(modal, modal.getSelectedSubscription()));
  } else {
    const selected = modal.getSelected();
    if (selected) lines.push(...buildSettingContext(modal, selected));
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
  if (category === 'flags') return modal.flagEntries.length;
  if (category === 'mcp') return modal.mcpEntries.length;
  if (category === 'subscriptions') return modal.subscriptionEntries.length;
  return modal.groups.get(category)?.length ?? 0;
}

function renderCategories(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const window = stableWindow(SETTINGS_CATEGORIES.length, modal.categoryIndex, height);
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more categor${window.start === 1 ? 'y' : 'ies'} above`);
  for (let index = window.start; index < window.end; index += 1) {
    const category = SETTINGS_CATEGORIES[index]!;
    const active = index === modal.categoryIndex;
    const count = categoryItemCount(modal, category);
    const cursor = active ? (modal.focusPane === 'categories' ? GLYPHS.navigation.selected : '•') : ' ';
    rows.push(`${cursor} ${CATEGORY_LABELS[category]} (${count})`);
  }
  if (window.end < SETTINGS_CATEGORIES.length) rows.push(`${GLYPHS.navigation.moreBelow} ${SETTINGS_CATEGORIES.length - window.end} more categor${SETTINGS_CATEGORIES.length - window.end === 1 ? 'y' : 'ies'} below`);
  while (rows.length < height) rows.push('');
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
    const value = currentSettingValue(modal, entry, selected);
    const source = `${entry.effectiveSource ?? 'default'}${entry.locked ? ' locked' : ''}${entry.conflict ? ' conflict' : ''}`;
    const label = getSettingLabel(entry);
    rows.push(`${marker} ${padDisplay(label, keyWidth)}  ${padDisplay(value, valueWidth)}  ${padDisplay(entry.setting.type, typeWidth)}  ${padDisplay(source, sourceWidth)}  ${padDisplay(formatDefaultValue(entry.setting.default), defaultWidth)}`);
  }

  if (window.end < items.length) rows.push(`${GLYPHS.navigation.moreBelow} ${items.length - window.end} more setting(s) below`);
  return rows.slice(0, height);
}

function renderFlagRows(modal: SettingsModal, width: number, height: number): string[] {
  const rows: string[] = [];
  const items = modal.flagEntries;
  if (items.length === 0) return ['No feature flags registered.'];
  const selectedIndex = clamp(modal.selectedIndex, 0, items.length - 1);
  const nameWidth = clamp(Math.floor(width * 0.40), 24, 58);
  const stateWidth = 10;
  const tierWidth = 6;
  const runtimeWidth = 9;
  const defaultWidth = 9;
  const idWidth = Math.max(12, width - nameWidth - stateWidth - tierWidth - runtimeWidth - defaultWidth - 14);
  rows.push(`  ${padDisplay('Feature Flag', nameWidth)}  ${padDisplay('State', stateWidth)}  ${padDisplay('Tier', tierWidth)}  ${padDisplay('Runtime', runtimeWidth)}  ${padDisplay('Default', defaultWidth)}  ${padDisplay('ID', idWidth)}`);
  const visibleCount = Math.max(1, height - 2);
  const window = stableWindow(items.length, selectedIndex, visibleCount);
  if (window.start > 0) rows.push(`${GLYPHS.navigation.moreAbove} ${window.start} more flag(s) above`);
  for (let index = window.start; index < window.end; index += 1) {
    const entry = items[index]!;
    const selected = index === selectedIndex;
    const marker = selected ? (modal.focusPane === 'settings' ? GLYPHS.navigation.selected : '•') : ' ';
    rows.push(`${marker} ${padDisplay(entry.flag.name, nameWidth)}  ${padDisplay(entry.state, stateWidth)}  ${padDisplay(String(entry.flag.tier), tierWidth)}  ${padDisplay(entry.flag.runtimeToggleable ? 'yes' : 'restart', runtimeWidth)}  ${padDisplay(entry.flag.defaultState, defaultWidth)}  ${padDisplay(entry.flag.id, idWidth)}`);
  }
  if (window.end < items.length) rows.push(`${GLYPHS.navigation.moreBelow} ${items.length - window.end} more flag(s) below`);
  return rows.slice(0, height);
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

function renderControlRows(modal: SettingsModal, width: number, height: number): string[] {
  if (modal.currentCategory === 'flags') return renderFlagRows(modal, width, height);
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

function footerText(modal: SettingsModal): string {
  if (modal.editingMode) return 'Enter Confirm edit · Esc Cancel edit · text keys edit the selected field';
  if (modal.focusPane === 'categories') return 'Focus categories · Up/Down choose · Right/Enter settings · Tab pane · Esc close';
  if (modal.currentCategory === 'subscriptions') return 'Focus settings · Up/Down provider · Left categories · Tab pane · Enter review/sign out · Esc close';
  if (modal.currentCategory === 'mcp') return 'Focus settings · Up/Down server · Left categories · Tab pane · Enter edit trust · Esc close';
  if (modal.currentCategory === 'flags') return 'Focus feature flags · Up/Down flag · Left categories · Tab pane · Enter/Space toggle · Esc close';
  return 'Focus settings · Up/Down setting · Left categories · Tab pane · Enter/Space edit/toggle · R reset · Esc close';
}

export function renderSettingsModal(
  modal: SettingsModal,
  width: number,
  viewportHeight = 24,
): Line[] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(12, viewportHeight);
  const lines: Line[] = [];
  const leftWidth = safeWidth < 80
    ? clamp(Math.round(safeWidth * 0.32), 14, Math.max(14, safeWidth - 24))
    : clamp(Math.round(safeWidth * 0.22), 24, 34);
  const centerWidth = Math.max(20, safeWidth - leftWidth - 3);
  const leftStart = 1;
  const dividerX = leftWidth + 1;
  const centerStart = dividerX + 1;
  const centerEnd = safeWidth - 2;
  const bodyTop = 3;
  const footerY = safeHeight - 2;
  const bodyRows = Math.max(4, footerY - bodyTop);
  const contextWidth = Math.max(10, centerWidth - 2);
  const contextLines = buildContextLines(modal, contextWidth);
  const maxContextRows = Math.max(3, bodyRows - 4);
  const contextRows = clamp(Math.round(bodyRows * 0.4), Math.min(10, maxContextRows), maxContextRows);
  const controlsRows = Math.max(3, bodyRows - contextRows - 1);
  const separatorY = bodyTop + contextRows;

  const top = borderLine(safeWidth, GLYPHS.frame.topLeft, GLYPHS.frame.horizontal, GLYPHS.frame.topRight);
  writeText(top, 2, safeWidth - 4, ` Configuration Workspace / Settings `, { fg: PALETTE.title, bold: true });
  lines.push(top);

  const header = contentLine(safeWidth, PALETTE.footerBg);
  drawVertical(header, dividerX, PALETTE.footerBg);
  writeText(header, leftStart + 1, leftWidth - 2, 'Categories', { fg: PALETTE.subtitle, bold: true, bg: PALETTE.footerBg });
  const headerText = `${CATEGORY_LABELS[modal.currentCategory]} (${categoryItemCount(modal, modal.currentCategory)})${modal.lastSaveTriggeredRestart ? ` · Restarting ${modal.lastSaveTriggeredRestart}` : ''}`;
  writeText(header, centerStart + 1, centerWidth - 2, headerText, { fg: PALETTE.subtitle, bold: true, bg: PALETTE.footerBg });
  lines.push(header);

  const headerSep = contentLine(safeWidth, '');
  drawVertical(headerSep, dividerX);
  drawHorizontalRange(headerSep, 1, safeWidth - 2);
  lines.push(headerSep);

  const categoryRows = renderCategories(modal, leftWidth - 2, bodyRows);
  const controlRows = renderControlRows(modal, contextWidth, controlsRows);

  for (let row = 0; row < bodyRows; row += 1) {
    const y = bodyTop + row;
    const inContext = y < separatorY;
    const inSeparator = y === separatorY;
    const bg = inSeparator ? '' : inContext ? PALETTE.contextBg : PALETTE.controlsBg;
    const line = contentLine(safeWidth, bg);
    fillRange(line, 1, dividerX - 1, PALETTE.categoryBg);
    drawVertical(line, dividerX, bg);

    const categoryText = categoryRows[row] ?? '';
    const categoryActive = categoryText.startsWith(GLYPHS.navigation.selected) || categoryText.startsWith('•');
    if (categoryText.startsWith(GLYPHS.navigation.selected)) fillRange(line, leftStart, dividerX - 1, PALETTE.selectedBg);
    writeText(line, leftStart + 1, leftWidth - 3, categoryText, {
      fg: categoryActive ? PALETTE.text : PALETTE.muted,
      bg: categoryText.startsWith(GLYPHS.navigation.selected) ? PALETTE.selectedBg : PALETTE.categoryBg,
      bold: categoryActive,
    });

    if (inSeparator) {
      drawHorizontalRange(line, centerStart, centerEnd);
    } else if (inContext) {
      const contextText = contextLines[row] ?? '';
      const selectedSetting = modal.getSelected();
      const isTitle = row === 0 || (selectedSetting !== null && contextText === getSettingLabel(selectedSetting));
      writeText(line, centerStart + 1, contextWidth, contextText, {
        fg: row === 0 ? PALETTE.title : contextText.endsWith(':') ? PALETTE.subtitle : PALETTE.text,
        bg,
        bold: isTitle,
        dim: contextText.length === 0,
      });
    } else {
      const controlText = controlRows[row - contextRows - 1] ?? '';
      const selected = controlText.startsWith(GLYPHS.navigation.selected);
      if (selected) fillRange(line, centerStart, centerEnd, PALETTE.selectedBg);
      writeText(line, centerStart + 1, contextWidth, controlText, {
        fg: selected ? PALETTE.text : controlText.startsWith('value:') || controlText.trimStart().startsWith('value:') ? PALETTE.info : rowColorForSetting(modal, controlText),
        bg: selected ? PALETTE.selectedBg : bg,
        bold: selected,
        dim: controlText.length === 0,
      });
    }
    lines.push(line);
  }

  const footer = contentLine(safeWidth, PALETTE.footerBg);
  writeText(footer, 2, safeWidth - 4, footerText(modal), { fg: PALETTE.muted, bg: PALETTE.footerBg });
  lines.push(footer);
  const bottom = borderLine(safeWidth, GLYPHS.frame.bottomLeft, GLYPHS.frame.horizontal, GLYPHS.frame.bottomRight);
  lines.push(bottom);

  while (lines.length < safeHeight) lines.unshift(makeLine(safeWidth));
  return lines.slice(-safeHeight);
}
