import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  type ServiceConfig,
  type ServiceInspection,
  type ServiceConnectionTestResult,
} from '@pellux/goodvibes-sdk/platform/config';
import type { ServiceInspectionQuery, SubscriptionAccessQuery } from '../runtime/ui-service-queries.ts';
import {
  buildDetailBlock,
  buildKeyValueLine,
  buildKeyboardHints,
  buildPanelLine,
  buildPanelWorkspace,
  buildStatusPill,
  DEFAULT_PANEL_PALETTE,
} from './polish.ts';

// Base chrome only — title band, state colors, and text tokens all come
// straight from DEFAULT_PANEL_PALETTE (WO-002).
const C = DEFAULT_PANEL_PALETTE;

interface ServicePanelEntry {
  readonly name: string;
  readonly inspection: ServiceInspection;
  readonly lastTest?: ServiceConnectionTestResult;
}

function statusLabel(entry: ServicePanelEntry): string {
  if (!entry.inspection.hasPrimaryCredential) return 'UNCONFIGURED';
  if (entry.lastTest?.ok) return 'HEALTHY';
  if (entry.lastTest && !entry.lastTest.ok) return 'ERROR';
  return 'CONFIGURED';
}

function statusColor(entry: ServicePanelEntry): string {
  const label = statusLabel(entry);
  if (label === 'HEALTHY') return C.good;
  if (label === 'ERROR') return C.bad;
  if (label === 'CONFIGURED') return C.warn;
  return C.dim;
}

function authSummary(config: ServiceConfig, manager: SubscriptionAccessQuery): string {
  const provider = config.providerId ?? config.name;
  const hasOverride = manager.getAccessToken(provider) != null;
  switch (config.authType) {
    case 'bearer':
      return hasOverride ? 'bearer+subscription' : 'bearer';
    case 'basic':
      return 'basic';
    case 'api-key':
      return hasOverride
        ? 'oauth-override'
        : config.apiKeyHeader ? `api-key:${config.apiKeyHeader}` : 'api-key';
    case 'oauth':
      return manager.get(provider) != null ? 'oauth(active)' : 'oauth';
  }
}

export class ServicesPanel extends ScrollableListPanel<ServicePanelEntry> {
  private readonly registry: ServiceInspectionQuery;
  private readonly subscriptionManager: SubscriptionAccessQuery;
  private entries: ServicePanelEntry[] = [];
  private loading = false;

  public constructor(
    registry: ServiceInspectionQuery,
    subscriptionManager: SubscriptionAccessQuery,
  ) {
    super('services', 'Services', 'V', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.filterEnabled = true;
    this.filterLabel = 'Filter services';
    this.registry = registry;
    this.subscriptionManager = subscriptionManager;
    void this.refresh();
  }

  protected override filterMatches(entry: ServicePanelEntry, q: string): boolean {
    return entry.name.toLowerCase().includes(q)
      || (entry.inspection.config.baseUrl ?? '').toLowerCase().includes(q);
  }

  public override onActivate(): void {
    super.onActivate();
    if (this.entries.length === 0 && !this.loading) {
      void this.refresh();
    }
  }

  protected override getPalette() { return C; }
  protected override getEmptyStateMessage() { return ' No services configured.'; }
  protected override getEmptyStateActions() {
    return [
      { command: '/services auth-review', summary: 'inspect service auth posture and registry config' },
      { command: '/subscription', summary: 'review provider login state and override posture' },
    ];
  }

  protected getItems(): readonly ServicePanelEntry[] {
    return this.entries;
  }

  protected renderItem(entry: ServicePanelEntry, index: number, selected: boolean, width: number): Line {
    const bg = selected ? C.selectBg : undefined;
    return buildPanelLine(width, [
      [' ', C.label, bg],
      [entry.name.padEnd(16), C.value, bg],
      [` ${statusLabel(entry).padEnd(12)}`, statusColor(entry), bg],
      [` ${authSummary(entry.inspection.config, this.subscriptionManager).padEnd(18)}`, C.info, bg],
      [` ${truncateDisplay(entry.inspection.config.baseUrl ?? '(no baseUrl)', Math.max(0, width - 48))}`, C.dim, bg],
    ]);
  }

  public handleInput(key: string): boolean {
    if (!this.filterActive) {
      if (key === 'r') {
        void this.refresh();
        return true;
      }
      if (key === 't') {
        void this.testSelected();
        return true;
      }
    }
    return super.handleInput(key);
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
    this.clampSelection();
    const intro = 'Credential posture, subscription overrides, and live connection checks for configured services.';

    if (this.loading && this.entries.length === 0) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Service Control Room',
        intro,
        sections: [{ lines: [buildPanelLine(width, [[' Loading configured services...', C.info]])] }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines;
    }

    // Health-summary header — surface the most important counts first.
    const counts = { healthy: 0, error: 0, configured: 0, unconfigured: 0 };
    for (const entry of this.entries) {
      const label = statusLabel(entry);
      if (label === 'HEALTHY') counts.healthy++;
      else if (label === 'ERROR') counts.error++;
      else if (label === 'CONFIGURED') counts.configured++;
      else counts.unconfigured++;
    }
    const headerLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'services', value: String(this.entries.length), valueColor: this.entries.length > 0 ? C.info : C.dim },
        { label: 'healthy', value: String(counts.healthy), valueColor: counts.healthy > 0 ? C.good : C.dim },
        { label: 'errors', value: String(counts.error), valueColor: counts.error > 0 ? C.bad : C.dim },
        { label: 'unconfigured', value: String(counts.unconfigured), valueColor: counts.unconfigured > 0 ? C.warn : C.dim },
      ], C),
    ];

    const selected = this.entries[this.selectedIndex];
    const detailRows: Line[] = [];
    if (selected) {
      const inspect = selected.inspection;
      detailRows.push(buildPanelLine(width, [
        ['  Service: ', C.label],
        [selected.name, C.value],
        ['  State: ', C.label],
        [statusLabel(selected), statusColor(selected)],
        ['  Auth: ', C.label],
        [authSummary(inspect.config, this.subscriptionManager), C.info],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Base URL: ', C.label],
        [truncateDisplay(inspect.config.baseUrl ?? '(no baseUrl)', Math.max(0, width - 13)), C.dim],
      ]));
      detailRows.push(buildPanelLine(width, [
        ['  Primary credential: ', C.label],
        ...buildStatusPill(inspect.hasPrimaryCredential ? 'good' : 'bad', inspect.hasPrimaryCredential ? 'present' : 'missing'),
        ['  Webhook URL: ', C.label],
        ...buildStatusPill(inspect.hasWebhookUrl ? 'good' : 'info', inspect.hasWebhookUrl ? 'present' : 'missing'),
        ['  Signing secret: ', C.label],
        ...buildStatusPill(inspect.hasSigningSecret ? 'good' : 'info', inspect.hasSigningSecret ? 'present' : 'missing'),
        ['  App token: ', C.label],
        ...buildStatusPill(inspect.hasAppToken ? 'good' : 'info', inspect.hasAppToken ? 'present' : 'missing'),
      ]));
      if (selected.lastTest) {
        detailRows.push(buildPanelLine(width, [
          ['  Last test: ', C.label],
          ...buildStatusPill(selected.lastTest.ok ? 'good' : 'bad', selected.lastTest.ok ? 'ok' : 'failed'),
          ['  Status: ', C.label],
          [selected.lastTest.status != null ? String(selected.lastTest.status) : 'n/a', C.value],
          ['  URL: ', C.label],
          [truncateDisplay(selected.lastTest.testedUrl ?? 'n/a', Math.max(0, width - 34)), C.dim],
        ]));
        if (selected.lastTest.error) {
          detailRows.push(buildPanelLine(width, [
            ['  Error: ', C.label],
            [truncateDisplay(selected.lastTest.error, Math.max(0, width - 10)), C.bad],
          ]));
        }
      } else {
        detailRows.push(buildPanelLine(width, [['  Not tested yet — press t to run a live connection check.', C.dim]]));
      }
    }

    // Context-aware hints: filter mode swaps to filter-specific keys; the test
    // key only makes sense when there is a service to test.
    const hints = this.filterActive
      ? [{ keys: 'type', label: 'filter' }, { keys: 'Enter', label: 'apply' }, { keys: 'Esc', label: 'clear' }]
      : [
          { keys: 'Up/Down', label: 'move' },
          ...(selected ? [{ keys: 't', label: 'test selected' }] : []),
          { keys: 'r', label: 'refresh' },
          { keys: '/', label: 'filter' },
        ];

    const footer: Line[] = selected
      ? [...buildDetailBlock(width, `Service · ${selected.name}`, detailRows, C), buildKeyboardHints(width, hints, C)]
      : [buildKeyboardHints(width, hints, C)];

    return this.renderList(width, height, {
      title: 'Service Control Room',
      header: headerLines,
      footer,
      emptyMessage: intro,
    });
  }
}
