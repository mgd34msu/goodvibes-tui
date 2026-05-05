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

    const rendered = text(panel.render(100, 28));
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

    expect(panel.handleInput('a')).toBe(true);
    await flushPanelAsync();
    await flushPanelAsync();

    const rendered = text(panel.render(100, 28));
    expect(rendered).toContain('approved yes');
  });
});
