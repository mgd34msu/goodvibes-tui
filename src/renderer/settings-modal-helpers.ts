/**
 * Pure formatting, label, and color helpers for renderSettingsModal.
 * Extracted from settings-modal.ts to keep the renderer under the 800-line
 * architecture cap. No layout logic lives here.
 */

import type { SettingEntry, McpEntry, SubscriptionEntry, SettingsCategory } from '../input/settings-modal-types.ts';
import { SETTINGS_CATEGORIES } from '../input/settings-modal-types.ts';
import { isSecretConfigKey, isSecretReferenceValue } from '../config/secret-config.ts';
import { UI_TONES } from './ui-primitives.ts';

/**
 * "Modified / active" accent for settings rows — cyan-green, no UI_TONES
 * role matches it (preserved byte-exact as a named constant).
 */
const SETTINGS_ACCENT = '#00ffcc';

function maskSecretValue(value: string): string {
  if (value.length === 0) return '(empty)';
  if (isSecretReferenceValue(value)) return value;
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.slice(-4)}`;
}

export function formatValue(entry: SettingEntry): string {
  const val = entry.currentValue;
  if (val === null || val === undefined) return '(unset)';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'string' && isSecretConfigKey(entry.setting.key)) return maskSecretValue(val);
  if (typeof val === 'string' && val === '') return '(empty)';
  // Array-backed settings (e.g. worktree.setup.commands) display as a
  // comma-separated list, matching how they're edited (see worktree-setup-config.ts).
  if (Array.isArray(val)) return val.length > 0 ? val.join(', ') : '(empty)';
  // Object-backed settings (e.g. pricing.modelPrices) display their JSON when
  // short, or an honest entry count — never the useless "[object Object]".
  if (typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>);
    if (keys.length === 0) return '(none set)';
    const json = JSON.stringify(val);
    return json.length <= 64 ? json : `${keys.length} entr${keys.length === 1 ? 'y' : 'ies'} (Enter to edit as JSON)`;
  }
  return String(val);
}

export function valueColor(entry: SettingEntry): string {
  if (!entry.isDefault) return SETTINGS_ACCENT; // cyan-green = modified
  return '244';                                  // dim = default
}




export function inferSubscriptionRouteReason(entry: SubscriptionEntry): string | undefined {
  if (entry.routeReason?.trim()) return entry.routeReason;
  if (entry.state === 'active' && entry.oauthConfigured) {
    return 'ambient key override enabled for this provider.';
  }
  if (entry.state === 'pending' && entry.oauthConfigured) {
    return 'oauth configuration present; ambient key override will apply after activation.';
  }
  return undefined;
}

export const CATEGORY_INFO: Record<SettingsCategory, string> = {
  display: 'Presentation settings for the terminal transcript: streaming, line numbers, thinking visibility, reasoning summaries, token speed, and tool previews.',
  ui: 'Controls where operational messages render and whether voice surfaces are enabled. These settings change visibility, not provider behavior.',
  provider: 'Default model routing for normal chat turns, embeddings, reasoning effort, and persistent system prompt file.',
  pricing: 'Manual model prices (USD per 1M tokens, keyed provider:model). Your price wins over provider-served and catalog prices in every cost display, immediately.',
  update: 'Self-update posture: whether the daemon checks hourly and updates at an idle moment, the release source it checks, and the check cadence. Clients update at launch; every swap keeps the previous binary for one-command rollback.',
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
  voice: 'Free, offline local voice engines (voice.local.*): the STT and TTS engine, binary, and model-path for whisper.cpp/faster-whisper and Piper/Kokoro. All empty by default — configurable-not-configured, nothing auto-downloads, and an unconfigured machine reports honestly (never an error). Once set, "Local engines" appears in the TTS provider picker beside elevenlabs, with no billing dimension.',
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
  conversationGate: 'What a message arriving from one of those channels does. By default it gets a conversational answer, and work is proposed and waits for your agreement rather than starting on its own; you can instead confirm every run, or restore the old behavior where a message starts work immediately. Also how long a pending proposal stays answerable and how many can wait at once. This governs messages from channels only — what you type here always runs, and schedules and triggers were authorized when created.',
  cloudflare: 'Optional Cloudflare control plane, batch queue, Worker, Tunnel, Access, DNS, KV, Durable Objects, Secrets Store, and R2 settings.',
  release: 'Release-channel preference.',
  power: 'Host sleep ownership. Keep-awake holds the host awake (the always-visible "sleep disabled" chip is the safety mechanism — no timer, no AC-only option); automatic inhibition keeps the host awake while real work runs, with an honest hard cap on that work hold.',
  memory: 'Memory provenance surfacing. Whether turns that drew on your standing memories show a small "used N memories" chip with a drill-in listing them. Off by default — when off, nothing is rendered and no context is added.',
  danger: 'High-impact switches for daemon and HTTP listener behavior. These are operational overrides, not normal preferences.',
  tools: 'Tool LLM and helper model routing. Empty provider/model values inherit the active chat route unless a specific helper/tool route is set.',
  network: 'Combined network view for daemon control-plane, HTTP listener, browser web surface, and general outbound network settings.',
  fetch: 'Fetch response sanitization and host trust tiers for the fetch tool: sanitize mode plus default trusted/blocked host lists. Gated by the Fetch Response Sanitization feature.',
  agents: 'Sub-agent context-window awareness and per-turn passive knowledge/code injection: token budget, relevance floor, code-chunk limit, and the compaction threshold. Gated by the agent context/injection features.',
  security: 'API token scope and rotation auditing: rotation cadence, warning lead time, and whether overdue/over-scoped tokens are blocked or only reported. Gated by the Token Scope and Rotation Audit feature.',
  integrations: 'Integration delivery reliability (Slack/Discord/webhook): retry counts, backoff bounds, dead-letter queue size, and SLO enforcement. Gated by the Integration Delivery SLO feature.',
  policy: 'Policy-as-code bundle loading: where the startup policy bundle is loaded from and its file path. Gated by the Policy-as-Code feature.',
  notifications: 'Notification router burst-suppression tuning: burst window, threshold, and cooldown. Gated by the Adaptive Notification Suppression feature.',
  relay: 'Outbound zero-knowledge relay reachability, for reaching this daemon from outside the LAN without opening an inbound port. Off by default — relay.enabled is the switch. The relay operator sees only ciphertext and connection metadata — self-host your own relay for full control.',
  learning: 'Idle-time memory consolidation: merging duplicate standing memory records and decaying/archiving stale ones. Off by default — nothing runs until enabled.',
};

export const CATEGORY_LABELS: Record<(typeof SETTINGS_CATEGORIES)[number], string> = {
  display: 'Display',
  ui: 'UI',
  provider: 'Provider',
  pricing: 'Pricing',
  update: 'Updates',
  subscriptions: 'Subscriptions',
  behavior: 'Behavior',
  storage: 'Storage',
  atRest: 'Data at Rest',
  permissions: 'Permissions',
  orchestration: 'Orchestration',
  planner: 'Planner',
  wrfc: 'WRFC',
  helper: 'Helper',
  tts: 'TTS',
  voice: 'Voice (local engines)',
  service: 'Service',
  daemon: 'Daemon',
  controlPlane: 'Control Plane',
  httpListener: 'HTTP Listener',
  web: 'Web',
  batch: 'Batch',
  automation: 'Automation',
  checkin: 'Check-in',
  watchers: 'Watchers',
  runtime: 'Runtime',
  telemetry: 'Telemetry',
  cache: 'Cache',
  diagnostics: 'Diagnostics',
  mcp: 'MCP',
  sandbox: 'Sandbox',
  surfaces: 'Surfaces',
  conversationGate: 'Channel Message Handling',
  cloudflare: 'Cloudflare',
  release: 'Release',
  power: 'Power',
  memory: 'Memory',
  danger: 'Danger',
  tools: 'Tools',
  network: 'Network',
  relay: 'Relay',
  learning: 'Learning',
  fetch: 'Fetch Safety',
  agents: 'Agents & Context',
  security: 'Token Security',
  integrations: 'Integration Delivery',
  policy: 'Policy-as-Code',
  notifications: 'Notifications',
};

const SETTING_LABELS: Partial<Record<string, string>> = {
  'ui.systemMessages': 'System Message Target',
  'ui.operationalMessages': 'Operational Message Target',
  'ui.wrfcMessages': 'WRFC Message Target',
  'ui.voiceEnabled': 'Always Speak',
  'behavior.autoCompactThreshold': 'Auto-Compact %',
  'behavior.staleContextWarnings': 'Context Warnings',
  // Blocked-too-long escalation: a fleet node waiting on a human gets a device
  // push once the grace elapses (regardless of an attached surface), then bounded
  // reminders. Real numeric option shapes come from the SDK schema's ranges.
  'notifications.blockedEscalationGraceMs': 'Blocked-Too-Long Grace (ms)',
  'notifications.blockedEscalationFollowUpMs': 'Blocked Reminder Interval (ms)',
  'notifications.blockedEscalationMaxFollowUps': 'Blocked Reminder Limit',
  'behavior.returnContextMode': 'Return Context',
  'behavior.guidanceMode': 'Guidance Mode',
  'storage.secretPolicy': 'Secret Policy',
  'permissions.mode': 'Permission Mode',
  'permissions.backgroundAgents': 'Background Agents',
  'diagnostics.postEdit': 'Post-Edit Diagnostics',
  'sandbox.vmBackend': 'Sandbox Backend',
  'sandbox.qemuBinary': 'QEMU Binary',
  'sandbox.qemuImagePath': 'QEMU Image',
  'sandbox.qemuExecWrapper': 'QEMU Wrapper',
  'sandbox.replJavaScriptCommand': 'REPL JS Command',
  'tools.llmProvider': 'Tool LLM Provider',
  'tools.llmModel': 'Tool LLM Model',
  'tools.autoHeal': 'Auto-Heal',
  'tools.defaultTokenBudget': 'Default Token Budget',
  'tools.hooksFile': 'Hooks File',
  'helper.enabled': 'Helper Enabled',
  'helper.globalProvider': 'Helper Provider',
  'helper.globalModel': 'Helper Model',
  // Control Plane
  'controlPlane.enabled': 'CP Enabled',
  'controlPlane.hostMode': 'CP Host Mode',
  'controlPlane.host': 'CP Host',
  'controlPlane.port': 'CP Port',
  'controlPlane.baseUrl': 'CP Base URL',
  'controlPlane.streamMode': 'CP Stream Mode',
  'controlPlane.allowRemote': 'CP Allow Remote',
  'controlPlane.trustProxy': 'CP Trust Proxy',
  'controlPlane.tls.mode': 'CP TLS Mode',
  'controlPlane.tls.certFile': 'CP TLS Cert',
  'controlPlane.tls.keyFile': 'CP TLS Key',
  // HTTP Listener
  'httpListener.hostMode': 'HTTP Host Mode',
  'httpListener.host': 'HTTP Host',
  'httpListener.port': 'HTTP Port',
  'httpListener.trustProxy': 'HTTP Trust Proxy',
  'httpListener.tls.mode': 'HTTP TLS Mode',
  'httpListener.tls.certFile': 'HTTP TLS Cert',
  // Web Server
  'web.enabled': 'Web Enabled',
  'web.hostMode': 'Web Host Mode',
  'web.host': 'Web Host',
  'web.port': 'Web Port',
  'web.publicBaseUrl': 'Web Public Base URL',
  'web.staticAssetsDir': 'Web Static Assets Dir',
  'surfaces.ntfy.enabled': 'ntfy Enabled',
  'surfaces.ntfy.baseUrl': 'ntfy Base URL',
  'surfaces.ntfy.topic': 'ntfy Default Delivery Topic',
  'surfaces.ntfy.chatTopic': 'ntfy Chat Topic',
  'surfaces.ntfy.agentTopic': 'ntfy Agent Topic',
  'surfaces.ntfy.remoteTopic': 'ntfy Daemon-Only Remote Topic',
  'surfaces.ntfy.token': 'ntfy Token',
  'surfaces.ntfy.defaultPriority': 'ntfy Default Priority',
  'surfaces.homeassistant.enabled': 'Home Assistant Enabled',
  'surfaces.homeassistant.instanceUrl': 'Home Assistant URL',
  'surfaces.homeassistant.accessToken': 'Home Assistant Access Token',
  'surfaces.homeassistant.webhookSecret': 'Home Assistant Webhook Secret',
  'surfaces.homeassistant.defaultConversationId': 'Home Assistant Conversation ID',
  'surfaces.homeassistant.remoteSessionTtlMs': 'Home Assistant Remote Session TTL',
  'surfaces.homeassistant.deviceId': 'Home Assistant Device ID',
  'surfaces.homeassistant.deviceName': 'Home Assistant Device Name',
  'surfaces.homeassistant.eventType': 'Home Assistant Event Type',
};

export function getSettingLabel(entry: SettingEntry): string {
  // Feature-unit headers carry the feature's human name, not the raw
  // enablement-key tail.
  if (entry.flag) return entry.flag.feature.name;
  return SETTING_LABELS[entry.setting.key] ?? entry.setting.key.replace(/^[^.]+\./, '');
}

export function describeUiRouting(value: string): string {
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
