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
    expect(result?.handledLocally).toBe(true);
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
    expect(fake.state?.scope).toContain('Only update');
    expect(fake.state?.openQuestions.some((question) => question.id === 'scope')).toBe(false);
    expect(fake.state?.openQuestions.length).toBeGreaterThan(0);
  });

  test('continue without planning pauses active project planning and lets normal chat proceed', async () => {
    let notices = 0;
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
      notify: () => { notices++; },
      now: () => 321,
    });

    const result = await coordinator.prepareTurn('continue without planning');

    expect(result).toBeNull();
    expect(notices).toBe(1);
    expect(fake.state?.metadata?.['active']).toBe(false);
    expect(fake.state?.metadata?.['pausedAt']).toBe(321);
    expect(fake.state?.openQuestions.some((question) => question.id === 'scope')).toBe(true);
  });

  test('accepting the default scope creates concrete scope instead of persisting SDK placeholder text', async () => {
    const fake = makeService(makeState({
      goal: 'make a simple rate limiter',
      openQuestions: [{
        id: 'missing-scope',
        prompt: 'What is in scope, and what should be left out for this pass?',
        recommendedAnswer: 'Define the first-pass scope and separate out-of-scope work from the current acceptance criteria.',
        status: 'open',
      }],
      metadata: { active: true },
    }));
    const coordinator = new ProjectPlanningCoordinator({
      service: fake.service,
      projectId: 'proj',
      workingDirectory: '/tmp/project',
      now: () => 789,
    });

    const result = await coordinator.prepareTurn('Use a focused first-pass scope for this goal.');

    expect(result?.handledLocally).toBe(true);
    expect(fake.state?.scope).toContain('make a simple rate limiter');
    expect(fake.state?.scope).not.toContain('Define the first-pass scope');
    expect(fake.state?.openQuestions.some((question) => question.id === 'missing-scope')).toBe(false);
  });

  test('go-ahead answer fills structural planning artifacts and approves execution', async () => {
    const fake = makeService(makeState({
      goal: 'make a simple rate limiter',
      openQuestions: [{
        id: 'missing-scope',
        prompt: 'What is in scope, and what should be left out for this pass?',
        recommendedAnswer: 'Define the first-pass scope and separate out-of-scope work from the current acceptance criteria.',
        status: 'open',
      }],
      metadata: { active: true },
    }));
    const coordinator = new ProjectPlanningCoordinator({
      service: fake.service,
      projectId: 'proj',
      workingDirectory: '/tmp/project',
      now: () => 999,
    });

    const result = await coordinator.prepareTurn("ok, let's go");

    expect(result?.handledLocally).toBe(true);
    expect(fake.state?.scope).toContain('make a simple rate limiter');
    expect(fake.state?.tasks.length).toBeGreaterThanOrEqual(4);
    expect(fake.state?.dependencies.length).toBeGreaterThan(0);
    expect(fake.state?.verificationGates.length).toBeGreaterThan(0);
    expect(fake.state?.executionApproved).toBe(true);
    expect(result?.evaluation.readiness).toBe('executable');
  });
});
