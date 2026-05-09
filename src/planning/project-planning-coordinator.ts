import type {
  ProjectPlanningEvaluation,
  ProjectPlanningQuestion,
  ProjectPlanningService,
  ProjectPlanningState,
} from '@pellux/goodvibes-sdk/platform/knowledge';

export interface ProjectPlanningCoordinatorOptions {
  readonly service: ProjectPlanningService;
  readonly projectId: string;
  readonly workingDirectory: string;
  readonly openPanel?: () => void;
  readonly notify?: (message: string) => void;
  readonly now?: () => number;
}

export interface ProjectPlanningTurnPreparation {
  readonly systemMessage: string;
  readonly state: ProjectPlanningState;
  readonly evaluation: ProjectPlanningEvaluation;
}

const PLANNING_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(plan|planning)\b/i,
  /\bimplementation (plan|strategy)\b/i,
  /\bexecution (plan|strategy)\b/i,
  /\bdependency graph\b/i,
  /\bbreak (this|it|that|the work) down\b/i,
  /\bbefore (coding|implementing|we start|execution)\b/i,
  /\bagent (handoff|assignment|assignments)\b/i,
  /\bverification gates?\b/i,
  /\binterview (me|loop)\b/i,
];

const CANCEL_PATTERNS: readonly RegExp[] = [
  /\b(stop|cancel|pause|exit) (the )?planning\b/i,
  /\bplanning (is )?(done|cancelled|canceled|paused)\b/i,
];

const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\b(approve|approved|approval granted)\b/i,
  /\b(go ahead|execute this plan|start execution|ready to execute)\b/i,
];

export function hasProjectPlanningIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return false;
  return PLANNING_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export class ProjectPlanningCoordinator {
  private readonly service: ProjectPlanningService;
  private readonly projectId: string;
  private readonly workingDirectory: string;
  private readonly openPanel: () => void;
  private readonly notify: (message: string) => void;
  private readonly now: () => number;

  public constructor(options: ProjectPlanningCoordinatorOptions) {
    this.service = options.service;
    this.projectId = options.projectId;
    this.workingDirectory = options.workingDirectory;
    this.openPanel = options.openPanel ?? (() => {});
    this.notify = options.notify ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  public async prepareTurn(text: string): Promise<ProjectPlanningTurnPreparation | null> {
    const prompt = text.trim();
    if (!prompt || prompt.startsWith('!') || prompt.startsWith('/')) return null;

    const stateResult = await this.service.getState({ projectId: this.projectId });
    const existing = stateResult.state;
    const active = this.isActive(existing);
    const startsPlanning = hasProjectPlanningIntent(prompt);

    if (this.isCancel(prompt)) {
      if (existing) {
        await this.service.upsertState({
          projectId: this.projectId,
          state: {
            ...existing,
            metadata: {
              ...(existing.metadata ?? {}),
              active: false,
              pausedAt: this.now(),
            },
          },
        });
        this.notify('[Planning] Paused project planning for this workspace.');
      }
      return null;
    }

    if (!active && !startsPlanning) return null;

    const answeredQuestion = active ? this.firstOpenQuestion(existing) : null;
    const stateDraft = this.buildStateDraft(existing, prompt, {
      startsPlanning,
      answeredQuestion,
      approved: this.isApproval(prompt),
    });

    const firstEvaluation = await this.service.evaluate({
      projectId: this.projectId,
      state: stateDraft,
    });
    const withNextQuestion = this.recordNextQuestion(stateDraft, firstEvaluation.nextQuestion);
    const normalized = await this.service.evaluate({
      projectId: this.projectId,
      state: withNextQuestion,
    });
    const saved = await this.service.upsertState({
      projectId: this.projectId,
      state: normalized.state,
    });
    const state = saved.state ?? normalized.state;
    const evaluation = await this.service.evaluate({
      projectId: this.projectId,
      state,
    });

    this.openPanel();
    return {
      systemMessage: this.buildSystemMessage(state, evaluation),
      state,
      evaluation,
    };
  }

  private buildStateDraft(
    existing: ProjectPlanningState | null,
    prompt: string,
    options: {
      readonly startsPlanning: boolean;
      readonly answeredQuestion: ProjectPlanningQuestion | null;
      readonly approved: boolean;
    },
  ): Partial<ProjectPlanningState> {
    const now = this.now();
    const openQuestions = [...(existing?.openQuestions ?? [])];
    const answeredQuestions = [...(existing?.answeredQuestions ?? [])];
    if (options.answeredQuestion) {
      const idx = openQuestions.findIndex((question) => question.id === options.answeredQuestion?.id);
      if (idx >= 0) openQuestions.splice(idx, 1);
      answeredQuestions.push({
        ...options.answeredQuestion,
        status: 'answered',
        answer: prompt,
        answeredAt: now,
      });
    }

    const knownContext = new Set(existing?.knownContext ?? []);
    knownContext.add(`Workspace: ${this.workingDirectory}`);
    if (options.startsPlanning && existing?.goal && prompt !== existing.goal) {
      knownContext.add(`Latest planning request: ${prompt}`);
    }

    return {
      ...(existing ?? {}),
      projectId: this.projectId,
      goal: existing?.goal?.trim() ? existing.goal : prompt,
      knownContext: [...knownContext],
      openQuestions,
      answeredQuestions,
      executionApproved: existing?.executionApproved === true || options.approved,
      metadata: {
        ...(existing?.metadata ?? {}),
        active: true,
        owner: 'tui',
        source: 'conversation',
        lastPromptAt: now,
      },
    };
  }

  private recordNextQuestion(
    state: Partial<ProjectPlanningState>,
    question: ProjectPlanningQuestion | undefined,
  ): Partial<ProjectPlanningState> {
    if (!question) return state;
    const answered = new Set((state.answeredQuestions ?? []).map((entry) => entry.id));
    if (answered.has(question.id)) return state;
    const openQuestions = [...(state.openQuestions ?? [])];
    const existingIndex = openQuestions.findIndex((entry) => entry.id === question.id);
    const normalized = { ...question, status: question.status ?? 'open' } satisfies ProjectPlanningQuestion;
    if (existingIndex >= 0) openQuestions[existingIndex] = normalized;
    else openQuestions.unshift(normalized);
    return {
      ...state,
      openQuestions,
    };
  }

  private buildSystemMessage(
    state: ProjectPlanningState,
    evaluation: ProjectPlanningEvaluation,
  ): string {
    const nextQuestion = evaluation.nextQuestion;
    const gaps = evaluation.gaps
      .slice(0, 8)
      .map((gap) => `- ${gap.severity}: ${gap.kind} - ${gap.message}`)
      .join('\n') || '- none';
    const tasks = state.tasks
      .map((task) => `- ${task.id}: ${task.title}`)
      .join('\n') || '- none recorded yet';
    const recentAnswers = state.answeredQuestions
      .slice(-3)
      .map((question) => `- ${question.prompt}\n  Answer: ${question.answer ?? '(no answer recorded)'}`)
      .join('\n') || '- none recorded yet';

    return [
      'TUI-owned project planning loop is active for this turn.',
      'Do not execute code changes, spawn agents, or claim implementation is complete unless the user explicitly approves execution after the plan is structurally ready.',
      'Be relentless and thorough: challenge vague wording, inspect relevant context before proposing execution, and ask exactly one focused question when information is missing.',
      'Do not ask broad questions like "what is in scope?" without examples. Break broad planning gaps into concrete choices, explain tradeoffs, and recommend a default the user can accept or correct.',
      '',
      `Project id: ${this.projectId}`,
      `Knowledge space: ${state.knowledgeSpaceId}`,
      `Readiness: ${evaluation.readiness}`,
      `Execution approved: ${state.executionApproved ? 'yes' : 'no'}`,
      `Goal: ${state.goal || '(missing)'}`,
      state.scope ? `Scope: ${state.scope}` : 'Scope: (missing)',
      '',
      'Readiness gaps:',
      gaps,
      '',
      'Recent answered planning questions:',
      recentAnswers,
      '',
      'Recorded tasks:',
      tasks,
      '',
      nextQuestion
        ? `Resolve this next planning gap. If this wording is broad, turn it into a smaller concrete multiple-choice question before asking: ${nextQuestion.prompt}`
        : 'If the plan is structurally ready, summarize the plan and ask for explicit execution approval. Do not start execution yourself.',
    ].join('\n');
  }

  private isActive(state: ProjectPlanningState | null): boolean {
    return state?.metadata?.['active'] === true && state.executionApproved !== true;
  }

  private firstOpenQuestion(state: ProjectPlanningState | null): ProjectPlanningQuestion | null {
    return state?.openQuestions.find((question) => (question.status ?? 'open') === 'open') ?? null;
  }

  private isCancel(text: string): boolean {
    return CANCEL_PATTERNS.some((pattern) => pattern.test(text));
  }

  private isApproval(text: string): boolean {
    return APPROVAL_PATTERNS.some((pattern) => pattern.test(text));
  }
}
