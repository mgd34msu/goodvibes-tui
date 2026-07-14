/**
 * Pure formatting, label, and color helpers for renderSettingsModal.
 * Extracted from settings-modal.ts to keep the renderer under the 800-line
 * architecture cap. No layout logic lives here.
 */

import type { SettingEntry, McpEntry, SubscriptionEntry } from '../input/settings-modal-types.ts';
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
