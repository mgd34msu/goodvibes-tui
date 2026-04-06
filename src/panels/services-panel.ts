import type { Line, Cell } from '../types/grid.ts';
import { createEmptyLine, createStyledCell } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  ServiceRegistry,
  type ServiceConfig,
  type ServiceInspection,
  type ServiceConnectionTestResult,
} from '../config/service-registry.ts';

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

interface ServicePanelEntry {
  readonly name: string;
  readonly inspection: ServiceInspection;
  readonly lastTest?: ServiceConnectionTestResult;
}

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

function statusLabel(entry: ServicePanelEntry): string {
  if (!entry.inspection.hasPrimaryCredential) return 'UNCONFIGURED';
  if (entry.lastTest?.ok) return 'HEALTHY';
  if (entry.lastTest && !entry.lastTest.ok) return 'ERROR';
  return 'CONFIGURED';
}

function statusColor(entry: ServicePanelEntry): string {
  const label = statusLabel(entry);
  if (label === 'HEALTHY') return C.ok;
  if (label === 'ERROR') return C.error;
  if (label === 'CONFIGURED') return C.warn;
  return C.dim;
}

function authSummary(config: ServiceConfig): string {
  switch (config.authType) {
    case 'bearer':
      return 'bearer';
    case 'basic':
      return 'basic';
    case 'api-key':
      return config.apiKeyHeader ? `api-key:${config.apiKeyHeader}` : 'api-key';
  }
}

export class ServicesPanel extends BasePanel {
  private readonly registry: ServiceRegistry;
  private entries: ServicePanelEntry[] = [];
  private selectedIndex = 0;
  private loading = false;

  public constructor(registry: ServiceRegistry = new ServiceRegistry()) {
    super('services', 'Services', 'V', 'monitoring');
    this.registry = registry;
    void this.refresh();
  }

  public override onActivate(): void {
    super.onActivate();
    if (this.entries.length === 0 && !this.loading) {
      void this.refresh();
    }
  }

  public handleInput(key: string): boolean {
    if (key === 'r') {
      void this.refresh();
      return true;
    }
    if (this.entries.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 't') {
      void this.testSelected();
      return true;
    }
    return false;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.markDirty();
    const configs = this.registry.getAll();
    const names = Object.keys(configs).sort((a, b) => a.localeCompare(b));
    const inspections = await Promise.all(
      names.map(async (name) => ({
        name,
        inspection: (await this.registry.inspect(name))!,
      })),
    );
    const previousTests = new Map(this.entries.map((entry) => [entry.name, entry.lastTest] as const));
    this.entries = inspections.map((entry) => ({
      ...entry,
      ...(previousTests.get(entry.name) ? { lastTest: previousTests.get(entry.name) } : {}),
    }));
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1));
    this.loading = false;
    this.markDirty();
  }

  private async testSelected(): Promise<void> {
    const selected = this.entries[this.selectedIndex];
    if (!selected) return;
    const result = await this.registry.testConnection(selected.name);
    this.entries = this.entries.map((entry) => (
      entry.name === selected.name
        ? { ...entry, lastTest: result }
        : entry
    ));
    this.markDirty();
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const lines: Line[] = [];
    lines.push(buildLine(width, [[' Service Control Room', C.header, C.headerBg]]));

    if (this.loading && this.entries.length === 0) {
      lines.push(buildLine(width, [[' Loading configured services…', C.info]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    if (this.entries.length === 0) {
      lines.push(buildLine(width, [[' No services configured. Add entries to .goodvibes/tui/services.json and secrets via /secrets.', C.empty]]));
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    const bodyHeight = Math.max(1, height - 1);
    const visibleRows = Math.max(1, bodyHeight - 7);
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visibleRows / 2), this.entries.length - visibleRows));
    const visible = this.entries.slice(start, start + visibleRows);

    for (let index = 0; index < visible.length; index++) {
      const entry = visible[index]!;
      const absoluteIndex = start + index;
      const bg = absoluteIndex === this.selectedIndex ? C.selectBg : undefined;
      lines.push(buildLine(width, [
        [' ', C.label, bg],
        [entry.name.padEnd(16), C.value, bg],
        [` ${statusLabel(entry).padEnd(12)}`, statusColor(entry), bg],
        [` ${authSummary(entry.inspection.config).padEnd(18)}`, C.info, bg],
        [` ${entry.inspection.config.baseUrl ?? '(no baseUrl)'}`, C.dim, bg],
      ]));
    }

    const selected = this.entries[this.selectedIndex]!;
    const inspect = selected.inspection;
    lines.push(buildLine(width, [[' Details', C.label]]));
    lines.push(buildLine(width, [
      ['  Service: ', C.label],
      [selected.name, C.value],
      ['  State: ', C.label],
      [statusLabel(selected), statusColor(selected)],
      ['  Auth: ', C.label],
      [authSummary(inspect.config), C.info],
    ]));
    lines.push(buildLine(width, [
      ['  Primary credential: ', C.label],
      [inspect.hasPrimaryCredential ? 'present' : 'missing', inspect.hasPrimaryCredential ? C.ok : C.error],
      ['  Webhook URL: ', C.label],
      [inspect.hasWebhookUrl ? 'present' : 'missing', inspect.hasWebhookUrl ? C.ok : C.dim],
      ['  Signing secret: ', C.label],
      [inspect.hasSigningSecret ? 'present' : 'missing', inspect.hasSigningSecret ? C.ok : C.dim],
    ]));
    if (selected.lastTest) {
      lines.push(buildLine(width, [
        ['  Last test: ', C.label],
        [selected.lastTest.ok ? 'ok' : 'failed', selected.lastTest.ok ? C.ok : C.error],
        ['  Status: ', C.label],
        [selected.lastTest.status != null ? String(selected.lastTest.status) : 'n/a', C.value],
        ['  URL: ', C.label],
        [(selected.lastTest.testedUrl ?? 'n/a').slice(0, Math.max(0, width - 34)), C.dim],
      ]));
      if (selected.lastTest.error) {
        lines.push(buildLine(width, [
          ['  Error: ', C.label],
          [selected.lastTest.error.slice(0, Math.max(0, width - 10)), C.error],
        ]));
      }
    } else {
      lines.push(buildLine(width, [['  Press t to test the selected service or r to refresh credential status.', C.dim]]));
    }
    lines.push(buildLine(width, [['  Services resolve credentials through the encrypted secrets store and project-local config.', C.dim]]));

    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
