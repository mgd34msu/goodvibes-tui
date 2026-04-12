import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  ServiceRegistry,
  type ServiceConfig,
  type ServiceInspection,
  type ServiceConnectionTestResult,
} from '../config/service-registry.ts';
import { SubscriptionManager } from '../config/subscriptions.ts';
import {
  buildEmptyState,
  buildPanelLine,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  resolvePrimaryScrollableSection,
  type PanelWorkspaceSection,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
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

function authSummary(config: ServiceConfig, manager: SubscriptionManager): string {
  const provider = config.providerId ?? config.name;
  const hasActiveSubscription = manager.get(provider) != null;
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
      return hasActiveSubscription ? 'oauth(active)' : 'oauth';
  }
}

export class ServicesPanel extends BasePanel {
  private readonly registry: ServiceRegistry;
  private readonly subscriptionManager: SubscriptionManager;
  private entries: ServicePanelEntry[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private loading = false;

  public constructor(
    registry: ServiceRegistry,
    subscriptionManager: SubscriptionManager,
  ) {
    super('services', 'Services', 'V', 'monitoring');
    this.registry = registry;
    this.subscriptionManager = subscriptionManager;
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

    if (this.entries.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Service Control Room',
        intro,
        sections: [{
          lines: buildEmptyState(
            width,
            ' No services configured.',
            'Add entries to .goodvibes/tui/services.json and store secrets before using service-backed product flows.',
            [
              { command: '/services auth-review', summary: 'inspect service auth posture and registry config' },
              { command: '/subscription', summary: 'review provider login state and override posture' },
            ],
            C,
          ),
        }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    const selected = this.entries[this.selectedIndex]!;
    const inspect = selected.inspection;
    const detailLines: Line[] = [
      buildPanelLine(width, [
        ['  Service: ', C.label],
        [selected.name, C.value],
        ['  State: ', C.label],
        [statusLabel(selected), statusColor(selected)],
        ['  Auth: ', C.label],
        [authSummary(inspect.config, this.subscriptionManager), C.info],
      ]),
      buildPanelLine(width, [
        ['  Primary credential: ', C.label],
        [inspect.hasPrimaryCredential ? 'present' : 'missing', inspect.hasPrimaryCredential ? C.ok : C.error],
        ['  Webhook URL: ', C.label],
        [inspect.hasWebhookUrl ? 'present' : 'missing', inspect.hasWebhookUrl ? C.ok : C.dim],
        ['  Signing secret: ', C.label],
        [inspect.hasSigningSecret ? 'present' : 'missing', inspect.hasSigningSecret ? C.ok : C.dim],
      ]),
    ];
    if (selected.lastTest) {
      detailLines.push(buildPanelLine(width, [
        ['  Last test: ', C.label],
        [selected.lastTest.ok ? 'ok' : 'failed', selected.lastTest.ok ? C.ok : C.error],
        ['  Status: ', C.label],
        [selected.lastTest.status != null ? String(selected.lastTest.status) : 'n/a', C.value],
        ['  URL: ', C.label],
        [(selected.lastTest.testedUrl ?? 'n/a').slice(0, Math.max(0, width - 34)), C.dim],
      ]));
      if (selected.lastTest.error) {
        detailLines.push(buildPanelLine(width, [
          ['  Error: ', C.label],
          [selected.lastTest.error.slice(0, Math.max(0, width - 10)), C.error],
        ]));
      }
    } else {
      detailLines.push(buildPanelLine(width, [['  Press t to test the selected service or r to refresh credential status.', C.dim]]));
    }
    detailLines.push(buildPanelLine(width, [['  Services resolve credentials through hierarchy-aware secure storage, plaintext fallback policy, and project-local config.', C.dim]]));
    const detailSection: PanelWorkspaceSection = { title: 'Details', lines: detailLines };
    const resolvedServicesSection = resolvePrimaryScrollableSection(width, height, {
      intro,
      footerLines: [buildPanelLine(width, [['  Up/Down move  t test selected service  r refresh inspections', C.dim]])],
      palette: C,
      section: {
        title: 'Services',
        scrollableLines: this.entries.map((entry, absolute) => {
          const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
          return buildPanelLine(width, [
            [' ', C.label, bg],
            [entry.name.padEnd(16), C.value, bg],
            [` ${statusLabel(entry).padEnd(12)}`, statusColor(entry), bg],
            [` ${authSummary(entry.inspection.config, this.subscriptionManager).padEnd(18)}`, C.info, bg],
            [` ${entry.inspection.config.baseUrl ?? '(no baseUrl)'}`, C.dim, bg],
          ]);
        }),
        selectedIndex: this.selectedIndex,
        scrollOffset: this.scrollOffset,
        guardRows: 1,
        minRows: 4,
        appendWindowSummary: { dimColor: C.dim },
      },
      afterSections: [detailSection],
    });
    this.scrollOffset = resolvedServicesSection.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      resolvedServicesSection.section,
      detailSection,
    ];
    const lines = buildPanelWorkspace(width, height, {
      title: 'Service Control Room',
      intro,
      sections,
      footerLines: [buildPanelLine(width, [['  Up/Down move  t test selected service  r refresh inspections', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
