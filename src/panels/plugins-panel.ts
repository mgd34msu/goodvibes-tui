import type { Line, Cell } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { pluginManager } from '../plugins/manager.ts';
import type { PluginManagerObserver, PluginStatus } from '../plugins/manager.ts';

const C = {
  header: '#94a3b8',
  headerBg: '#1e293b',
  label: '#64748b',
  value: '#e2e8f0',
  dim: '#475569',
  ok: '#22c55e',
  warn: '#eab308',
  error: '#ef4444',
  info: '#38bdf8',
  selectBg: '#0f172a',
  empty: '#334155',
} as const;

function buildLine(width: number, segments: Array<[string, string, string?]>): Line {
  const cells: Cell[] = [];
  let used = 0;
  for (const [text, fg, bg] of segments) {
    cells.push(createStyledCell(text, { fg, bg: bg ?? '' }));
    used += text.length;
  }
  if (used < width) cells.push(createStyledCell(' '.repeat(width - used), { fg: '' }));
  return cells;
}

function trustColor(tier: PluginStatus['trustTier']): string {
  switch (tier) {
    case 'trusted':
      return C.ok;
    case 'limited':
      return C.warn;
    case 'untrusted':
      return C.error;
  }
}

function statusColor(status: PluginStatus): string {
  if (status.quarantined) return C.error;
  if (status.active) return C.ok;
  if (status.enabled) return C.warn;
  return C.dim;
}

function statusLabel(status: PluginStatus): string {
  if (status.quarantined) return 'QUARANTINED';
  if (status.active) return 'ACTIVE';
  if (status.enabled) return 'ENABLED';
  return 'DISABLED';
}

export class PluginsPanel extends BasePanel {
  private readonly manager: PluginManagerObserver;
  private readonly unsub: (() => void) | null;
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor(manager: PluginManagerObserver = pluginManager) {
    super('plugins', 'Plugins', 'P', 'monitoring');
    this.manager = manager;
    this.unsub = manager.subscribe(() => this.markDirty());
  }

  public override onActivate(): void {
    super.onActivate();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public override onDestroy(): void {
    this.unsub?.();
  }

  public handleInput(key: string): boolean {
    const plugins = this.manager.list();
    if (plugins.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(plugins.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Plugin Control Room', C.header, C.headerBg]]));

    const plugins = this.manager.list();
    if (plugins.length === 0) {
      lines.push(buildLine(width, [[' No plugins discovered. Use /plugin list for search paths and install hints.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const bodyHeight = Math.max(1, height - 1);
    const maxScroll = Math.max(0, plugins.length - bodyHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + bodyHeight) {
      this.scrollOffset = this.selectedIndex - bodyHeight + 1;
    }

    const selected = plugins[this.selectedIndex]!;
    const selectedCaps = this.manager.capabilities(selected.name);
    const trustRecord = this.manager.getTrustRecord(selected.name);
    const quarantineRecord = this.manager.getQuarantineRecord(selected.name);

    const visible = plugins.slice(this.scrollOffset, this.scrollOffset + Math.max(1, bodyHeight - 6));
    for (let index = 0; index < visible.length; index++) {
      const plugin = visible[index]!;
      const absoluteIndex = this.scrollOffset + index;
      const bg = absoluteIndex === this.selectedIndex ? C.selectBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [plugin.name.padEnd(22), C.value, bg],
        [` ${statusLabel(plugin).padEnd(11)}`, statusColor(plugin), bg],
        [` ${plugin.trustTier.toUpperCase().padEnd(10)}`, trustColor(plugin.trustTier), bg],
        [` ${plugin.version}`, C.dim, bg],
      ]));
    }

    lines.push(buildLine(width, [[' Details', C.label]]));
    lines.push(buildLine(width, [
      ['  Plugin: ', C.label],
      [selected.name, C.value],
      ['  State: ', C.label],
      [statusLabel(selected), statusColor(selected)],
      ['  Trust: ', C.label],
      [selected.trustTier, trustColor(selected.trustTier)],
    ]));
    lines.push(buildLine(width, [
      ['  Description: ', C.label],
      [selected.description.slice(0, Math.max(0, width - 15)), C.dim],
    ]));

    if (selectedCaps) {
      lines.push(buildLine(width, [
        ['  Capabilities: ', C.label],
        [String(selectedCaps.requested.length), C.value],
        ['  High-risk: ', C.label],
        [String(selectedCaps.highRisk.length), selectedCaps.highRisk.length > 0 ? C.warn : C.ok],
        ['  Blocked: ', C.label],
        [String(selectedCaps.blocked.length), selectedCaps.blocked.length > 0 ? C.error : C.ok],
      ]));
    }

    if (trustRecord?.signatureFingerprint) {
      lines.push(buildLine(width, [
        ['  Signature: ', C.label],
        [trustRecord.signatureFingerprint, C.info],
      ]));
    }

    if (quarantineRecord) {
      lines.push(buildLine(width, [
        ['  Quarantine: ', C.label],
        [quarantineRecord.reason.slice(0, Math.max(0, width - 14)), C.error],
      ]));
    }

    lines.push(buildLine(width, [['  Inspect trust and capability state here, then use /plugin to take action.', C.dim]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
