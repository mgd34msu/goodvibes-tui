/**
 * Pure formatting, label, and color helpers for renderSettingsModal.
 * Extracted from settings-modal.ts to keep the renderer under the 800-line
 * architecture cap. No layout logic lives here.
 */

import type { SettingEntry, McpEntry, SubscriptionEntry } from '../input/settings-modal.ts';
import { SETTINGS_CATEGORIES } from '../input/settings-modal.ts';

export function formatValue(entry: SettingEntry): string {
  const val = entry.currentValue;
  if (val === null || val === undefined) return '(unset)';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'string' && val === '') return '(empty)';
  return String(val);
}

export function valueColor(entry: SettingEntry): string {
  if (!entry.isDefault) return '#00ffcc'; // cyan-green = modified
  return '244';                            // dim = default
}

export function flagStateColor(state: string, killed: boolean): string {
  if (killed) return '#ef4444'; // red
  if (state === 'enabled') return '#00ffcc'; // cyan-green
  return '244'; // dim
}

export function mcpTrustColor(mode: McpEntry['trustMode']): string {
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

export function subscriptionStateColor(state: SubscriptionEntry['state']): string {
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
  subscriptions: 'Subscriptions',
  behavior: 'Behavior',
  storage: 'Storage',
  permissions: 'Permissions',
  mcp: 'MCP',
  sandbox: 'Sandbox',
  surfaces: 'Surfaces',
  danger: 'Danger',
  tools: 'Tools',
  flags: 'Flags',
  network: 'Network',
};

export const SETTING_LABELS: Partial<Record<string, string>> = {
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
};

export function getSettingLabel(entry: SettingEntry): string {
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
