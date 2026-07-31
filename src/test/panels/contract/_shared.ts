// ---------------------------------------------------------------------------
// src/test/panels/contract/_shared.ts
//
// Shared mocks, fixtures, and the parameterized BasePanel contract runner
// used by the per-panel modules in this directory (decongestion of
// the former migrated-panels-contract.test.ts). Every migrated panel must
// satisfy the BasePanel contract:
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
import type { BasePanel } from '../../../panels/base-panel.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types';

export function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('')).join('\n');
}

export function makeReadModelMock<T>(snapshot: T) {
  const subs: Array<() => void> = [];
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb: () => void) => { subs.push(cb); return () => {}; },
  };
}

export const EMPTY_SECURITY_SNAPSHOT = {
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

export const EMPTY_CONFIG_MANAGER = {
  getSnapshot: () => ({}),
  get: (_key: string) => undefined,
  getRaw: (_key: string) => undefined,
  getControlPlaneConfigDir: () => '/tmp/gv-test-config',
  getWorkingDirectory: () => '/tmp',
  getHomeDirectory: () => '/tmp',
} as unknown as import('../../../config/index.ts').ConfigManager;

export const EMPTY_SERVICE_QUERY = {
  getAll: () => ({} as Record<string, never>),
  inspect: async (_name: string) => null,
  testConnection: async (_name: string) => ({ ok: false, error: 'not connected', durationMs: 0 }),
} as unknown as import('@/runtime/index.ts').ServiceInspectionQuery;

export const EMPTY_SUBSCRIPTION_MANAGER = {
  list: () => [],
  listPending: () => [],
  get: (_p: string) => null,
  getPending: (_p: string) => null,
  logout: (_p: string) => {},
} as unknown as import('@pellux/goodvibes-sdk/platform/config').SubscriptionManager;

export const EMPTY_SERVICE_REGISTRY = {
  getAll: () => ({}),
} as unknown as import('@pellux/goodvibes-sdk/platform/config').ServiceRegistry;

export const EMPTY_PLUGIN_MANAGER = {
  list: () => [],
  getAll: () => [],
  subscribe: (_cb: () => void) => () => {},
  enable: async (_name: string) => ({ ok: false, error: 'not available in test fixture' }),
  disable: async (_name: string) => ({ ok: false, error: 'not available in test fixture' }),
  verify: (_name: string) => ({ ok: false, valid: false, reason: 'not available in test fixture' }),
  liftQuarantine: (_name: string) => ({ ok: false, error: 'not available in test fixture' }),
} as unknown as import('../../../panels/plugins-panel.ts').PluginManagerControls;

export const EMPTY_LOCAL_AUTH_MANAGER = {
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
} as unknown as import('@/runtime/index.ts').LocalAuthInspectionQuery;

export const EMPTY_OPS_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('@/runtime/index.ts').UiEventFeed<never>;

export const EMPTY_WORKTREE_REGISTRY = {
  list: async () => [],
  subscribe: (_cb: () => void) => () => {},
} as unknown as import('@/runtime/index.ts').WorktreeRegistry;

export const EMPTY_POLICY_RUNTIME_STATE = {
  getSnapshot: () => ({ recentPermissionAudit: [] }),
} as unknown as import('@/runtime/index.ts').PolicyRuntimeState;

export const EMPTY_MEMORY_REGISTRY = {
  search: (_opts?: unknown) => [],
  subscribe: (_cb: () => void) => () => {},
  reviewQueue: (_limit: number) => [],
  review: (_id: string, _opts: unknown) => {},
} as unknown as import('@pellux/goodvibes-sdk/platform/state').MemoryRegistry;

export const EMPTY_KNOWLEDGE_API = {
  sources: { list: (_limit?: number) => [] },
  graph: {
    nodes: { list: (_limit?: number) => [] },
    issues: {
      list: (_limit?: number) => [],
      review: async (_input: unknown) => { throw new Error('not implemented in EMPTY_KNOWLEDGE_API'); },
    },
    items: { search: (_query: string, _limit?: number) => [] },
  },
  jobs: { schedules: { list: (_limit?: number) => [] } },
} as unknown as import('@pellux/goodvibes-sdk/platform/knowledge').KnowledgeApi;

// The standalone hooks panel was retired in favor of the hooks modal (see
// panels/modals/hooks-modal.ts); HooksPanelWorkbenchView no longer exists.
// This fixture has no consumer left in the current codebase (nothing in
// src/panels imports it), so it's pointed at the modal's equivalent
// workbench type to keep it type-correct rather than deleting live test
// scaffolding — flagged for the coordinator in case a hooks-modal contract
// test wants to pick it up.
export const EMPTY_HOOKS_WORKBENCH = {
  listManagedHooks: () => [],
  listManagedChains: () => [],
  listRecentActions: () => [],
  listSimulationResults: () => [],
  getLastSimulation: () => null,
  getHooksFilePath: () => '/tmp/hooks.json',
  toggleManagedHook: (_name: string, _enabled: boolean) => false,
  removeManagedEntry: (_name: string) => false,
  simulate: (_eventPath: string) => ({ eventPath: _eventPath, matchedHooks: [], matchedChains: [], capturedAt: Date.now() }),
} as unknown as import('../../../panels/modals/hooks-modal.ts').HooksModalWorkbench;

export const EMPTY_TASKS_READ_MODEL = makeReadModelMock({
  tasks: [],
  totalCount: 0,
  runningCount: 0,
  pendingCount: 0,
  failedCount: 0,
  completedCount: 0,
  lastUpdatedAt: null,
});

export const EMPTY_SESSION_MEMORY_QUERY = {
  list: () => [],
} as unknown as import('@/runtime/index.ts').SessionMemoryQuery;

export const EMPTY_PROJECT_PLANNING_SERVICE = {
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

export const EMPTY_TURN_EVENT_FEED = {
  on: (_event: string, _cb: unknown) => () => {},
  onEnvelope: (_event: string, _cb: unknown) => () => {},
  emit: () => {},
} as unknown as import('@/runtime/index.ts').UiEventFeed<never>;

export const EMPTY_SERVICES_SUBSCRIPTION_QUERY = {
  list: () => [],
  listPending: () => [],
  get: (_p: string) => null,
  getPending: (_p: string) => null,
  getAccessToken: (_p: string) => null,
  logout: (_p: string) => {},
} as unknown as import('@/runtime/index.ts').SubscriptionAccessQuery;

export type PanelEntry = {
  readonly label: string;
  readonly factory: () => BasePanel;
  readonly hasSelectionGutter?: boolean;
  readonly skipHandleInput?: boolean;
};

export const W = 80;
export const H = 24;

/** Registers the standard BasePanel contract describe block for one panel entry. */
export function runBasePanelContractSuite(entry: PanelEntry): void {
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
        expect((panel as unknown as { showSelectionGutter: boolean }).showSelectionGutter).toBe(true);
      });
    }
  });
}
