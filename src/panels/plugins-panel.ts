import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import type { PanelIntegrationContext } from './types.ts';
import type { PluginManager, PluginManagerObserver, PluginStatus } from '@pellux/goodvibes-sdk/platform/plugins';
import {
  type ConfirmState,
  handleConfirmInput,
  renderConfirmLines,
} from './confirm-state.ts';
import {
  buildDetailBlock,
  buildEmptyState,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE.
const C = DEFAULT_PANEL_PALETTE;

/**
 * PluginsPanel drives real plugin-manager mutations (enable/disable/
 * verify/lift-quarantine) from the keyboard, not just read-only inspection.
 * `PluginManagerObserver` alone (the read-only surface most panels need) has
 * no mutation methods, so the constructor param is widened to also require
 * the handful of `PluginManager` methods this panel actually calls. The real
 * runtime object passed at bootstrap (`services.pluginManager`, a full
 * `PluginManager` instance — see src/runtime/services.ts) already satisfies
 * this widened shape.
 */
export type PluginManagerControls = PluginManagerObserver
  & Pick<PluginManager, 'enable' | 'disable' | 'verify' | 'liftQuarantine'>;

type PluginConfirmSubject = { readonly kind: 'disable' | 'lift-quarantine'; readonly name: string };

function trustColor(tier: PluginStatus['trustTier']): string {
  switch (tier) {
    case 'trusted':
      return C.good;
    case 'limited':
      return C.warn;
    case 'untrusted':
      return C.bad;
  }
}

function statusColor(status: PluginStatus): string {
  if (status.quarantined) return C.bad;
  if (status.active) return C.good;
  if (status.enabled) return C.warn;
  return C.dim;
}

function statusLabel(status: PluginStatus): string {
  if (status.quarantined) return 'QUARANTINED';
  if (status.active) return 'ACTIVE';
  if (status.enabled) return 'ENABLED';
  return 'DISABLED';
}

export class PluginsPanel extends ScrollableListPanel<PluginStatus> {
  private readonly manager: PluginManagerControls;
  private readonly unsub: (() => void) | null;
  /** Pending destructive/state-changing confirm for 'd' disable and 'q' lift-quarantine. */
  private confirmAction: ConfirmState<PluginConfirmSubject> | null = null;
  /** Result of the last 'v' verify press, rendered in the detail block until the selection or a new verify changes it. */
  private _verifyResult: { name: string; valid: boolean; fingerprint?: string | undefined; reason?: string | undefined } | null = null;

  public constructor(manager: PluginManagerControls) {
    super('plugins', 'Plugins', '◐', 'automation-control');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter plugins';
    this.manager = manager;
    this.unsub = manager.subscribe(() => this.markDirty());
  }

  protected override filterMatches(plugin: PluginStatus, q: string): boolean {
    return plugin.name.toLowerCase().includes(q)
      || plugin.trustTier.toLowerCase().includes(q)
      || plugin.version.toLowerCase().includes(q);
  }

  // selection is preserved across onActivate — BasePanel's default
  // (mark dirty, no index reset) is exactly what we want, so no override.

  public override onDestroy(): void {
    this.unsub?.();
  }

  // -------------------------------------------------------------------------
  // Input — e=enable, d=disable (confirm), v=verify, q=lift quarantine (confirm)
  // -------------------------------------------------------------------------

  public handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    if (this.confirmAction) {
      const result = handleConfirmInput(this.confirmAction, key);
      if (result === 'confirmed') {
        this._executeConfirmed(this.confirmAction.subject);
        this.confirmAction = null;
        this.markDirty();
        return true;
      }
      if (result === 'cancelled') {
        this.confirmAction = null;
        this.markDirty();
      }
      return true;
    }

    if (!this.filterActive) {
      switch (key) {
        case 'e':
          this._enableSelected();
          return true;
        case 'd':
          this._requestDisable();
          return true;
        case 'v':
          this._verifySelected();
          return true;
        case 'q': {
          const plugin = this.getSelectedItem();
          if (!plugin?.quarantined) return false;
          this._requestLiftQuarantine();
          return true;
        }
        case 'm': {
          // Consumed here only when there is a quarantined plugin selected;
          // the actual /recall dispatch happens in handlePanelIntegrationAction
          // below, which needs the executeCommand bridge from the router.
          const plugin = this.getSelectedItem();
          return Boolean(plugin?.quarantined);
        }
        default:
          break;
      }
    }

    return super.handleInput(key);
  }

  /**
   * optional one-key capture-to-memory for a quarantined plugin — 'm'
   * dispatches `/recall capture plugin <name>` (recall-capture.ts:146 pattern)
   * instead of requiring the operator to type the command by hand.
   */
  public handlePanelIntegrationAction(key: string, ctx: PanelIntegrationContext): boolean {
    if (key !== 'm' || !ctx.executeCommand) return false;
    const plugin = this.getSelectedItem();
    if (!plugin?.quarantined) return false;
    void ctx.executeCommand('recall', ['capture', 'plugin', plugin.name]).catch(() => {});
    return true;
  }

  private _enableSelected(): void {
    const plugin = this.getSelectedItem();
    if (!plugin) return;
    void this.manager.enable(plugin.name).then((result) => {
      if (!result.ok) this.setError(`Enable failed: ${result.error ?? 'unknown error'}`);
      this.markDirty();
    }).catch((err) => {
      this.setError(`Enable failed: ${err instanceof Error ? err.message : String(err)}`);
      this.markDirty();
    });
  }

  private _requestDisable(): void {
    const plugin = this.getSelectedItem();
    if (!plugin) return;
    this.confirmAction = { subject: { kind: 'disable', name: plugin.name }, label: plugin.name, verb: 'Disable' };
    this.markDirty();
  }

  private _requestLiftQuarantine(): void {
    const plugin = this.getSelectedItem();
    if (!plugin?.quarantined) return;
    this.confirmAction = { subject: { kind: 'lift-quarantine', name: plugin.name }, label: plugin.name, verb: 'Lift quarantine on' };
    this.markDirty();
  }

  private _verifySelected(): void {
    const plugin = this.getSelectedItem();
    if (!plugin) return;
    const result = this.manager.verify(plugin.name);
    if (!result.ok && result.reason?.toLowerCase().includes('not found')) {
      this._verifyResult = null;
      this.setError(`Verify failed: ${result.reason}`);
      this.markDirty();
      return;
    }
    this._verifyResult = { name: plugin.name, valid: result.valid, fingerprint: result.fingerprint, reason: result.reason };
    this.markDirty();
  }

  private _executeConfirmed(subject: PluginConfirmSubject): void {
    if (subject.kind === 'disable') {
      void this.manager.disable(subject.name).then((result) => {
        if (!result.ok) this.setError(`Disable failed: ${result.error ?? 'unknown error'}`);
        this.markDirty();
      }).catch((err) => {
        this.setError(`Disable failed: ${err instanceof Error ? err.message : String(err)}`);
        this.markDirty();
      });
      return;
    }
    const result = this.manager.liftQuarantine(subject.name);
    if (!result.ok) this.setError(`Lift quarantine failed: ${result.error ?? 'unknown error'}`);
    this.markDirty();
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly PluginStatus[] {
    return this.manager.list();
  }

  protected renderItem(plugin: PluginStatus, _index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [plugin.name.padEnd(22), C.value, bg],
      [` ${statusLabel(plugin).padEnd(11)}`, statusColor(plugin), bg],
      [` ${plugin.trustTier.toUpperCase().padEnd(10)}`, trustColor(plugin.trustTier), bg],
      [` ${plugin.version}`, C.dim, bg],
    ]);
  }

  protected override getEmptyStateMessage(): string {
    return ' No plugins discovered.';
  }

  protected override getEmptyStateActions(): Array<{ command: string; summary: string }> {
    return [
      { command: '/plugin list', summary: 'inspect plugin discovery paths and current registry state' },
      { command: '/marketplace', summary: 'review curated ecosystem entries and provenance posture' },
    ];
  }

  public render(width: number, height: number): Line[] {
    const intro = 'Plugin trust, capabilities, signatures, and quarantine posture for the active ecosystem surface.';
    const plugins = this.getItems();

    if (plugins.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Plugin Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No plugins discovered.',
            'Use /plugin list for search paths, install hints, and trust review before activating plugin-backed flows.',
            [
              { command: '/plugin list', summary: 'inspect plugin discovery paths and current registry state' },
              { command: '/marketplace', summary: 'review curated ecosystem entries and provenance posture' },
            ],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    // Provenance/error posture header — surface trust + quarantine pressure first.
    const quarantined = plugins.filter((p) => p.quarantined).length;
    const untrusted = plugins.filter((p) => p.trustTier === 'untrusted').length;
    const active = plugins.filter((p) => p.active).length;
    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'plugins', value: String(plugins.length), valueColor: C.info },
        { label: 'active', value: String(active), valueColor: active > 0 ? C.good : C.dim },
        { label: 'untrusted', value: String(untrusted), valueColor: untrusted > 0 ? C.warn : C.dim },
        { label: 'quarantined', value: String(quarantined), valueColor: quarantined > 0 ? C.bad : C.dim },
      ], C),
    ];

    this.clampSelection();
    const selected = this.getSelectedItem()!;
    const selectedCaps = this.manager.capabilities(selected.name);
    const trustRecord = this.manager.getTrustRecord(selected.name);
    const quarantineRecord = this.manager.getQuarantineRecord(selected.name);
    const detailRows: Line[] = [
      buildPanelLine(width, [
        ['  Plugin: ', C.label],
        [selected.name, C.value],
        ['  v', C.label],
        [selected.version, C.dim],
        ['  State: ', C.label],
        [statusLabel(selected), statusColor(selected)],
        ['  Trust: ', C.label],
        [selected.trustTier, trustColor(selected.trustTier)],
      ]),
      buildPanelLine(width, [
        ['  Description: ', C.label],
        [truncateDisplay(selected.description, Math.max(0, width - 15)), C.dim],
      ]),
    ];

    if (selectedCaps) {
      detailRows.push(buildPanelLine(width, [
        ['  Capabilities: ', C.label],
        [String(selectedCaps.requested.length), C.value],
        ['  High-risk: ', C.label],
        [String(selectedCaps.highRisk.length), selectedCaps.highRisk.length > 0 ? C.warn : C.good],
        ['  Blocked: ', C.label],
        [String(selectedCaps.blocked.length), selectedCaps.blocked.length > 0 ? C.bad : C.good],
      ]));
    }

    if (trustRecord?.signatureFingerprint) {
      detailRows.push(buildPanelLine(width, [
        ['  Signature: ', C.label],
        [truncateDisplay(trustRecord.signatureFingerprint, Math.max(0, width - 14)), C.info],
      ]));
    } else {
      detailRows.push(buildPanelLine(width, [['  Signature: unsigned (no provenance fingerprint on record)', C.warn]]));
    }

    if (quarantineRecord) {
      detailRows.push(buildPanelLine(width, [
        ['  Quarantine: ', C.label],
        [truncateDisplay(quarantineRecord.reason, Math.max(0, width - 14)), C.bad],
      ]));
    }

    if (this._verifyResult && this._verifyResult.name === selected.name) {
      const vr = this._verifyResult;
      const verifySegments: Array<[string, string, string?]> = [
        ['  Verify: ', C.label],
        [vr.valid ? 'VALID' : 'INVALID', vr.valid ? C.good : C.bad],
      ];
      if (vr.fingerprint) verifySegments.push([` fp=${truncateDisplay(vr.fingerprint, 20)}`, C.info]);
      if (!vr.valid && vr.reason) verifySegments.push([` ${truncateDisplay(vr.reason, Math.max(0, width - 40))}`, C.warn]);
      detailRows.push(buildPanelLine(width, verifySegments));
    }

    if (this.confirmAction) detailRows.push(...renderConfirmLines(width, this.confirmAction));

    const hints = this.filterActive
      ? [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }]
      : [
          { keys: 'Up/Down', label: 'move' },
          { keys: 'e', label: 'enable' },
          { keys: 'd', label: 'disable' },
          { keys: 'v', label: 'verify' },
          ...(selected.quarantined ? [{ keys: 'q', label: 'lift quarantine' }, { keys: 'm', label: 'capture to memory' }] : []),
          { keys: '/', label: 'filter' },
        ];

    return this.renderList(width, height, {
      title: 'Plugin Control Room',
      header: headerLines,
      footer: [
        ...buildDetailBlock(width, `Plugin · ${selected.name}`, detailRows, C),
        buildKeyboardHints(width, hints, C),
      ],
    });
  }
}
