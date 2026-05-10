import { describe, expect, test } from 'bun:test';
import {
  evaluateProjectPlanningReadiness,
  type ProjectPlanningDecision,
  type ProjectPlanningLanguageArtifact,
  type ProjectPlanningService,
  type ProjectPlanningState,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import { ProjectPlanningPanel } from '../../panels/project-planning-panel.ts';

function makeState(input: Partial<ProjectPlanningState> = {}): ProjectPlanningState {
  const now = Date.now();
  return {
    id: 'current',
    projectId: 'proj',
    knowledgeSpaceId: 'project:proj',
    goal: input.goal ?? 'Plan the provider/model workspace.',
    scope: input.scope ?? 'TUI-only planning surface.',
    knownContext: input.knownContext ?? ['Workspace: /tmp/project'],
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
    metadata: input.metadata ?? { active: true },
  };
}

function makeService(state: ProjectPlanningState | null): ProjectPlanningService {
  const decisions: ProjectPlanningDecision[] = [];
  const language: ProjectPlanningLanguageArtifact = {
    projectId: 'proj',
    knowledgeSpaceId: 'project:proj',
    terms: [{ term: 'Planning Loop', definition: 'A TUI-owned interview before execution.' }],
    ambiguities: [],
    updatedAt: Date.now(),
  };
  return {
    async status() {
      return {
        ok: true,
        projectId: 'proj',
        knowledgeSpaceId: 'project:proj',
        passiveOnly: true,
        counts: { states: state ? 1 : 0, decisions: decisions.length, languageArtifacts: 1 },
        capabilities: ['project-scoped-storage', 'passive-daemon-only'],
      };
    },
    async getState() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
    async evaluate() {
      return evaluateProjectPlanningReadiness(state ?? makeState({ goal: '' }));
    },
    async listDecisions() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', decisions };
    },
    async getLanguage() {
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', language };
    },
    async upsertState(input: { state: Partial<ProjectPlanningState> }) {
      state = makeState(input.state);
      return { ok: true, projectId: 'proj', knowledgeSpaceId: 'project:proj', state };
    },
  } as unknown as ProjectPlanningService;
}

function text(lines: ReturnType<ProjectPlanningPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

async function flushPanelAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('ProjectPlanningPanel', () => {
  test('renders passive project planning posture after refresh', async () => {
    const panel = new ProjectPlanningPanel({
      service: makeService(makeState()),
      projectId: 'proj',
    });
    panel.onActivate();
    await flushPanelAsync();
    await flushPanelAsync();

    const rendered = text(panel.render(100, 42));
    expect(rendered).toContain('Project Planning');
    expect(rendered).toContain('TUI-owned passive backing store');
    expect(rendered).toContain('Plan the provider/model workspace');
    expect(rendered).toContain('Planning Loop');
  });

  test('approves the current state without requiring daemon involvement', async () => {
    const service = makeService(makeState({
      tasks: [{ id: 't1', title: 'Patch TUI planning panel', verification: ['bun run tsc'] }],
      verificationGates: [{ id: 'tsc', description: 'TypeScript passes', command: 'bun run tsc' }],
    }));
    const panel = new ProjectPlanningPanel({ service, projectId: 'proj' });
    panel.onActivate();
    await flushPanelAsync();
    await flushPanelAsync();

    expect(panel.handleInput('enter')).toBe(true);
    await flushPanelAsync();
    await flushPanelAsync();

    const rendered = text(panel.render(100, 28));
    expect(rendered).toContain('approved yes');
  });

  test('submits selectable or typed answers through the planning answer callback', async () => {
    const submitted: string[] = [];
    const service = makeService(makeState({
      openQuestions: [{
        id: 'scope',
        prompt: 'What is in or out of scope?',
        recommendedAnswer: 'TUI-only unless SDK wiring is required.',
        status: 'open',
      }],
    }));
    const panel = new ProjectPlanningPanel({
      service,
      projectId: 'proj',
      submitAnswer: (answer) => submitted.push(answer),
    });
    panel.onActivate();
    await flushPanelAsync();
    await flushPanelAsync();

    const rendered = text(panel.render(120, 32));
    expect(rendered).toContain('Answer Current Question');
    expect(rendered).toContain('Use focused first-pass scope');
    expect(rendered).toContain('Use recommended answer');
    expect(rendered).toContain('I am not sure yet');

    for (const ch of 'Only the TUI planning loop') panel.handleInput(ch);
    panel.handleInput('down');
    panel.handleInput('down');
    panel.handleInput('down');
    panel.handleInput('down');
    panel.handleInput('down');
    expect(panel.handleInput('enter')).toBe(true);
    await flushPanelAsync();

    expect(submitted.at(-1)).toBe('Only the TUI planning loop');
  });

  test('keeps the selected planning answer visible while navigating long question content', async () => {
    const longPrompt = [
      'What is in scope, and what should be left out for this pass?',
      ...Array.from({ length: 24 }, (_, index) => `Context line ${index + 1}: detailed planning prompt content that would otherwise push actions off screen.`),
    ].join('\n');
    const service = makeService(makeState({
      openQuestions: [{
        id: 'scope',
        prompt: longPrompt,
        recommendedAnswer: 'TUI-only unless SDK wiring is required.',
        status: 'open',
      }],
    }));
    const panel = new ProjectPlanningPanel({ service, projectId: 'proj' });
    panel.onActivate();
    await flushPanelAsync();
    await flushPanelAsync();

    for (let i = 0; i < 6; i++) panel.handleInput('down');

    const rendered = text(panel.render(120, 18));
    expect(rendered).toContain('Close planning and continue without it');
    expect(rendered).toContain('showing');
  });

  test('can pause planning from the panel without submitting another planning turn', async () => {
    let dismissed = 0;
    let saved: ProjectPlanningState | null = null;
    const service = makeService(makeState({
      openQuestions: [{
        id: 'scope',
        prompt: 'What is in or out of scope?',
        status: 'open',
      }],
    }));
    const originalUpsert = service.upsertState.bind(service);
    service.upsertState = (async (input: { state: Partial<ProjectPlanningState> }) => {
      const result = await originalUpsert(input);
      saved = result.state;
      return result;
    }) as ProjectPlanningService['upsertState'];
    const panel = new ProjectPlanningPanel({
      service,
      projectId: 'proj',
      dismissPlanning: () => { dismissed++; },
      submitAnswer: () => {
        throw new Error('skip action must not submit through planning chat');
      },
    });
    panel.onActivate();
    await flushPanelAsync();
    await flushPanelAsync();

    for (let i = 0; i < 5; i++) panel.handleInput('down');
    expect(text(panel.render(120, 30))).toContain('Close planning and continue without it');
    expect(panel.handleInput('enter')).toBe(true);
    await flushPanelAsync();
    await flushPanelAsync();

    expect(dismissed).toBe(1);
    expect(saved?.metadata?.['active']).toBe(false);
    expect(saved?.metadata?.['pausedFrom']).toBe('project-planning-panel');
  });

  test('does not surface generic SDK placeholder recommendations as answer actions', async () => {
    const service = makeService(makeState({
      openQuestions: [{
        id: 'missing-scope',
        prompt: 'What is in scope, and what should be left out for this pass?',
        recommendedAnswer: 'Define the first-pass scope and separate out-of-scope work from the current acceptance criteria.',
        status: 'open',
      }],
    }));
    const panel = new ProjectPlanningPanel({ service, projectId: 'proj' });
    panel.onActivate();
    await flushPanelAsync();
    await flushPanelAsync();

    const rendered = text(panel.render(120, 32));
    expect(rendered).toContain('Use focused first-pass scope');
    expect(rendered).not.toContain('Use recommended answer');
    expect(rendered).not.toContain('Define the first-pass scope');
  });
});
