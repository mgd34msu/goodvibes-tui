import { describe, test, expect } from 'bun:test';
import { createPlanningModalSurface, type PlanningModalService } from '../../../panels/modals/planning-modal.ts';
import type { ProjectPlanningState, ProjectPlanningStatus } from '@pellux/goodvibes-sdk/platform/knowledge';
import { actionCtx, captureCommands, findAction, tabText } from './modal-surface-test-helpers.ts';

async function flush(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }

const FIXED_STATUS: ProjectPlanningStatus = { ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] };

function noQuestionState(): ProjectPlanningState {
  return { id: 'state-1', projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', goal: 'Fixture goal', knownContext: [], openQuestions: [], answeredQuestions: [], decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [], verificationGates: [], agentAssignments: [], readiness: 'executable', executionApproved: false, createdAt: 0, updatedAt: 0 };
}
function serviceWithState(state: ProjectPlanningState | null): PlanningModalService {
  return {
    status: async () => FIXED_STATUS,
    getState: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', state }),
    listDecisions: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', decisions: [] }),
    getLanguage: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', language: null }),
    evaluate: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: state?.readiness ?? 'not-ready', gaps: [], state: state ?? noQuestionState() }),
  };
}
async function warm(service: PlanningModalService) {
  const surface = createPlanningModalSurface({ service, projectId: 'proj-1' });
  surface.onOpen?.(() => {});
  await flush();
  return surface;
}

describe('planning modal surface', () => {
  test('surface identity matches the project-planning -> planning-modal redirect target', () => {
    expect(createPlanningModalSurface({ service: serviceWithState(null), projectId: 'proj-1' }).name).toBe('planning-modal');
  });

  test('loading placeholder before the async load resolves, then the real state after', async () => {
    const surface = createPlanningModalSurface({ service: serviceWithState(noQuestionState()), projectId: 'proj-1' });
    surface.onOpen?.(() => {});
    expect(tabText(surface.buildView(), 'planning').toLowerCase()).toContain('loading');
    await flush();
    const loaded = tabText(surface.buildView(), 'planning');
    expect(loaded).toContain('readiness executable');
    expect(loaded).toContain('Fixture goal');
  });

  test('no-state case names the gap honestly instead of showing empty artifact sections', async () => {
    const text = tabText((await warm(serviceWithState(null))).buildView(), 'planning');
    expect(text).toContain('No project planning state has been saved for this workspace.');
  });

  test('an open question renders answer actions; approve row routes to /plan approve', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'Is execution approved?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    const view = surface.buildView();
    const text = tabText(view, 'planning');
    expect(text).toContain('Is execution approved?');
    expect(text).toContain('Approve execution');
    // no more reseed approximation note; the answer paths are real now.
    expect(text).not.toContain('reseeds the plan goal');
    expect(view.tabs[0]!.rows.some((r) => r.id === 'approve-execution')).toBe(true);

    expect(findAction(surface, 'submit')?.enabledFor?.(null, 'planning')).toBe(true);
    const cap = captureCommands();
    surface.onAction?.('submit', actionCtx({ id: 'approve-execution', label: '' }, cap.extra));
    expect(cap.calls).toEqual([['plan', ['approve']]]);
  });

  // a canned answer to a REAL open question records via /plan answer <id> <text>.
  test('a canned answer to a real open question dispatches /plan answer <id> <text>', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    const cap = captureCommands();
    surface.onAction?.('submit', actionCtx({ id: 'scope-focused-first-pass', label: '' }, cap.extra));
    expect(cap.calls.length).toBe(1);
    const [name, args] = cap.calls[0]!;
    expect(name).toBe('plan');
    expect(args[0]).toBe('answer');
    expect(args[1]).toBe('q1');
    expect(args.slice(2).join(' ')).toBe('Use a focused first-pass scope for this goal.');
  });

  // an answer to a SYNTHETIC readiness question (no open-question record
  // to target) is submitted to chat via submitInput, and the modal CLOSES BEFORE
  // the turn starts (modal-liveness ordering guard). No /plan command is dispatched.
  test('an answer to a synthetic question uses submitInput and closes the modal first', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [] };
    const syntheticQuestion = { id: 'missing-scope', prompt: 'What is in scope for this pass?', status: undefined };
    const service: PlanningModalService = {
      ...serviceWithState(state),
      evaluate: async () => ({ ok: true, projectId: 'proj-1', knowledgeSpaceId: 'project:proj-1', readiness: 'needs-user-input', gaps: [], nextQuestion: syntheticQuestion, state }),
    };
    const surface = await warm(service);
    const cap = captureCommands();
    const order: string[] = [];
    // Captured on an object (not a bare `let`) so TS tracks the string | null
    // union across the callback boundary instead of narrowing to the initializer.
    const submission: { text: string | null } = { text: null };
    surface.onAction?.('submit', actionCtx({ id: 'scope-focused-first-pass', label: '' }, {
      ...cap.extra,
      close: () => order.push('close'),
      submitInput: (t) => { order.push('submit'); submission.text = t; },
    }));
    expect(cap.calls).toEqual([]); // no /plan command — this is a real chat turn
    expect(submission.text).toBe('Use a focused first-pass scope for this goal.');
    expect(order).toEqual(['close', 'submit']); // close BEFORE the turn starts
  });

  test('submitting a disabled (empty custom) option prints a correction instead of routing a command', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const surface = await warm(serviceWithState(state));
    const printed: string[] = [];
    const cap = captureCommands();
    surface.onAction?.('submit', actionCtx({ id: 'custom', label: '' }, { ...cap.extra, print: (m) => printed.push(m) }));
    expect(cap.calls).toEqual([]);
    expect(printed).toEqual(['Choose an answer option.']);
  });

  test('top-level approve action (no open question) routes to /plan approve', async () => {
    const surface = await warm(serviceWithState(noQuestionState()));
    const cap = captureCommands();
    surface.onAction?.('approve', actionCtx(null, cap.extra));
    expect(cap.calls).toEqual([['plan', ['approve']]]);
  });

  // dismiss is now a first-class CONFIRMED action ('d') that dispatches
  // the real /plan dismiss and closes the panel — not a pseudo answer-row.
  test('the dismiss action dispatches /plan dismiss and closes the panel', async () => {
    const surface = await warm(serviceWithState(noQuestionState()));
    const cap = captureCommands();
    let closed = 0;
    surface.onAction?.('dismiss', actionCtx(null, { ...cap.extra, close: () => { closed += 1; } }));
    expect(cap.calls).toEqual([['plan', ['dismiss']]]);
    expect(closed).toBe(1);
    // It is declared as a confirmed action (host two-press guard).
    expect(findAction(surface, 'dismiss')?.confirm).toBe(true);
  });

  test('there is no pseudo dismiss/close answer-row anymore', async () => {
    const state: ProjectPlanningState = { ...noQuestionState(), readiness: 'needs-user-input', openQuestions: [{ id: 'q1', prompt: 'What is the scope?', status: 'open' }] };
    const view = (await warm(serviceWithState(state))).buildView();
    expect(view.tabs[0]!.rows.some((r) => r.id === 'dismiss-planning')).toBe(false);
    expect(tabText(view, 'planning')).not.toContain('Close (planning unchanged)');
  });
});
