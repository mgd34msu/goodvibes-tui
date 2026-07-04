import { MODAL_TONES } from './modal-theme.ts';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
import type {
  PluginManager,
  PluginManagerObserver,
  PluginStatus,
} from '@pellux/goodvibes-sdk/platform/plugins';

// ---------------------------------------------------------------------------
// Plugins → modal (W6 WO-B). Mirrors src/panels/plugins-panel.ts:
// PluginsPanel(manager: PluginManagerControls), where
//   PluginManagerControls = PluginManagerObserver
//     & Pick<PluginManager, 'enable' | 'disable' | 'verify' | 'liftQuarantine'>
// (plugins-panel.ts:37-38). This modal only needs the READ methods the panel
// used to render (list/capabilities/getTrustRecord/getQuarantineRecord) plus
// `verify`, which the SDK implements as a pure inspection call — it never
// mutates trust/quarantine state (see
// node_modules/@pellux/goodvibes-sdk/dist/platform/plugins/manager.js:114-122,
// PluginManager.verify delegates to PluginTrustStore.verify(), a read-only
// signature check). `enable`/`disable`/`liftQuarantine` are DROPPED from the
// dep shape on purpose: those verbs are destructive/interactive mutations and
// route to the `/plugin` command path instead (action-parity charter rule —
// see modal-surface.ts), so this modal never needs to call them directly.
// ---------------------------------------------------------------------------

/** Minimal structural read surface this modal needs from the live plugin manager. */
export type PluginsModalManager = Pick<PluginManagerObserver, 'list' | 'capabilities' | 'getTrustRecord' | 'getQuarantineRecord'>
  & Pick<PluginManager, 'verify'>;

export interface PluginsModalDeps {
  readonly pluginManager: PluginsModalManager;
}

/** Cached result of a 'v' verify press, kept until a new verify or the process restarts. */
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

function trustColor(tier: PluginStatus['trustTier']): string {
  switch (tier) {
    case 'trusted':
      return MODAL_TONES.good;
    case 'limited':
      return MODAL_TONES.warn;
    case 'untrusted':
      return MODAL_TONES.bad;
  }
}

function matchesQuery(plugin: PluginStatus, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return plugin.name.toLowerCase().includes(needle)
    || plugin.trustTier.toLowerCase().includes(needle)
    || plugin.version.toLowerCase().includes(needle);
}

/**
 * Plugins → modal. Trust, capabilities, signature, and quarantine posture for
 * the active plugin registry. `pluginManager.list()` etc. are already
 * in-memory reads (no disk I/O per call — see PluginManager), so buildConfig
 * reads live and refresh() is a no-op, matching the panel's own always-live
 * getItems(). Enable/disable/lift-quarantine/capture-to-memory route to their
 * command paths rather than mutating the manager directly from the modal.
 */
export function bindPluginsModal(deps: PluginsModalDeps): BoundModalSurface {
  const { pluginManager } = deps;
  const verifyResults = new Map<string, VerifyResult>();

  const visiblePlugins = (view: ModalViewState): PluginStatus[] =>
    pluginManager.list().filter((plugin) => matchesQuery(plugin, view.query));

  const selectedPlugin = (view: ModalViewState): PluginStatus | undefined => {
    const visible = visiblePlugins(view);
    if (visible.length === 0) return undefined;
    return visible[Math.max(0, Math.min(view.selectedIndex, visible.length - 1))];
  };

  const buildConfig = (view: ModalViewState): ModalConfig => {
    const all = pluginManager.list();

    if (all.length === 0) {
      return {
        title: 'Plugins',
        width: 76,
        sections: [
          { type: 'text', content: 'No plugins discovered.' },
          { type: 'separator' },
          { type: 'title', content: 'Next steps' },
          { type: 'text', content: '/plugin list  — inspect plugin discovery paths and current registry state', style: { dim: true } },
          { type: 'text', content: '/marketplace  — review curated ecosystem entries and provenance posture', style: { dim: true } },
        ],
        footer: 'no plugins discovered · esc close',
      };
    }

    const sections: ModalSection[] = [];
    const active = all.filter((p) => p.active).length;
    const untrusted = all.filter((p) => p.trustTier === 'untrusted').length;
    const quarantined = all.filter((p) => p.quarantined).length;
    sections.push({
      type: 'text',
      content: `plugins ${all.length}  active ${active}  untrusted ${untrusted}  quarantined ${quarantined}`,
      style: { dim: true },
    });
    sections.push({ type: 'separator' });

    const visible = visiblePlugins(view);
    const clampedIndex = Math.max(0, Math.min(view.selectedIndex, visible.length - 1));
    const items: ModalListItem[] = visible.map((plugin, index) => ({
      label: `${plugin.name.padEnd(22)} ${statusLabel(plugin).padEnd(11)} ${plugin.trustTier.toUpperCase().padEnd(10)} ${plugin.version}`,
      selected: index === clampedIndex,
    }));
    if (items.length === 0) {
      sections.push({ type: 'text', content: `No plugins match “${view.query}”.`, style: { dim: true } });
    } else {
      sections.push({ type: 'list', items });
    }

    const selected = visible[clampedIndex];
    if (selected) {
      sections.push({ type: 'separator' });
      sections.push({
        type: 'text',
        content: `state ${statusLabel(selected)}  trust ${selected.trustTier}  v${selected.version}`,
        style: { fg: statusColor(selected) },
      });
      sections.push({ type: 'text', content: selected.description || '(no description)', style: { dim: true } });

      const caps = pluginManager.capabilities(selected.name);
      if (caps) {
        sections.push({
          type: 'text',
          content: `capabilities requested ${caps.requested.length}  high-risk ${caps.highRisk.length}  blocked ${caps.blocked.length}`,
        });
      }

      const trustRecord = pluginManager.getTrustRecord(selected.name);
      if (trustRecord?.signatureFingerprint) {
        sections.push({ type: 'text', content: `signature ${trustRecord.signatureFingerprint}`, style: { fg: MODAL_TONES.info } });
      } else {
        sections.push({ type: 'text', content: 'signature unsigned (no provenance fingerprint on record)', style: { fg: MODAL_TONES.warn } });
      }

      const quarantineRecord = pluginManager.getQuarantineRecord(selected.name);
      if (quarantineRecord) {
        sections.push({ type: 'text', content: `quarantine: ${quarantineRecord.reason}`, style: { fg: MODAL_TONES.bad } });
      }

      const verify = verifyResults.get(selected.name);
      if (verify) {
        const suffix = verify.fingerprint ? ` fp=${verify.fingerprint}` : (!verify.valid && verify.reason ? ` — ${verify.reason}` : '');
        sections.push({
          type: 'text',
          content: `verify ${verify.valid ? 'VALID' : 'INVALID'}${suffix}`,
          style: { fg: verify.valid ? MODAL_TONES.good : MODAL_TONES.bad },
        });
      }
    }

    return {
      title: 'Plugins',
      width: 76,
      search: view.query,
      sections,
      hints: [
        'up/down move',
        'e enable',
        'd disable',
        'v verify',
        ...(selected?.quarantined ? ['q lift quarantine', 'm capture to memory'] : []),
        'r refresh',
        '/ filter',
      ],
    };
  };

  const enable: ModalAction = (view) => {
    const plugin = selectedPlugin(view);
    if (!plugin || plugin.active) return { kind: 'none' };
    return { kind: 'runCommand', command: `/plugin enable ${plugin.name}` };
  };

  const disable: ModalAction = (view) => {
    const plugin = selectedPlugin(view);
    if (!plugin || !plugin.enabled) return { kind: 'none' };
    return { kind: 'runCommand', command: `/plugin disable ${plugin.name}` };
  };

  const verify: ModalAction = (view) => {
    const plugin = selectedPlugin(view);
    if (!plugin) return { kind: 'none' };
    const result = pluginManager.verify(plugin.name);
    verifyResults.set(plugin.name, { valid: result.valid, fingerprint: result.fingerprint, reason: result.reason });
    return { kind: 'none' };
  };

  const liftQuarantine: ModalAction = (view) => {
    const plugin = selectedPlugin(view);
    if (!plugin?.quarantined) return { kind: 'none' };
    return { kind: 'runCommand', command: `/plugin quarantine ${plugin.name} lift` };
  };

  const captureToMemory: ModalAction = (view) => {
    const plugin = selectedPlugin(view);
    if (!plugin?.quarantined) return { kind: 'none' };
    return { kind: 'runCommand', command: `/recall capture plugin ${plugin.name}` };
  };

  return {
    name: 'plugins',
    title: 'Plugins',
    refresh: () => {},
    buildConfig,
    rowIds: (view) => visiblePlugins(view).map((plugin) => plugin.name),
    actions: {
      refresh: () => ({ kind: 'refresh' }),
      enable,
      disable,
      verify,
      liftQuarantine,
      captureToMemory,
    },
  };
}

/**
 * Deterministic golden fixture: a fixed two-plugin roster (one active/trusted,
 * one quarantined/untrusted) so both the base list rendering and the
 * quarantine-only hints ('q lift quarantine', 'm capture to memory') are
 * exercised without any disk I/O, wall-clock, or random ids.
 */
export function pluginsModalGoldenSurface(): BoundModalSurface {
  const fixedPlugins: PluginStatus[] = [
    {
      name: 'formatter',
      version: '1.0.0',
      description: 'Deterministic golden fixture plugin.',
      enabled: true,
      active: true,
      trustTier: 'trusted',
      quarantined: false,
    },
    {
      name: 'risky-tool',
      version: '0.2.0',
      description: 'Second golden fixture plugin, quarantined.',
      enabled: false,
      active: false,
      trustTier: 'untrusted',
      quarantined: true,
    },
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
  const surface = bindPluginsModal({ pluginManager: manager });
  surface.refresh();
  return surface;
}
