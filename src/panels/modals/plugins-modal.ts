import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import type {
  PluginManager,
  PluginManagerObserver,
  PluginStatus,
} from '@pellux/goodvibes-sdk/platform/plugins';

// ---------------------------------------------------------------------------
// Plugins → config-modal surface (group-B port). Mirrors the retired
// PluginsPanel's read surface (list/capabilities/getTrustRecord/
// getQuarantineRecord) plus `verify` (a pure read-only signature check).
// enable/disable/liftQuarantine are DROPPED from the dep shape on purpose:
// those verbs are destructive/interactive mutations and route to the `/plugin`
// command path (action-parity charter rule). Selection-blind port: the panel's
// selected-plugin signature/quarantine/verify detail is folded into row labels.
// ---------------------------------------------------------------------------

/** Minimal structural read surface this modal needs from the live plugin manager. */
export type PluginsModalManager = Pick<PluginManagerObserver, 'list' | 'capabilities' | 'getTrustRecord' | 'getQuarantineRecord'>
  & Pick<PluginManager, 'verify'>;

export interface PluginsModalDeps {
  readonly pluginManager: PluginsModalManager;
}

interface VerifyResult {
  readonly valid: boolean;
  readonly fingerprint?: string | undefined;
  readonly reason?: string | undefined;
}

function statusLabel(plugin: PluginStatus): string {
  if (plugin.quarantined) return 'QUARANTINED';
  if (plugin.active) return 'ACTIVE';
  if (plugin.enabled) return 'ENABLED';
  return 'DISABLED';
}

function statusColor(plugin: PluginStatus): string {
  if (plugin.quarantined) return MODAL_TONES.bad;
  if (plugin.active) return MODAL_TONES.good;
  if (plugin.enabled) return MODAL_TONES.warn;
  return MODAL_TONES.muted;
}

/**
 * Plugins → modal. Trust, capabilities, signature, and quarantine posture for
 * the active plugin registry. `pluginManager.list()` etc. are in-memory reads
 * (no disk I/O per call), so buildView reads live and refresh() is a no-op.
 * Enable/disable/lift-quarantine/capture-to-memory route to their command
 * paths rather than mutating the manager directly from the modal.
 */
class PluginsModalSurface implements ConfigModalSurface {
  readonly name = 'plugins-modal';
  readonly title = 'Plugins';
  private readonly verifyResults = new Map<string, VerifyResult>();
  private requestRender: () => void = () => {};

  constructor(private readonly deps: PluginsModalDeps) {}

  readonly actions = [
    { key: 'e', id: 'enable', label: 'enable', enabledFor: (row: ConfigModalRow | null) => this.pluginFrom(row)?.active === false },
    { key: 'd', id: 'disable', label: 'disable', enabledFor: (row: ConfigModalRow | null) => this.pluginFrom(row)?.enabled === true },
    { key: 'v', id: 'verify', label: 'verify' },
    { key: 'q', id: 'liftQuarantine', label: 'lift quarantine', enabledFor: (row: ConfigModalRow | null) => this.pluginFrom(row)?.quarantined === true },
    { key: 'm', id: 'captureToMemory', label: 'capture to memory', enabledFor: (row: ConfigModalRow | null) => this.pluginFrom(row)?.quarantined === true },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; }

  private pluginFrom(row: ConfigModalRow | null): PluginStatus | undefined {
    if (!row) return undefined;
    return this.deps.pluginManager.list().find((p) => p.name === row.id);
  }

  buildView(): ConfigModalView {
    const all = this.deps.pluginManager.list();
    const rows: ConfigModalRow[] = [];

    if (all.length === 0) {
      rows.push(infoRow('empty:0', 'No plugins discovered.'));
      rows.push(infoRow('empty:title', 'Next steps'));
      rows.push(infoRow('empty:list', '/plugin list  — inspect plugin discovery paths and current registry state', { dim: true }));
      rows.push(infoRow('empty:market', '/marketplace  — review curated ecosystem entries and provenance posture', { dim: true }));
      return { title: 'Plugins', tabs: [{ id: 'plugins', label: 'Plugins', rows, emptyText: '' }] };
    }

    const active = all.filter((p) => p.active).length;
    const untrusted = all.filter((p) => p.trustTier === 'untrusted').length;
    const quarantined = all.filter((p) => p.quarantined).length;
    const header = [`plugins ${all.length}  active ${active}  untrusted ${untrusted}  quarantined ${quarantined}`];

    for (const plugin of all) {
      const caps = this.deps.pluginManager.capabilities(plugin.name);
      const trustRecord = this.deps.pluginManager.getTrustRecord(plugin.name);
      const quarantineRecord = this.deps.pluginManager.getQuarantineRecord(plugin.name);
      const verify = this.verifyResults.get(plugin.name);
      const suffix = [
        trustRecord?.signatureFingerprint ? `sig ${trustRecord.signatureFingerprint}` : 'unsigned',
        caps ? `caps ${caps.requested.length}/${caps.highRisk.length}hr/${caps.blocked.length}blk` : null,
        quarantineRecord ? `quarantine: ${quarantineRecord.reason}` : null,
        verify ? `verify ${verify.valid ? 'VALID' : 'INVALID'}${verify.fingerprint ? ` fp=${verify.fingerprint}` : (!verify.valid && verify.reason ? `: ${verify.reason}` : '')}` : null,
      ].filter((s): s is string => s !== null).join(' · ');
      rows.push({
        id: plugin.name,
        label: `${plugin.name.padEnd(22)} ${statusLabel(plugin).padEnd(11)} ${plugin.trustTier.toUpperCase().padEnd(10)} v${plugin.version} · ${suffix}`,
        style: { fg: statusColor(plugin) },
      });
    }

    return { title: 'Plugins', tabs: [{ id: 'plugins', label: 'Plugins', header, rows }] };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { ctx.setStatus('Plugins are read live.'); ctx.requestRender(); return; }
    const plugin = this.pluginFrom(ctx.row);
    if (!plugin) return;
    switch (id) {
      case 'enable':
        if (!plugin.active) { void ctx.executeCommand?.('plugin', ['enable', plugin.name]); ctx.setStatus(`Dispatched /plugin enable ${plugin.name}.`); }
        break;
      case 'disable':
        if (plugin.enabled) { void ctx.executeCommand?.('plugin', ['disable', plugin.name]); ctx.setStatus(`Dispatched /plugin disable ${plugin.name}.`); }
        break;
      case 'verify': {
        const result = this.deps.pluginManager.verify(plugin.name);
        this.verifyResults.set(plugin.name, { valid: result.valid, fingerprint: result.fingerprint, reason: result.reason });
        ctx.setStatus(`verify ${result.valid ? 'VALID' : 'INVALID'}`);
        this.requestRender();
        break;
      }
      case 'liftQuarantine':
        if (plugin.quarantined) { void ctx.executeCommand?.('plugin', ['quarantine', plugin.name, 'lift']); ctx.setStatus(`Dispatched /plugin quarantine ${plugin.name} lift.`); }
        break;
      case 'captureToMemory':
        if (plugin.quarantined) { void ctx.executeCommand?.('recall', ['capture', 'plugin', plugin.name]); ctx.setStatus(`Dispatched /recall capture plugin ${plugin.name}.`); }
        break;
    }
  }
}

export function createPluginsModalSurface(deps: PluginsModalDeps): ConfigModalSurface {
  return new PluginsModalSurface(deps);
}

/**
 * Deterministic golden fixture: a fixed two-plugin roster (one active/trusted,
 * one quarantined/untrusted) so both the base list rendering and the quarantine
 * suffix are exercised without any disk I/O, wall-clock, or random ids.
 */
export function pluginsModalGoldenSurface(): ConfigModalSurface {
  const fixedPlugins: PluginStatus[] = [
    { name: 'formatter', version: '1.0.0', description: 'Deterministic golden fixture plugin.', enabled: true, active: true, trustTier: 'trusted', quarantined: false },
    { name: 'risky-tool', version: '0.2.0', description: 'Second golden fixture plugin, quarantined.', enabled: false, active: false, trustTier: 'untrusted', quarantined: true },
  ];
  const manager: PluginsModalManager = {
    list: () => fixedPlugins,
    capabilities: () => null,
    getTrustRecord: () => undefined,
    getQuarantineRecord: (name) => (name === 'risky-tool'
      ? { pluginName: name, quarantinedAt: 0, reason: 'golden fixture quarantine', revokedCapabilities: [], lifted: false }
      : undefined),
    verify: () => ({ ok: true, valid: true, fingerprint: 'golden-fixture-fp' }),
  };
  return createPluginsModalSurface({ pluginManager: manager });
}
