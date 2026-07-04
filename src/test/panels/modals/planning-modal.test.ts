import { describe, test, expect } from 'bun:test';
import {
  bindPlanningModal,
  planningModalGoldenSurface,
  type PlanningModalService,
} from '../../../panels/modals/planning-modal.ts';
import { EMPTY_VIEW, type ModalViewState } from '../../../panels/modals/modal-surface.ts';
import type { ModalConfig } from '../../../renderer/modal-factory.ts';
import type { ProjectPlanningState, ProjectPlanningStatus } from '@pellux/goodvibes-sdk/platform/knowledge';

/** Flatten a ModalConfig's text/list/title content into one searchable string. */
function configText(config: ModalConfig): string {
  const parts: string[] = [config.title];
  if (config.search !== undefined) parts.push(config.search);
  for (const section of config.sections) {
    if (section.content) parts.push(section.content);
    for (const item of section.items ?? []) parts.push(item.label);
  }
  for (const hint of config.hints ?? []) parts.push(hint);
  if (config.footer) parts.push(config.footer);
  return parts.join('\n');
}

/** Flush the microtask/macrotask queue so a fire-and-forget refresh() resolves. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const FIXED_STATUS: ProjectPlanningStatus = {
  ok: true,
  projectId: 'proj-1',
  knowledgeSpaceId: 'project:proj-1',
  passiveOnly: true,
  counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 },
  capabilities: [],
};

function noQuestionState(): ProjectPlanningState {
  return {
    id: 'state-1',
    projectId: 'proj-1',
    knowledgeSpaceId: 'project:proj-1',
    goal: 'Fixture goal',
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
    readiness: 'executable',
    executionApproved: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function serviceWithState(state: ProjectPlanningState | null): PlanningModalService {
  return {
    status: async () => FIXED_STATUS,
    getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state }),
    listDecisions: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', decisions: [] }),
    getLanguage: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', language: null }),
    evaluate: async () => ({
      ok: true,
      projectId: 'proj-1',
      knowledgeSpaceId: 'project:proj-1',
      readiness: state?.readiness ?? 'not-ready',
      gaps: [],
      state: state ?? noQuestionState(),
    }),
  };
}

describe('planning modal builder', () => {
  test('surface identity: name matches the project-planning -> planning redirect target', () => {
    const surface = bindPlanningModal({ service: serviceWithState(null), projectId: 'proj-1' });
    expect(surface.name).toBe('planning');
  });

  test('shows a loading placeholder before the async refresh resolves, then the real state after', async () => {
    const surface = bindPlanningModal({ service: serviceWithState(noQuestionState()), projectId: 'proj-1' });
    const loadingText = configText(surface.buildConfig(EMPTY_VIEW));
    expect(loadingText.toLowerCase()).toContain('loading');
    await flush();
    const loadedText = configText(surface.buildConfig(EMPTY_VIEW));
    expect(loadedText).toContain('readiness executable');
    expect(loadedText).toContain('Fixture goal');
  });

  test('no-state case names the gap honestly instead of showing empty artifact sections', async () => {
    const surface = bindPlanningModal({ service: serviceWithState(null), projectId: 'proj-1' });
    surface.refresh();
    await flush();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('No project planning state has been saved for this workspace.');
  });

  test('an open question renders canned answer actions; approve routes to /plan approve', async () => {
    const state: ProjectPlanningState = {
      ...noQuestionState(),
      readiness: 'needs-user-input',
      openQuestions: [{
        id: 'q1',
        prompt: 'Is execution approved?',
        status: 'open',
      }],
    };
    const surface = bindPlanningModal({ service: serviceWithState(state), projectId: 'proj-1' });
    surface.refresh();
    await flush();
    const text = configText(surface.buildConfig(EMPTY_VIEW));
    expect(text).toContain('Is execution approved?');
    expect(text).toContain('Approve execution');

    const ids = surface.rowIds(EMPTY_VIEW);
    expect(ids).toContain('approve-execution');
    const approveIndex = ids.indexOf('approve-execution');
    const outcome = surface.actions.submit!({ ...EMPTY_VIEW, selectedIndex: approveIndex } as ModalViewState);
    expect(outcome).toEqual({ kind: 'runCommand', command: '/plan approve' });
  });

  test('submitting an empty/disabled selection prints a correction instead of routing a command', async () => {
    const state: ProjectPlanningState = {
      ...noQuestionState(),
      openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }],
    };
    const surface = bindPlanningModal({ service: serviceWithState(state), projectId: 'proj-1' });
    surface.refresh();
    await flush();
    const ids = surface.rowIds(EMPTY_VIEW);
    const customIndex = ids.indexOf('custom');
    expect(customIndex).toBeGreaterThanOrEqual(0);
    const outcome = surface.actions.submit!({ ...EMPTY_VIEW, selectedIndex: customIndex } as ModalViewState);
    expect(outcome).toEqual({ kind: 'print', text: 'Type an answer or choose a non-empty answer option.' });
  });

  test('a typed custom answer (view.query) routes through /plan <answer text>', async () => {
    const state: ProjectPlanningState = {
      ...noQuestionState(),
      openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }],
    };
    const surface = bindPlanningModal({ service: serviceWithState(state), projectId: 'proj-1' });
    surface.refresh();
    await flush();
    const view: ModalViewState = { selectedIndex: 0, query: 'Keep it to the TUI only.' };
    const ids = surface.rowIds(view);
    const customIndex = ids.indexOf('custom');
    const outcome = surface.actions.submit!({ ...view, selectedIndex: customIndex } as ModalViewState);
    expect(outcome).toEqual({ kind: 'runCommand', command: '/plan Keep it to the TUI only.' });
  });

  test('top-level approve action (no open question) routes to /plan approve', async () => {
    const surface = bindPlanningModal({ service: serviceWithState(noQuestionState()), projectId: 'proj-1' });
    surface.refresh();
    await flush();
    expect(surface.actions.approve!(EMPTY_VIEW)).toEqual({ kind: 'runCommand', command: '/plan approve' });
  });

  test('golden surface renders deterministically across two independent builds', async () => {
    const a = await planningModalGoldenSurface();
    const b = await planningModalGoldenSurface();
    expect(configText(a.buildConfig(EMPTY_VIEW))).toBe(configText(b.buildConfig(EMPTY_VIEW)));
    expect(configText(a.buildConfig(EMPTY_VIEW))).toContain('golden fixture');
  });
});
