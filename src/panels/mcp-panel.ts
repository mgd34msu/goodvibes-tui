import type { Line, Cell } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { mcpRegistry, type McpRegistry } from '../mcp/registry.ts';
import type { McpDecisionRecord } from '../runtime/mcp/types.ts';

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

function modeColor(mode: string): string {
  switch (mode) {
    case 'allow-all':
      return C.error;
    case 'ask-on-risk':
      return C.warn;
    case 'constrained':
      return C.ok;
    case 'blocked':
      return C.error;
    default:
      return C.dim;
  }
}

function freshnessColor(freshness: string): string {
  switch (freshness) {
    case 'fresh':
      return C.ok;
    case 'stale':
    case 'fetch_failed':
      return C.warn;
    case 'quarantined':
      return C.error;
    default:
      return C.dim;
  }
}

function decisionColor(decision: McpDecisionRecord): string {
  if (decision.verdict === 'deny') return C.error;
  if (decision.verdict === 'ask') return C.warn;
  return decision.incoherent ? C.warn : C.ok;
}

export class McpPanel extends BasePanel {
  private readonly registry: McpRegistry;
  private selectedIndex = 0;

  public constructor(registry: McpRegistry = mcpRegistry) {
    super('mcp', 'MCP', 'Z', 'monitoring');
    this.registry = registry;
  }

  public handleInput(key: string): boolean {
    const entries = this.registry.listServerSecurity();
    if (key === 'r') {
      this.markDirty();
      return true;
    }
    if (entries.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(entries.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' MCP Control Room', C.header, C.headerBg]]));

    const entries = this.registry.listServerSecurity();
    if (entries.length === 0) {
      lines.push(buildLine(width, [[' No MCP servers configured or connected. Use /mcp for setup hints.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    this.selectedIndex = Math.min(this.selectedIndex, entries.length - 1);
    const selected = entries[this.selectedIndex]!;
    const visible = entries.slice(0, Math.max(1, height - 6));

    for (let index = 0; index < visible.length; index++) {
      const entry = visible[index]!;
      const bg = index === this.selectedIndex ? C.selectBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [entry.name.padEnd(20), C.value, bg],
        [` ${(entry.connected ? 'CONNECTED' : 'DISCONNECTED').padEnd(13)}`, entry.connected ? C.ok : C.error, bg],
        [` ${entry.trustMode.padEnd(12)}`, modeColor(entry.trustMode), bg],
        [` ${entry.role.padEnd(10)}`, C.info, bg],
        [` ${entry.schemaFreshness}`, freshnessColor(entry.schemaFreshness), bg],
      ]));
    }

    lines.push(buildLine(width, [[' Details', C.label]]));
    lines.push(buildLine(width, [
      ['  Server: ', C.label],
      [selected.name, C.value],
      ['  Trust: ', C.label],
      [selected.trustMode, modeColor(selected.trustMode)],
      ['  Role: ', C.label],
      [selected.role, C.info],
    ]));
    lines.push(buildLine(width, [
      ['  Schema: ', C.label],
      [selected.schemaFreshness, freshnessColor(selected.schemaFreshness)],
      ['  Approved by: ', C.label],
      [(selected.quarantineApprovedBy ?? 'n/a').slice(0, Math.max(0, width - 31)), selected.quarantineApprovedBy ? C.info : C.dim],
    ]));
    lines.push(buildLine(width, [
      ['  Path scope: ', C.label],
      [(selected.allowedPaths.length > 0 ? selected.allowedPaths.join(', ') : 'unbounded').slice(0, Math.max(0, width - 15)), selected.allowedPaths.length > 0 ? C.value : C.dim],
    ]));
    lines.push(buildLine(width, [
      ['  Host scope: ', C.label],
      [(selected.allowedHosts.length > 0 ? selected.allowedHosts.join(', ') : 'unbounded').slice(0, Math.max(0, width - 15)), selected.allowedHosts.length > 0 ? C.value : C.dim],
    ]));
    if (selected.schemaFreshness === 'quarantined') {
      lines.push(buildLine(width, [
        ['  Quarantine: ', C.label],
        [`${selected.quarantineReason ?? 'unknown'}${selected.quarantineDetail ? ` — ${selected.quarantineDetail}` : ''}`.slice(0, Math.max(0, width - 15)), C.error],
      ]));
    }
    lines.push(buildLine(width, [['  Use /mcp role <server> <role> and /settings -> MCP to adjust security posture.', C.dim]]));

    const decisionLines = Math.max(0, height - lines.length);
    const decisions = this.registry.listRecentSecurityDecisions?.(Math.max(0, decisionLines - 1)) ?? [];
    if (decisionLines > 0) {
      lines.push(buildLine(width, [[' Recent Decisions', C.label]]));
    }
    if (decisionLines > 1 && decisions.length === 0) {
      lines.push(buildLine(width, [['  No MCP decisions recorded yet.', C.dim]]));
    }
    for (const decision of decisions.slice(0, Math.max(0, height - lines.length))) {
      const summary = `${decision.serverName}:${decision.toolName} ${decision.verdict.toUpperCase()} ${decision.capability}${decision.incoherent ? ' incoherent' : ''}`;
      lines.push(buildLine(width, [
        ['  ', C.label],
        [summary.slice(0, Math.max(0, width - 2)), decisionColor(decision)],
      ]));
    }

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
