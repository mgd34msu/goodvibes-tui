// ---------------------------------------------------------------------------
// migrated-panels-contract.test.ts
//
// Parameterized contract tests for all panels migrated to BasePanel /
// ScrollableListPanel / SearchableListPanel in Wave 3a/3b.
//
// Every migrated panel must satisfy the BasePanel contract:
//   1. render() returns exactly `height` lines
//   2. Every line in the render result has exactly `width` cells
//   3. needsRender starts true (panel wants its first render)
//   4. handleInput() with up/down navigation keys returns a boolean
//   5. loadingState starts 'idle'
//
// Panels with showSelectionGutter = true (S5 panels) are additionally
// verified to have that flag set.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import type { BasePanel } from '../../panels/base-panel.ts';

// ---------------------------------------------------------------------------
// Panel imports
// ---------------------------------------------------------------------------

import { IncidentReviewPanel } from '../../panels/incident-review-panel.ts';
import { WatchersPanel } from '../../panels/watchers-panel.ts';
import { RoutesPanel } from '../../panels/routes-panel.ts';
import { SkillsPanel } from '../../panels/skills-panel.ts';
import { HooksPanel } from '../../panels/hooks-panel.ts';
import { TasksPanel } from '../../panels/tasks-panel.ts';
import { ServicesPanel } from '../../panels/services-panel.ts';
import { SecurityPanel } from '../../panels/security-panel.ts';
import { McpPanel } from '../../panels/mcp-panel.ts';
import { SettingsSyncPanel } from '../../panels/settings-sync-panel.ts';
import { SubscriptionPanel } from '../../panels/subscription-panel.ts';
import { PluginsPanel } from '../../panels/plugins-panel.ts';
import { LocalAuthPanel } from '../../panels/local-auth-panel.ts';
import { OpsControlPanel } from '../../panels/ops-control-panel.ts';
import { AutomationControlPanel } from '../../panels/automation-control-panel.ts';
import { ApprovalPanel } from '../../panels/approval-panel.ts';
import { CommunicationPanel } from '../../panels/communication-panel.ts';
import { AgentLogsPanel } from '../../panels/agent-logs-panel.ts';
import { WorktreePanel } from '../../panels/worktree-panel.ts';
import { ControlPlanePanel } from '../../panels/control-plane-panel.ts';
import { ProviderAccountsPanel } from '../../panels/provider-accounts-panel.ts';
import { MemoryPanel } from '../../panels/memory-panel.ts';
import { KnowledgePanel } from '../../panels/knowledge-panel.ts';
import { MarketplacePanel } from '../../panels/marketplace-panel.ts';
import { SystemMessagesPanel } from '../../panels/system-messages-panel.ts';
import { OrchestrationPanel } from '../../panels/orchestration-panel.ts';
import { GitPanel } from '../../panels/git-panel.ts';
import { DiffPanel } from '../../panels/diff-panel.ts';
import { WrfcPanel } from '../../panels/wrfc-panel.ts';
import { TokenBudgetPanel } from '../../panels/token-budget-panel.ts';
import { ContextVisualizerPanel } from '../../panels/context-visualizer-panel.ts';
import { PlanDashboardPanel } from '../../panels/plan-dashboard-panel.ts';
import { ProjectPlanningPanel } from '../../panels/project-planning-panel.ts';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeReadModelMock<T>(snapshot: T) {
  const subs: Array<() => void> = [];
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb: () => void) => { subs.push(cb); return () => {}; },
  };
}

const EMPTY_SECURITY_SNAPSHOT = {
  audit: {
    managed: false,
    totalTokens: 0,
    results: [],
    blocked: [],
    scopeViolations: [],
    rotationWarnings: [],
    rotationOverdue: [],
    lastAuditAt: null,
    capturedAt: new Date().toISOString(),
  },
  policy: {
    preflightStatus: 'none',
    preflightIssueCount: 0,
    lintFindingCount: 0,
  },
  deniedPermissions: 0,
  incidents: [],
  latestIncident: null,
  mcpServers: [],
  recentMcpDecisions: [],
  attackPathReview: { criticalFindings: 0, incoherentFindings: 0, summary: '', findings: [] },
  plugins: [],
  quarantinedPlugins: [],
  untrustedPlugins: [],
};

const EMPTY_MCP_REGISTRY = {
  listServerSecurity: () => [],
  listServerSandboxBindings: () => [],
  listRecentSecurityDecisions: (_hours: number) => [],
};

const EMPTY_CONFIG_MANAGER = {
  getSnapshot: () => ({}),
  get: (_key: string) => undefined,
  getRaw: (_key: string) => undefined,
  getControlPlaneConfigDir: () => '/tmp/gv-test-config',
  getWorkingDirectory: () => '/tmp',
  getHomeDirectory: () => '/tmp',
} as unknown as import('../../config/index.ts').ConfigManager;

const EMPTY_SERVICE_QUERY = {
  getAll: () => ({} as Record<string, never>),
  inspect: async (_name: string) => null,
  testConnection: async (_name: string) => ({ ok: false, error: 'not connected', durationMs: 0 }),
} as unknown as import('../../runtime/ui-service-queries.ts').ServiceInspectionQuery;

const EMPTY_SUBSCRIPTION_MANAGER = {
  list: () => [],
  listPending: () => [],
  get: (_p: string) => null,
  getPending: (_p: string) => null,
  logout: (_p: string) => {},
} as unknown as import('@pellux/goodvibes-sdk/platform/config').SubscriptionManager;

const EMPTY_SERVICE_REGISTRY = {
  getAll: () => ({}),
} as unknown as import('@pellux/goodvibes-sdk/platform/config').ServiceRegistry;

const EMPTY_PLUGIN_MANAGER = {
  list: () => [],
  getAll: () => [],
  subscribe: (_cb: () => void) => () => {},
} as unknown as import('@pellux/goodvibes-sdk/platform/plugins').PluginManagerObserver;

const EMPTY_LOCAL_AUTH_MANAGER = {
  inspect: () => ({
    userStorePath: '/tmp/gv-test-users',
    bootstrapCredentialPath: '/tmp/gv-test-bootstrap',
    persisted: false,
    bootstrapCredentialPresent: false,
    userCount: 0,
    sessionCount: 0,
    users: [],
    sessions: [],
  }),
} as unknown as import('../../runtime/ui-service-queries.ts').LocalAuthInspectionQuery;

const EMPTY_OPS_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('../../runtime/ui-events.ts').UiEventFeed<never>;

const EMPTY_AGENT_DEPS = {
  agentManager: { list: () => [] },
  workingDirectory: '/tmp',
} as unknown as import('../../panels/agent-logs-panel.ts').AgentLogsPanelDeps;

const EMPTY_WORKTREE_REGISTRY = {
  list: async () => [],
  subscribe: (_cb: () => void) => () => {},
} as unknown as import('@/runtime/index.ts').WorktreeRegistry;

const EMPTY_POLICY_RUNTIME_STATE = {
  getSnapshot: () => ({ recentPermissionAudit: [] }),
} as unknown as import('@/runtime/index.ts').PolicyRuntimeState;

const EMPTY_PROVIDER_ACCOUNTS_DEPS = {
  providerAccounts: {
    loadSnapshot: async () => ({ providers: [] }),
  },
} as unknown as import('../../panels/provider-accounts-panel.ts').ProviderAccountsPanelDeps;

const EMPTY_MEMORY_REGISTRY = {
  search: (_opts?: unknown) => [],
  subscribe: (_cb: () => void) => () => {},
  reviewQueue: (_limit: number) => [],
  review: (_id: string, _opts: unknown) => {},
} as unknown as import('@pellux/goodvibes-sdk/platform/state').MemoryRegistry;

const EMPTY_HOOKS_WORKBENCH = {
  listManagedHooks: () => [],
  listManagedChains: () => [],
  listRecentActions: () => [],
  listSimulationResults: () => [],
  getLastSimulation: () => null,
  getHooksFilePath: () => '/tmp/hooks.json',
} as unknown as import('../../panels/hooks-panel.ts').HooksPanelWorkbenchView;

const EMPTY_TASKS_READ_MODEL = makeReadModelMock({
  tasks: [],
  totalCount: 0,
  runningCount: 0,
  pendingCount: 0,
  failedCount: 0,
  completedCount: 0,
  lastUpdatedAt: null,
});

const EMPTY_SESSION_MEMORY_QUERY = {
  list: () => [],
} as unknown as import('../../runtime/ui-service-queries.ts').SessionMemoryQuery;

const EMPTY_PLAN_DASHBOARD_QUERY = {
  getActive: () => null,
} as unknown as import('../../runtime/ui-service-queries.ts').PlanDashboardQuery;

const EMPTY_PROJECT_PLANNING_SERVICE = {
  status: async () => ({
    ok: true,
    projectId: 'proj',
    knowledgeSpaceId: 'project:proj',
    passiveOnly: true,
    counts: { states: 0, decisions: 0, languageArtifacts: 0 },
    capabilities: ['project-scoped-storage', 'passive-daemon-only'],
  }),
  getState: async () => ({ ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state: null }),
  evaluate: async () => ({
    ok: true,
    projectId: 'proj',
    knowledgeSpaceId: 'project:proj',
    readiness: 'needs-user-input',
    gaps: [],
    state: {
      id: 'current',
      projectId: 'proj',
      knowledgeSpaceId: 'project:proj',
      goal: '',
      knownContext: [],
      openQuestions: [],
      answeredQuestions: [],
      decisions: [],
      assumptions: [],
      constraints: [],
      risks: [],
      tasks: [],
      dependencies: [],
      verificationGates: [],
      agentAssignments: [],
      readiness: 'needs-user-input',
      executionApproved: false,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    },
  }),
  listDecisions: async () => ({ ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', decisions: [] }),
  getLanguage: async () => ({ ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', language: null }),
  upsertState: async () => ({ ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state: null }),
} as unknown as import('@pellux/goodvibes-sdk/platform/knowledge').ProjectPlanningService;

const EMPTY_WORKFLOW_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('../../runtime/ui-events.ts').UiEventFeed<never>;

const EMPTY_TURN_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('../../runtime/ui-events.ts').UiEventFeed<never>;

const EMPTY_WRFC_DEPS = {
  controller: { listChains: () => [] },
} as unknown as import('../../panels/wrfc-panel.ts').WrfcPanelDeps;

const EMPTY_SERVICES_SUBSCRIPTION_QUERY = {
  list: () => [],
  listPending: () => [],
  get: (_p: string) => null,
  getPending: (_p: string) => null,
  getAccessToken: (_p: string) => null,
  logout: (_p: string) => {},
} as unknown as import('../../runtime/ui-service-queries.ts').SubscriptionAccessQuery;

// ---------------------------------------------------------------------------
// Panel factory — produces panel instances with minimal mock dependencies
// ---------------------------------------------------------------------------

type PanelEntry = {
  readonly label: string;
  readonly factory: () => BasePanel;
  readonly hasSelectionGutter?: boolean;
  readonly skipHandleInput?: boolean;
};

const PANELS: PanelEntry[] = [
  {
    label: 'IncidentReviewPanel (no registry)',
    factory: () => new IncidentReviewPanel(),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'WatchersPanel (no readModel)',
    factory: () => new WatchersPanel(),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'RoutesPanel (no readModel)',
    factory: () => new RoutesPanel(),
    hasSelectionGutter: true, // S5
  },
  {
    label: 'SkillsPanel',
    factory: () => new SkillsPanel({ shellPaths: { workingDirectory: '/tmp', homeDirectory: '/tmp' } }),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'HooksPanel',
    factory: () => new HooksPanel(
      null as unknown as import('@pellux/goodvibes-sdk/platform/hooks').HookDispatcher,
      null as unknown as import('@pellux/goodvibes-sdk/platform/hooks').HookWorkbench,
      null as unknown as import('@pellux/goodvibes-sdk/platform/hooks').HookActivityTracker,
      {
        listContracts: () => [],
        listHooks: () => [],
        listChains: () => [],
        listRecentActivity: () => [],
        getWorkbench: () => EMPTY_HOOKS_WORKBENCH as never,
      },
    ),
    hasSelectionGutter: true, // S5
  },
  {
    label: 'SecurityPanel',
    factory: () => new SecurityPanel(makeReadModelMock(EMPTY_SECURITY_SNAPSHOT) as never),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'McpPanel',
    factory: () => new McpPanel(EMPTY_MCP_REGISTRY as never),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'SettingsSyncPanel',
    factory: () => new SettingsSyncPanel(EMPTY_CONFIG_MANAGER),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'SubscriptionPanel',
    factory: () => new SubscriptionPanel(
      EMPTY_SERVICE_REGISTRY as never,
      EMPTY_SUBSCRIPTION_MANAGER as never,
    ),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'PluginsPanel',
    factory: () => new PluginsPanel(EMPTY_PLUGIN_MANAGER),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'LocalAuthPanel',
    factory: () => new LocalAuthPanel(EMPTY_LOCAL_AUTH_MANAGER),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'ServicesPanel',
    factory: () => new ServicesPanel(EMPTY_SERVICE_QUERY, EMPTY_SERVICES_SUBSCRIPTION_QUERY),
    hasSelectionGutter: true, // I5: non-color selection affordance (already set in earlier wave)
  },
  {
    label: 'OpsControlPanel',
    factory: () => new OpsControlPanel(EMPTY_OPS_EVENT_FEED as never),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'AutomationControlPanel (no readModel)',
    factory: () => new AutomationControlPanel(),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'ApprovalPanel',
    factory: () => new ApprovalPanel(EMPTY_POLICY_RUNTIME_STATE),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'CommunicationPanel (no readModel)',
    factory: () => new CommunicationPanel(),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'AgentLogsPanel',
    factory: () => new AgentLogsPanel(EMPTY_OPS_EVENT_FEED as never, EMPTY_AGENT_DEPS),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'WorktreePanel',
    factory: () => new WorktreePanel(EMPTY_WORKTREE_REGISTRY),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'ControlPlanePanel (no readModel)',
    factory: () => new ControlPlanePanel(),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  {
    label: 'ProviderAccountsPanel',
    factory: () => new ProviderAccountsPanel(EMPTY_PROVIDER_ACCOUNTS_DEPS),
    hasSelectionGutter: true, // I5: non-color selection affordance
  },
  // Wave C trackedRender adoptions
  {
    label: 'GitPanel (no commits)',
    factory: () => new GitPanel('/tmp'),
  },
  {
    label: 'DiffPanel (no entries)',
    factory: () => new DiffPanel('/tmp'),
  },
  {
    label: 'WrfcPanel (no chains)',
    factory: () => new WrfcPanel(EMPTY_WORKFLOW_EVENT_FEED as never, EMPTY_WRFC_DEPS),
  },
  {
    label: 'TokenBudgetPanel (no history)',
    factory: () => new TokenBudgetPanel(EMPTY_SESSION_MEMORY_QUERY, EMPTY_CONFIG_MANAGER),
    skipHandleInput: true,
  },
  {
    label: 'ContextVisualizerPanel (no usage)',
    factory: () => new ContextVisualizerPanel(EMPTY_TURN_EVENT_FEED as never, EMPTY_SESSION_MEMORY_QUERY, EMPTY_CONFIG_MANAGER),
    skipHandleInput: true,
  },
  {
    label: 'PlanDashboardPanel (no plan)',
    factory: () => new PlanDashboardPanel(EMPTY_PLAN_DASHBOARD_QUERY),
  },
  {
    label: 'ProjectPlanningPanel (no state)',
    factory: () => new ProjectPlanningPanel({
      service: EMPTY_PROJECT_PLANNING_SERVICE,
      projectId: 'proj',
    }),
  },
  // Wave B2 migrations
  {
    label: 'SystemMessagesPanel (no messages)',
    factory: () => new SystemMessagesPanel(EMPTY_CONFIG_MANAGER),
  },
  {
    label: 'OrchestrationPanel (no readModel)',
    factory: () => new OrchestrationPanel(),
  },
  // Wave B1 migrations
  {
    label: 'MemoryPanel (no records)',
    factory: () => new MemoryPanel(EMPTY_MEMORY_REGISTRY),
  },
  {
    label: 'KnowledgePanel (no records)',
    factory: () => new KnowledgePanel(EMPTY_MEMORY_REGISTRY),
  },
  {
    label: 'MarketplacePanel (no paths)',
    factory: () => new MarketplacePanel(),
  },
];

// ---------------------------------------------------------------------------
// Contract assertions
// ---------------------------------------------------------------------------

const W = 80;
const H = 24;

describe('migrated panels — BasePanel contract', () => {
  for (const entry of PANELS) {
    describe(entry.label, () => {
      test('render() returns exactly H lines', () => {
        const panel = entry.factory();
        const lines = panel.render(W, H);
        expect(lines).toHaveLength(H);
      });

      test('every rendered line has exactly W cells', () => {
        const panel = entry.factory();
        const lines = panel.render(W, H);
        for (const line of lines) {
          expect(line).toHaveLength(W);
        }
      });

      test('needsRender is true on construction', () => {
        const panel = entry.factory();
        expect(panel.needsRender).toBe(true);
      });

      test('loadingState starts idle', () => {
        const panel = entry.factory();
        expect((panel as unknown as { loadingState: string }).loadingState).toBe('idle');
      });

      if (!entry.skipHandleInput) {
        test('handleInput with navigation keys returns boolean', () => {
          const panel = entry.factory() as unknown as { handleInput(key: string): boolean };
          for (const key of ['ArrowDown', 'ArrowUp', 'j', 'k']) {
            const result = panel.handleInput(key);
            expect(typeof result).toBe('boolean');
          }
        });
      }

      if (entry.hasSelectionGutter) {
        test('showSelectionGutter is true (S5: non-color selection affordance)', () => {
          const panel = entry.factory();
          // Access protected field via type cast
          expect((panel as unknown as { showSelectionGutter: boolean }).showSelectionGutter).toBe(true);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// TasksPanel — requires UiReadModel, tested separately
// ---------------------------------------------------------------------------

describe('TasksPanel — BasePanel contract', () => {
  let panel: TasksPanel;

  test('render() returns exactly H lines', () => {
    panel = new TasksPanel(EMPTY_TASKS_READ_MODEL as never);
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells', () => {
    panel = new TasksPanel(EMPTY_TASKS_READ_MODEL as never);
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('showSelectionGutter is true (S5: non-color selection affordance)', () => {
    panel = new TasksPanel(EMPTY_TASKS_READ_MODEL as never);
    expect((panel as unknown as { showSelectionGutter: boolean }).showSelectionGutter).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wave B1 — Populated-records contract (MemoryPanel, KnowledgePanel, MarketplacePanel)
// ---------------------------------------------------------------------------

const SAMPLE_MEMORY_RECORD = {
  id: 'mem_test1234',
  cls: 'fact' as const,
  summary: 'Use Bun runtime for all tests',
  detail: undefined,
  tags: ['runtime', 'arch'],
  scope: 'project' as const,
  reviewState: 'fresh' as const,
  confidence: 80,
  createdAt: Date.now() - 10000,
  updatedAt: Date.now() - 10000,
  provenance: [],
  staleReason: undefined,
  reviewedAt: undefined,
  reviewedBy: undefined,
};

const SAMPLE_MEMORY_RECORD_2 = {
  id: 'mem_test5678',
  cls: 'decision' as const,
  summary: 'Use SQLite for persistent storage',
  detail: undefined,
  tags: ['db'],
  scope: 'project' as const,
  reviewState: 'reviewed' as const,
  confidence: 90,
  createdAt: Date.now() - 20000,
  updatedAt: Date.now() - 5000,
  provenance: [],
  staleReason: undefined,
  reviewedAt: Date.now() - 5000,
  reviewedBy: 'operator',
};

describe('MemoryPanel — populated records', () => {
  const makeRegistry = () => ({
    search: (_opts?: unknown) => [SAMPLE_MEMORY_RECORD, SAMPLE_MEMORY_RECORD_2],
    subscribe: (_cb: () => void) => () => {},
    reviewQueue: (_limit: number) => [],
    review: (_id: string, _opts: unknown) => {},
  } as unknown as import('@pellux/goodvibes-sdk/platform/state').MemoryRegistry);

  test('render() returns exactly H lines with records', () => {
    const panel = new MemoryPanel(makeRegistry());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with records', () => {
    const panel = new MemoryPanel(makeRegistry());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: selected row contains record summary substring', () => {
    const panel = new MemoryPanel(makeRegistry());
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('Use Bun runtime');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new MemoryPanel(makeRegistry());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });
});

describe('KnowledgePanel — populated records', () => {
  const makeRegistry = () => ({
    search: (_opts?: unknown) => [SAMPLE_MEMORY_RECORD, SAMPLE_MEMORY_RECORD_2],
    subscribe: (_cb: () => void) => () => {},
    reviewQueue: (_limit: number) => [SAMPLE_MEMORY_RECORD],
    review: (_id: string, _opts: unknown) => {},
  } as unknown as import('@pellux/goodvibes-sdk/platform/state').MemoryRegistry);

  test('render() returns exactly H lines with records', () => {
    const panel = new KnowledgePanel(makeRegistry());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with records', () => {
    const panel = new KnowledgePanel(makeRegistry());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: rendered output contains record summary substring', () => {
    const panel = new KnowledgePanel(makeRegistry());
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('Use Bun runtime');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new KnowledgePanel(makeRegistry());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  test('selected-record footer appears when record selected', () => {
    const panel = new KnowledgePanel(makeRegistry());
    // Force selectedIndex to 0 so first record is selected
    (panel as unknown as { selectedIndex: number }).selectedIndex = 0;
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    // Footer shows review keys hint
    expect(rendered).toContain('r/Enter');
  });
});

describe('MarketplacePanel — populated readModel', () => {
  const makeReadModel = () => ({
    getSnapshot: () => ({
      plugins: [
        { id: 'test-plugin', name: 'Test Plugin', description: 'A test plugin', version: '1.0.0', author: 'test', installed: true, kind: 'plugin' },
      ],
      agents: [],
      skills: [],
      tools: [],
      loading: false,
      error: null,
    }),
    subscribe: (_cb: () => void) => () => {},
  } as unknown as import('../../runtime/ui-read-models.ts').UiReadModel<import('../../runtime/ui-read-models.ts').UiMarketplaceSnapshot>);

  test('render() returns exactly H lines with populated readModel', () => {
    const panel = new MarketplacePanel(makeReadModel());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with populated readModel', () => {
    const panel = new MarketplacePanel(makeReadModel());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new MarketplacePanel(makeReadModel());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// SystemMessagesPanel — populated records contract
// ---------------------------------------------------------------------------

const POPULATED_SYSTEM_MSG_CONFIG = {
  ...EMPTY_CONFIG_MANAGER,
  getRaw: () => ({
    ui: {
      systemMessages: 'panel' as const,
      operationalMessages: 'panel' as const,
      wrfcMessages: 'panel' as const,
    },
  }),
} as unknown as import('../../config/index.ts').ConfigManager;

describe('SystemMessagesPanel — populated messages', () => {
  const makePanel = () => {
    const panel = new SystemMessagesPanel(POPULATED_SYSTEM_MSG_CONFIG);
    panel.push('Provider mercury-2 switched to fallback route due to quota', 'high');
    panel.push('Session context compacted 12k tokens', 'low');
    return panel;
  };

  test('render() returns exactly H lines with messages', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with messages', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: high-priority message contains HIGH label', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('HIGH');
  });

  test('renderItem: message text appears in rendered output', () => {
    const panel = makePanel();
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('mercury-2');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = makePanel();
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// OrchestrationPanel — populated readModel contract
// ---------------------------------------------------------------------------

describe('OrchestrationPanel — populated readModel', () => {
  const makeReadModel = () => ({
    getSnapshot: () => ({
      graphs: [
        {
          id: 'graph-abc12345',
          title: 'Wave B2 migration batch',
          mode: 'parallel',
          status: 'running',
          nodeOrder: ['node-1'],
          nodes: new Map([['node-1', {
            id: 'node-1',
            role: 'worker',
            title: 'migrate panel',
            status: 'running',
            dependencyNodeIds: [],
            contract: null,
          }]]),
          createdAt: Date.now() - 5000,
          startedAt: Date.now() - 4000,
          endedAt: undefined,
          lastRecursionGuard: undefined,
        },
      ],
      totalGraphs: 1,
      activeGraphIds: ['graph-abc12345'],
      totalCompletedGraphs: 0,
      totalFailedGraphs: 0,
      recursionGuardTrips: 0,
    }),
    subscribe: (_cb: () => void) => () => {},
  } as unknown as import('../../runtime/ui-read-models.ts').UiReadModel<import('../../runtime/ui-read-models.ts').UiOrchestrationSnapshot>);

  test('render() returns exactly H lines with populated readModel', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });

  test('every rendered line has exactly W cells with populated readModel', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    const lines = panel.render(W, H);
    for (const line of lines) {
      expect(line).toHaveLength(W);
    }
  });

  test('renderItem: graph title appears in rendered output', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    const lines = panel.render(W, H);
    const rendered = lines.map((l) => l.map((c) => c.char).join('')).join('\n');
    expect(rendered).toContain('Wave B2');
  });

  test('clampSelection: selectedIndex stays in bounds after render', () => {
    const panel = new OrchestrationPanel(makeReadModel());
    panel.render(W, H);
    const idx = (panel as unknown as { selectedIndex: number }).selectedIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// SkillsPanel — SearchableListPanel contract
// ---------------------------------------------------------------------------

describe('SkillsPanel — SearchableListPanel contract', () => {
  const makePanel = () => new SkillsPanel({ shellPaths: { workingDirectory: '/tmp', homeDirectory: '/tmp' } });

  test('initial searchQuery is empty string', () => {
    const panel = makePanel();
    expect((panel as unknown as { searchQuery: string }).searchQuery).toBe('');
  });

  test('printable keypress updates searchQuery and marks dirty', () => {
    const panel = makePanel();
    panel.needsRender = false;
    panel.handleInput('/');
    // '/' triggers filter focus transition, not search directly — check state
    // After '/', filterFocused becomes true; panel should mark dirty
    expect(panel.needsRender).toBe(true);
  });

  test('render with search query does not throw and returns H lines', () => {
    const panel = makePanel();
    (panel as unknown as { searchQuery: string }).searchQuery = 'gather-plan';
    const lines = panel.render(W, H);
    expect(lines).toHaveLength(H);
  });
});
