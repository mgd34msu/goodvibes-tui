import type {
  ProjectPlanningAgentAssignment,
  ProjectPlanningDependency,
  ProjectPlanningEvaluation,
  ProjectPlanningQuestion,
  ProjectPlanningService,
  ProjectPlanningState,
  ProjectPlanningTask,
  ProjectPlanningVerificationGate,
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
  readonly handledLocally: boolean;
  readonly statusMessage: string;
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
  /\b(skip|dismiss) (the )?planning\b/i,
  /\bcontinue without (the )?planning\b/i,
];

const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\b(approve|approved|approval granted)\b/i,
  /\b(go ahead|execute this plan|start execution|ready to execute)\b/i,
];

const ACCEPT_DEFAULT_PATTERNS: readonly RegExp[] = [
  /^(ok|okay|yes|y|yep|yeah|sure|fine|default|continue|go|go ahead|let'?s go|looks good|sounds good)\.?$/i,
  /\bok\b.*\blet'?s go\b/i,
  /\blet'?s go\b/i,
  /\b(use|accept|take) (the )?(default|recommended|recommendation)\b/i,
  /\b(create|use) (the )?default task breakdown\b/i,
  /\bfocused first-pass scope\b/i,
  /\bstandard verification gates?\b/i,
];

const GENERIC_RECOMMENDATION_PATTERNS: readonly RegExp[] = [
  /\bdefine the first-pass scope\b/i,
  /\bseparate out-of-scope work\b/i,
  /\bcreate task records\b/i,
  /\brecord concrete tests\b/i,
  /\bverification gates?\b/i,
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
      handledLocally: true,
      statusMessage: this.buildStatusMessage(state, evaluation),
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
      if (!answeredQuestions.some((question) => question.id === options.answeredQuestion?.id && question.answer === prompt)) {
        answeredQuestions.push({
          ...options.answeredQuestion,
          status: 'answered',
          answer: prompt,
          answeredAt: now,
        });
      }
    }

    const knownContext = new Set(existing?.knownContext ?? []);
    knownContext.add(`Workspace: ${this.workingDirectory}`);
    if (options.startsPlanning && existing?.goal && prompt !== existing.goal) {
      knownContext.add(`Latest planning request: ${prompt}`);
    }

    const draft: Partial<ProjectPlanningState> = {
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
    return this.applyPlanningAnswer(draft, prompt, options.answeredQuestion, {
      startsPlanning: options.startsPlanning,
      approved: options.approved,
    });
  }

  private applyPlanningAnswer(
    state: Partial<ProjectPlanningState>,
    prompt: string,
    question: ProjectPlanningQuestion | null,
    options: {
      readonly startsPlanning: boolean;
      readonly approved: boolean;
    },
  ): Partial<ProjectPlanningState> {
    if (!question) return state;

    const acceptDefault = this.acceptsDefault(prompt);
    const questionId = question.id.toLowerCase();
    const questionText = question.prompt.toLowerCase();
    const existingGoal = (state.goal ?? prompt).trim();
    const generic = acceptDefault || this.isGenericPlanningRecommendation(prompt);
    let next: Partial<ProjectPlanningState> = { ...state };

    if (questionId.includes('scope') || questionText.includes('scope') || questionText.includes('in or out')) {
      next = {
        ...next,
        scope: generic ? this.defaultScope(existingGoal) : this.normalizeScopeAnswer(existingGoal, prompt),
      };
    }

    if (
      questionId.includes('task') ||
      questionText.includes('task') ||
      questionId.includes('dependency') ||
      questionText.includes('dependency') ||
      questionId.includes('verification') ||
      questionText.includes('verification') ||
      (acceptDefault && this.hasStructuralPlanningGaps(next))
    ) {
      next = this.withDefaultExecutionPlan(next, existingGoal);
      if (!generic && !questionId.includes('scope')) {
        next = this.addKnownContext(next, `Planning answer: ${prompt}`);
      }
    }

    if (questionId.includes('approve') || questionText.includes('approve') || questionText.includes('execution')) {
      next = {
        ...next,
        executionApproved: true,
        metadata: {
          ...(next.metadata ?? {}),
          approvedAt: this.now(),
          approvedFrom: 'planning-answer',
        },
      };
    }

    if (acceptDefault && this.isGoAhead(prompt)) {
      next = this.withDefaultExecutionPlan({
        ...next,
        scope: next.scope ?? this.defaultScope(existingGoal),
        executionApproved: true,
        metadata: {
          ...(next.metadata ?? {}),
          approvedAt: this.now(),
          approvedFrom: 'planning-go-ahead',
        },
      }, existingGoal);
    }

    return next;
  }

  private normalizeScopeAnswer(goal: string, answer: string): string {
    const trimmed = answer.trim();
    if (!trimmed) return this.defaultScope(goal);
    if (/^scope\s+is\b/i.test(trimmed)) return trimmed;
    return `Scope for "${goal}": ${trimmed}`;
  }

  private defaultScope(goal: string): string {
    const cleanGoal = goal.trim() || 'the requested change';
    return [
      `First pass: make "${cleanGoal}" work end-to-end for the primary local TUI workflow.`,
      'Include the minimum TUI, daemon wiring, configuration persistence, documentation, and verification required for the feature to actually work.',
      'Exclude unrelated cleanup, broad refactors, polish-only changes, third-party integrations, and advanced distributed behavior unless they directly block the primary workflow.',
    ].join(' ');
  }

  private withDefaultExecutionPlan(
    state: Partial<ProjectPlanningState>,
    goal: string,
  ): Partial<ProjectPlanningState> {
    const tasks = state.tasks && state.tasks.length > 0 ? [...state.tasks] : this.defaultTasks(goal);
    const verificationGates = state.verificationGates && state.verificationGates.length > 0
      ? [...state.verificationGates]
      : this.defaultVerificationGates(goal);
    const dependencies = state.dependencies && state.dependencies.length > 0
      ? [...state.dependencies]
      : this.defaultDependencies();
    const agentAssignments = state.agentAssignments && state.agentAssignments.length > 0
      ? [...state.agentAssignments]
      : this.defaultAgentAssignments();
    return {
      ...state,
      scope: state.scope ?? this.defaultScope(goal),
      tasks,
      verificationGates,
      dependencies,
      agentAssignments,
    };
  }

  private defaultTasks(goal: string): ProjectPlanningTask[] {
    const cleanGoal = goal.trim() || 'requested change';
    return [
      {
        id: 'inspect-current-flow',
        title: `Inspect the current paths for ${cleanGoal}`,
        why: 'Planning must start from the actual code and runtime behavior, not assumptions.',
        status: 'pending',
        verification: ['Identify the relevant files, commands, config keys, and runtime path before editing.'],
        canRunConcurrently: false,
        needsReview: false,
        recommendedAgent: 'explorer',
      },
      {
        id: 'implement-core-behavior',
        title: `Implement the core ${cleanGoal} behavior`,
        why: 'This is the minimum product behavior required for the requested outcome to work.',
        status: 'pending',
        dependencies: ['inspect-current-flow'],
        verification: ['Focused tests cover the changed behavior and fail without the implementation.'],
        canRunConcurrently: false,
        needsReview: true,
        recommendedAgent: 'worker',
      },
      {
        id: 'wire-user-surface',
        title: `Wire the user-facing path for ${cleanGoal}`,
        why: 'The feature must be reachable through the intended TUI/daemon/config surface, not just internal code.',
        status: 'pending',
        dependencies: ['implement-core-behavior'],
        verification: ['A command, panel, route, or setting path exercises the behavior from the user-facing entry point.'],
        canRunConcurrently: false,
        needsReview: true,
        recommendedAgent: 'worker',
      },
      {
        id: 'verify-release-readiness',
        title: `Verify ${cleanGoal} end-to-end`,
        why: 'The plan is not complete until the user-facing path and regression tests prove it works.',
        status: 'pending',
        dependencies: ['implement-core-behavior', 'wire-user-surface'],
        verification: ['Run focused tests plus the relevant type/build/smoke checks for the touched area.'],
        canRunConcurrently: false,
        needsReview: false,
        recommendedAgent: 'none',
      },
    ];
  }

  private defaultDependencies(): ProjectPlanningDependency[] {
    return [
      { fromTaskId: 'inspect-current-flow', toTaskId: 'implement-core-behavior', reason: 'Implementation depends on knowing the current code path.' },
      { fromTaskId: 'implement-core-behavior', toTaskId: 'wire-user-surface', reason: 'The user-facing surface should call the implemented behavior.' },
      { fromTaskId: 'implement-core-behavior', toTaskId: 'verify-release-readiness', reason: 'Verification needs the implementation in place.' },
      { fromTaskId: 'wire-user-surface', toTaskId: 'verify-release-readiness', reason: 'Verification must include the reachable user path.' },
    ];
  }

  private defaultVerificationGates(goal: string): ProjectPlanningVerificationGate[] {
    const cleanGoal = goal.trim() || 'requested change';
    return [
      {
        id: 'focused-regression',
        description: `Focused regression coverage proves "${cleanGoal}" works and prevents the observed failure from returning.`,
        status: 'pending',
        required: true,
      },
      {
        id: 'typecheck',
        description: 'TypeScript/build validation passes for the touched code.',
        command: 'bunx tsc --noEmit',
        status: 'pending',
        required: true,
      },
      {
        id: 'runtime-smoke',
        description: 'A user-facing runtime smoke exercises the changed path when feasible.',
        status: 'pending',
        required: true,
      },
    ];
  }

  private defaultAgentAssignments(): ProjectPlanningAgentAssignment[] {
    return [
      {
        taskId: 'inspect-current-flow',
        agentType: 'explorer',
        expectedOutput: 'Concrete files, state transitions, and failure path that must change.',
        canRunConcurrently: false,
      },
      {
        taskId: 'implement-core-behavior',
        agentType: 'worker',
        expectedOutput: 'Patch implementing the core behavior with focused tests.',
        verification: 'Review the patch against the original request and regression test.',
        canRunConcurrently: false,
      },
      {
        taskId: 'wire-user-surface',
        agentType: 'worker',
        expectedOutput: 'Patch wiring the behavior through the intended user-facing surface.',
        verification: 'Verify the UI/command/route actually exercises the new behavior.',
        canRunConcurrently: false,
      },
    ];
  }

  private addKnownContext(state: Partial<ProjectPlanningState>, entry: string): Partial<ProjectPlanningState> {
    const knownContext = new Set(state.knownContext ?? []);
    knownContext.add(entry);
    return { ...state, knownContext: [...knownContext] };
  }

  private hasStructuralPlanningGaps(state: Partial<ProjectPlanningState>): boolean {
    return !state.scope || (state.tasks?.length ?? 0) === 0 || (state.verificationGates?.length ?? 0) === 0;
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

  private buildStatusMessage(
    state: ProjectPlanningState,
    evaluation: ProjectPlanningEvaluation,
  ): string {
    const nextQuestion = evaluation.nextQuestion?.prompt;
    const taskCount = state.tasks.length;
    const gateCount = state.verificationGates.length;
    const approved = state.executionApproved ? 'approved' : 'not approved';
    if (evaluation.readiness === 'executable') {
      return `[Planning] Updated plan: ${taskCount} task(s), ${gateCount} verification gate(s), execution ${approved}.`;
    }
    return `[Planning] Updated plan: ${taskCount} task(s), ${gateCount} verification gate(s). Next: ${nextQuestion ?? 'review the plan.'}`;
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

  private acceptsDefault(text: string): boolean {
    const trimmed = text.trim();
    return ACCEPT_DEFAULT_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  private isGoAhead(text: string): boolean {
    return /\b(go|go ahead|let'?s go|execute|start|approved?|approval granted)\b/i.test(text.trim());
  }

  private isGenericPlanningRecommendation(text: string): boolean {
    return GENERIC_RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(text));
  }
}
