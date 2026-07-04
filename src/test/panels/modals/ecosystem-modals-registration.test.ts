import { describe, test, expect } from 'bun:test';
import {
  ECOSYSTEM_MODAL_REDIRECTS,
  registerEcosystemModalRedirects,
  type BoundModalSurface,
  type EcosystemModalRegistrar,
} from '../../../panels/modals/modal-surface.ts';
import {
  buildEcosystemModalSurfaces,
  registerEcosystemModals,
  type EcosystemModalDeps,
} from '../../../panels/modals/ecosystem-modals.ts';
import type { PanelManager } from '../../../panels/panel-manager.ts';

// The 13 group-B surfaces this WO owns (12 new modals + the sessions fold).
const EXPECTED_REDIRECTS: ReadonlyArray<readonly [string, string]> = [
  ['marketplace', 'marketplace'],
  ['plugins', 'plugins'],
  ['skills', 'skills'],
  ['hooks', 'hooks'],
  ['policy', 'policy'],
  ['security', 'security'],
  ['knowledge', 'knowledge'],
  ['memory', 'memory'],
  ['docs', 'keybindings'],
  ['qr-code', 'pairing'],
  ['work-plan', 'work-plan'],
  ['project-planning', 'planning'],
  ['sessions', 'sessionPicker'],
];

// The 12 modal-config surfaces (sessions folds into the existing session
// picker, so it has no builder here).
const EXPECTED_MODAL_NAMES = [
  'marketplace', 'plugins', 'skills', 'hooks', 'security', 'policy',
  'knowledge', 'memory', 'work-plan', 'keybindings', 'pairing', 'planning',
];

/** Structurally-minimal deps — bind() only captures, never invokes, so stubs suffice. */
function stubDeps(): EcosystemModalDeps {
  const emptyReadModel = { getSnapshot: () => ({} as never), subscribe: () => () => {} };
  const listNone = { list: () => [] };
  return {
    marketplace: {},
    plugins: { pluginManager: { list: () => [], capabilities: () => [], getTrustRecord: () => undefined, getQuarantineRecord: () => undefined, verify: () => ({}) } as never },
    skills: { shellPaths: { workingDirectory: '/tmp/x', homeDirectory: '/tmp/x' } },
    hooks: {
      hookDispatcher: { listHooks: () => [], getChains: () => [] } as never,
      hookWorkbench: { getHooksFilePath: () => '', listManagedHooks: () => [], listManagedChains: () => [], listRecentActions: () => [], getLastSimulation: () => undefined } as never,
      hookActivityTracker: { listRecent: () => [] } as never,
    },
    security: { readModel: emptyReadModel as never },
    policy: { policyRuntimeState: { getSnapshot: () => ({} as never) } },
    knowledge: { knowledgeApi: { graph: { nodes: listNone, issues: listNone }, sources: listNone, jobs: { schedules: listNone } } as never },
    memory: {},
    workPlan: { workPlanStore: { getActivePlan: () => ({} as never) } },
    keybindings: {},
    pairing: { connectionInfo: { url: 'http://x', token: 't', username: 'u' } },
    planning: { service: { status: () => Promise.resolve({}), getState: () => Promise.resolve({}), listDecisions: () => Promise.resolve([]), getLanguage: () => Promise.resolve({}), evaluate: () => Promise.resolve({}) } as never, projectId: 'p' },
  };
}

describe('ecosystem modal registration', () => {
  test('redirect list is complete and correct vs the 13 group-B surfaces', () => {
    expect([...ECOSYSTEM_MODAL_REDIRECTS]).toEqual([...EXPECTED_REDIRECTS] as never);
  });

  test('registerEcosystemModalRedirects registers every group-B panel id on the manager', () => {
    const registered: Array<[string, string]> = [];
    const manager = { registerModalRedirect: (id: string, name: string) => { registered.push([id, name]); } } as unknown as PanelManager;
    registerEcosystemModalRedirects(manager);
    expect(registered).toEqual([...EXPECTED_REDIRECTS] as never);
  });

  test('buildEcosystemModalSurfaces builds all 12 modal surfaces with the expected names', () => {
    const surfaces = buildEcosystemModalSurfaces(stubDeps());
    expect(surfaces.map((s: BoundModalSurface) => s.name)).toEqual(EXPECTED_MODAL_NAMES);
    // Every surface exposes the required contract.
    for (const s of surfaces) {
      expect(typeof s.buildConfig).toBe('function');
      expect(typeof s.refresh).toBe('function');
      expect(typeof s.rowIds).toBe('function');
      expect(s.actions).toBeDefined();
    }
  });

  test('registerEcosystemModals registers 12 modals + all 13 redirects via the host registrar', () => {
    const modals: string[] = [];
    const redirects: Array<[string, string]> = [];
    const registrar: EcosystemModalRegistrar = {
      registerModal: (s) => { modals.push(s.name); },
      registerModalRedirect: (id, name) => { redirects.push([id, name]); },
    };
    registerEcosystemModals(registrar, stubDeps());
    expect(modals).toEqual(EXPECTED_MODAL_NAMES);
    expect(redirects).toEqual([...EXPECTED_REDIRECTS] as never);
  });
});
