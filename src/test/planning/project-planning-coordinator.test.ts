import { describe, expect, test } from 'bun:test';
import {
  evaluateProjectPlanningReadiness,
  type ProjectPlanningEvaluation,
  type ProjectPlanningService,
  type ProjectPlanningState,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import { ProjectPlanningCoordinator, hasProjectPlanningIntent } from '../../planning/project-planning-coordinator.ts';

function makeState(input: Partial<ProjectPlanningState> = {}): ProjectPlanningState {
  const now = Date.now();
  return {
    id: input.id ?? 'current',
    projectId: input.projectId ?? 'proj',
    knowledgeSpaceId: input.knowledgeSpaceId ?? 'project:proj',
    goal: input.goal ?? '',
    scope: input.scope,
    knownContext: input.knownContext ?? [],
    openQuestions: input.openQuestions ?? [],
    answeredQuestions: input.answeredQuestions ?? [],
    decisions: input.decisions ?? [],
    assumptions: input.assumptions ?? [],
    constraints: input.constraints ?? [],
    risks: input.risks ?? [],
    tasks: input.tasks ?? [],
    dependencies: input.dependencies ?? [],
    verificationGates: input.verificationGates ?? [],
    agentAssignments: input.agentAssignments ?? [],
    readiness: input.readiness ?? 'not-ready',
    executionApproved: input.executionApproved ?? false,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    metadata: input.metadata ?? {},
  };
}

function makeService(initial: ProjectPlanningState | null = null): {
  service: ProjectPlanningService;
  get state(): ProjectPlanningState | null;
} {
  let state = initial;
  const service = {
    async getState() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
    async upsertState(input: { state: Partial<ProjectPlanningState> }) {
      state = makeState({ ...input.state, projectId: 'proj', knowledgeSpaceId: 'project:proj' });
      const evaluated = evaluateProjectPlanningReadiness(state);
      state = evaluated.state;
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
    async evaluate(input?: { state?: Partial<ProjectPlanningState> }): Promise<ProjectPlanningEvaluation> {
      return evaluateProjectPlanningReadiness(makeState({ ...(input?.state ?? state ?? {}) }));
    },
  };
  return {
    service: service as unknown as ProjectPlanningService,
    get state() {
      return state;
    },
  };
}

describe('project planning coordinator', () => {
  test('detects explicit natural-language planning intent', () => {
    expect(hasProjectPlanningIntent('make an implementation plan before coding')).toBe(true);
    expect(hasProjectPlanningIntent('show me the dependency graph for this work')).toBe(true);
    expect(hasProjectPlanningIntent('what is the weather?')).toBe(false);
    expect(hasProjectPlanningIntent('/plan this')).toBe(false);
  });

  test('ignores ordinary chat when no planning state is active', async () => {
    const { service, state } = makeService();
    const coordinator = new ProjectPlanningCoordinator({
      service,
      projectId: 'proj',
      workingDirectory: '/tmp/project',
    });
    const result = await coordinator.prepareTurn('hello there');
    expect(result).toBeNull();
    expect(state).toBeNull();
  });

  test('starts a TUI-owned planning loop and persists SDK-backed state', async () => {
    let opened = 0;
    const fake = makeService();
    const coordinator = new ProjectPlanningCoordinator({
      service: fake.service,
      projectId: 'proj',
      workingDirectory: '/tmp/project',
      openPanel: () => { opened++; },
      now: () => 123,
    });

    const result = await coordinator.prepareTurn('make an implementation plan for the provider model picker');

    expect(result).not.toBeNull();
    expect(opened).toBe(1);
    expect(fake.state?.goal).toContain('implementation plan');
    expect(fake.state?.metadata?.['owner']).toBe('tui');
    expect(result?.systemMessage).toContain('TUI-owned project planning loop');
    expect(result?.evaluation.nextQuestion?.prompt).toBeTruthy();
  });

  test('records the next user message as the active planning answer', async () => {
    const fake = makeService(makeState({
      goal: 'plan a change',
      openQuestions: [{
        id: 'scope',
        prompt: 'What is in scope?',
        status: 'open',
      }],
      metadata: { active: true },
    }));
    const coordinator = new ProjectPlanningCoordinator({
      service: fake.service,
      projectId: 'proj',
      workingDirectory: '/tmp/project',
      now: () => 456,
    });

    await coordinator.prepareTurn('Only update the TUI planning panel and docs.');

    expect(fake.state?.answeredQuestions.some((question) => question.id === 'scope')).toBe(true);
    expect(fake.state?.answeredQuestions[0]?.answer).toContain('Only update');
  });
});
