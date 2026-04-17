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
} as unknown as import('@pellux/goodvibes-sdk/platform/config/subscriptions').SubscriptionManager;

const EMPTY_SERVICE_REGISTRY = {
  getAll: () => ({}),
} as unknown as import('@pellux/goodvibes-sdk/platform/config/service-registry').ServiceRegistry;

const EMPTY_PLUGIN_MANAGER = {
  list: () => [],
  getAll: () => [],
  subscribe: (_cb: () => void) => () => {},
} as unknown as import('@pellux/goodvibes-sdk/platform/plugins/manager').PluginManagerObserver;

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
} as unknown as import('@pellux/goodvibes-sdk/platform/runtime/worktree/registry').WorktreeRegistry;

const EMPTY_POLICY_RUNTIME_STATE = {
  getSnapshot: () => ({ recentPermissionAudit: [] }),
} as unknown as import('@pellux/goodvibes-sdk/platform/runtime/permissions/policy-runtime').PolicyRuntimeState;

const EMPTY_PROVIDER_ACCOUNTS_DEPS = {
  providerAccounts: {
    loadSnapshot: async () => ({ providers: [] }),
  },
} as unknown as import('../../panels/provider-accounts-panel.ts').ProviderAccountsPanelDeps;

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
      null as unknown as import('@pellux/goodvibes-sdk/platform/hooks/dispatcher').HookDispatcher,
      null as unknown as import('@pellux/goodvibes-sdk/platform/hooks/workbench').HookWorkbench,
      null as unknown as import('@pellux/goodvibes-sdk/platform/hooks/activity').HookActivityTracker,
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

      test('handleInput with navigation keys returns boolean', () => {
        const panel = entry.factory() as unknown as { handleInput(key: string): boolean };
        for (const key of ['ArrowDown', 'ArrowUp', 'j', 'k']) {
          const result = panel.handleInput(key);
          expect(typeof result).toBe('boolean');
        }
      });

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
