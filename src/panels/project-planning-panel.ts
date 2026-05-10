import type {
  ProjectPlanningDecision,
  ProjectPlanningEvaluation,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningQuestion,
  ProjectPlanningService,
  ProjectPlanningState,
  ProjectPlanningStatus,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import type { Line } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelListRow,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  extendPalette,
  resolveScrollablePanelSection,
  type PanelWorkspaceSection,
} from './polish.ts';

const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  planning: '#38bdf8',
  blocked: '#f97316',
  approved: '#22c55e',
  rejected: '#ef4444',
});

interface ProjectPlanningPanelSnapshot {
  readonly status: ProjectPlanningStatus | null;
  readonly state: ProjectPlanningState | null;
  readonly evaluation: ProjectPlanningEvaluation | null;
  readonly decisions: readonly ProjectPlanningDecision[];
  readonly language: ProjectPlanningLanguageArtifact | null;
}

export interface ProjectPlanningPanelOptions {
  readonly service: ProjectPlanningService;
  readonly projectId: string;
  readonly requestRender?: () => void;
  readonly submitAnswer?: (answer: string) => void;
  readonly dismissPlanning?: () => void;
}

interface PlanningAnswerAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly answer: string;
  readonly kind?: 'answer' | 'approve' | 'dismiss';
  readonly disabled?: boolean;
}

interface RenderedPlanningSection extends PanelWorkspaceSection {
  readonly selectedLineIndex?: number;
}

export class ProjectPlanningPanel extends BasePanel {
  private readonly service: ProjectPlanningService;
  private readonly projectId: string;
  private readonly requestRender: () => void;
  private readonly submitAnswer: ((answer: string) => void) | undefined;
  private readonly dismissPlanning: (() => void) | undefined;
  private snapshot: ProjectPlanningPanelSnapshot | null = null;
  private loading = false;
  private scrollOffset = 0;
  private selectedActionIndex = 0;
  private draftAnswer = '';

  public constructor(options: ProjectPlanningPanelOptions) {
    super('project-planning', 'Planning', 'P', 'agent');
    this.service = options.service;
    this.projectId = options.projectId;
    this.requestRender = options.requestRender ?? (() => {});
    this.submitAnswer = options.submitAnswer;
    this.dismissPlanning = options.dismissPlanning;
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  public handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();
    const question = this.getCurrentQuestion();
    if (question) {
      const actions = this.getAnswerActions(question);
      this.selectedActionIndex = this.clampActionIndex(actions.length);
      if (key === 'up') {
        this.selectedActionIndex = Math.max(0, this.selectedActionIndex - 1);
        this.markDirty();
        return true;
      }
      if (key === 'down') {
        this.selectedActionIndex = Math.min(Math.max(0, actions.length - 1), this.selectedActionIndex + 1);
        this.markDirty();
        return true;
      }
      if (key === 'enter' || key === 'return') {
        this.submitSelectedAction(question, actions);
        return true;
      }
      if (key === 'backspace') {
        this.draftAnswer = this.draftAnswer.slice(0, -1);
        this.markDirty();
        return true;
      }
      if (key === 'delete') {
        this.draftAnswer = '';
        this.markDirty();
        return true;
      }
      if (key === 'space') {
        this.draftAnswer += ' ';
        this.markDirty();
        return true;
      }
      if (key === 'pageup') {
        this.scrollOffset = Math.max(0, this.scrollOffset - 6);
        this.markDirty();
        return true;
      }
      if (key === 'pagedown') {
        this.scrollOffset += 6;
        this.markDirty();
        return true;
      }
      if (this.isPrintableKey(key)) {
        this.draftAnswer += key;
        this.markDirty();
        return true;
      }
      return false;
    }

    if (key === 'r' || key === 'R') {
      this.refresh(true);
      return true;
    }
    if (key === 'a' || key === 'A') {
      this.approveExecution();
      return true;
    }
    if (key === 'up' || key === 'k') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.scrollOffset += 1;
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    return this.trackedRender(() => {
      if (!this.snapshot && !this.loading) this.refresh();

      const sections: RenderedPlanningSection[] = [];
      const status = this.snapshot?.status;
      const state = this.snapshot?.state;
      const evaluation = this.snapshot?.evaluation ?? null;
      const language = this.snapshot?.language ?? null;
      const decisions = this.snapshot?.decisions ?? [];

      sections.push({
        title: 'Workspace',
        lines: [
          buildKeyValueLine(width, [
            { label: 'project', value: this.projectId, valueColor: C.planning },
            { label: 'space', value: status?.knowledgeSpaceId ?? `project:${this.projectId}`, valueColor: C.value },
            { label: 'mode', value: 'TUI-owned passive backing store', valueColor: C.info },
          ], C),
          buildPanelLine(width, [
            [' Planning never starts from daemon, webhooks, ntfy, Home Assistant, or companion surfaces.', C.dim],
          ]),
        ],
      });

      if (!state) {
        sections.push({
          title: 'No Active Planning State',
          lines: buildEmptyState(
            width,
            'No project planning state has been saved for this workspace.',
            'Describe the intended change in normal chat to let the TUI start the planning interview. The SDK only stores and evaluates artifacts.',
            [],
            C,
          ),
        });
      } else {
        sections.push(this.buildStateSection(width, state, evaluation));
        const question = this.getCurrentQuestion();
        if (question) sections.push(this.buildQuestionSection(width, question));
        sections.push(this.buildGapsSection(width, evaluation));
        sections.push(this.buildTasksSection(width, state));
        sections.push(this.buildDecisionsSection(width, state, decisions));
        sections.push(this.buildLanguageSection(width, language));
      }

      if (this.lastError) {
        const line = this.renderErrorLine(width);
        if (line) sections.push({ title: 'Error', lines: [line] });
      }

      const { lines: flattened, selectedIndex } = this.flattenSections(width, sections);
      const scroll = resolveScrollablePanelSection(width, height, {
        intro: 'Project planning state, readiness gaps, decisions, language, task graph, verification gates, and agent handoff metadata.',
        footerLines: this.footerLines(width),
        palette: C,
        section: {
          title: 'Project Planning',
          scrollableLines: flattened,
          selectedIndex,
          scrollOffset: this.scrollOffset,
          appendWindowSummary: {},
          minRows: 8,
        },
      });
      this.scrollOffset = scroll.scrollOffset;

      return buildPanelWorkspace(width, height, {
        title: this.loading ? 'Project Planning - loading' : 'Project Planning',
        intro: 'Passive SDK-backed planning artifacts for the current workspace. Conversation control stays inside this TUI.',
        sections: [scroll.section],
        footerLines: this.footerLines(width),
        palette: C,
      });
    });
  }

  private footerLines(width: number): Line[] {
    const hasQuestion = this.getCurrentQuestion() !== null;
    if (hasQuestion) {
      return [
        buildPanelLine(width, [
          [' Up/Down', C.info],
          [' choose answer  ', C.dim],
          ['type', C.info],
          [' draft  ', C.dim],
          ['Backspace/Delete', C.info],
          [' edit  ', C.dim],
          ['Enter', C.info],
          [' submit  Esc prompt focus  Ctrl+X close panel', C.dim],
        ]),
      ];
    }
    return [
      buildPanelLine(width, [
        [' Up/Down', C.info],
        [' scroll  ', C.dim],
        ['r', C.info],
        [' refresh  ', C.dim],
        ['a', C.info],
        [' approve execution-ready plan  Esc prompt focus  Ctrl+X close panel', C.dim],
      ]),
    ];
  }

  private flattenSections(
    width: number,
    sections: readonly RenderedPlanningSection[],
  ): { readonly lines: Line[]; readonly selectedIndex: number } {
    const lines: Line[] = [];
    let selectedIndex = 0;
    for (const section of sections) {
      const sectionStart = lines.length;
      const titleOffset = section.title ? 1 : 0;
      if (section.title) lines.push(buildPanelLine(width, [[` ${section.title}`, C.label]]));
      lines.push(...section.lines);
      if (section.selectedLineIndex !== undefined) {
        selectedIndex = sectionStart + titleOffset + section.selectedLineIndex;
      }
    }
    return { lines, selectedIndex };
  }

  private buildQuestionSection(width: number, question: ProjectPlanningQuestion): RenderedPlanningSection {
    const actions = this.getAnswerActions(question);
    this.selectedActionIndex = this.clampActionIndex(actions.length);
    const lines: Line[] = [
      ...buildBodyText(width, question.prompt, C, C.planning),
    ];
    if (question.whyItMatters) {
      lines.push(...buildBodyText(width, `Why this matters: ${question.whyItMatters}`, C, C.dim));
    }
    if (question.recommendedAnswer && !this.isGenericRecommendation(question.recommendedAnswer)) {
      lines.push(...buildBodyText(width, `Recommendation: ${question.recommendedAnswer}`, C, C.good));
    }
    lines.push(...buildBodyText(
      width,
      `Typed answer: ${this.draftAnswer || '(type here while this panel is focused)'}`,
      C,
      this.draftAnswer ? C.value : C.dim,
    ));
    lines.push(buildPanelLine(width, [[
      ' Select an answer below or type your own. Enter sends it through the normal planning chat path.',
      C.dim,
    ]]));
    const selectedLineIndex = lines.length + this.selectedActionIndex;
    actions.forEach((action, index) => {
      const selected = index === this.selectedActionIndex;
      lines.push(buildPanelListRow(width, [
        { text: action.label, fg: action.disabled ? C.dim : C.value, bold: selected },
        { text: `  ${action.detail}`, fg: C.dim },
      ], C, {
        selected,
        marker: selected ? '▶' : ' ',
      }));
    });
    return { title: 'Answer Current Question', lines, selectedLineIndex };
  }

  private buildStateSection(
    width: number,
    state: ProjectPlanningState,
    evaluation: ProjectPlanningEvaluation | null,
  ): PanelWorkspaceSection {
    const readiness = evaluation?.readiness ?? state.readiness;
    const readinessColor = readiness === 'executable'
      ? C.approved
      : readiness === 'needs-user-input'
      ? C.blocked
      : C.dim;
    const lines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'readiness', value: readiness, valueColor: readinessColor },
        { label: 'approved', value: state.executionApproved ? 'yes' : 'no', valueColor: state.executionApproved ? C.approved : C.blocked },
        { label: 'questions', value: `${state.openQuestions.length} open / ${state.answeredQuestions.length} answered`, valueColor: C.value },
      ], C),
      ...buildBodyText(width, `Goal: ${state.goal || '(not set)'}`, C, state.goal ? C.value : C.blocked),
    ];
    if (state.scope) lines.push(...buildBodyText(width, `Scope: ${state.scope}`, C, C.value));
    if (state.knownContext.length) {
      lines.push(...buildBodyText(width, `Known context: ${state.knownContext.join(' | ')}`, C, C.dim));
    }
    if (evaluation?.nextQuestion) {
      lines.push(...buildBodyText(width, `Next question: ${evaluation.nextQuestion.prompt}`, C, C.planning));
      if (evaluation.nextQuestion.whyItMatters) {
        lines.push(...buildBodyText(width, `Why it matters: ${evaluation.nextQuestion.whyItMatters}`, C, C.dim));
      }
      if (evaluation.nextQuestion.recommendedAnswer && !this.isGenericRecommendation(evaluation.nextQuestion.recommendedAnswer)) {
        lines.push(...buildBodyText(width, `Recommended answer: ${evaluation.nextQuestion.recommendedAnswer}`, C, C.good));
      }
    }
    return { title: 'State', lines };
  }

  private buildGapsSection(width: number, evaluation: ProjectPlanningEvaluation | null): PanelWorkspaceSection {
    const gaps = evaluation?.gaps ?? [];
    if (gaps.length === 0) {
      return {
        title: 'Readiness Gaps',
        lines: [buildPanelLine(width, [[' No readiness gaps.', C.good]])],
      };
    }
    return {
      title: 'Readiness Gaps',
      lines: gaps.slice(0, 12).flatMap((gap) => buildBodyText(
        width,
        `${gap.severity.toUpperCase()} ${gap.kind}: ${gap.message}`,
        C,
        gap.severity === 'blocking' ? C.blocked : C.warn,
      )),
    };
  }

  private buildTasksSection(width: number, state: ProjectPlanningState): PanelWorkspaceSection {
    const lines: Line[] = [];
    if (state.tasks.length === 0) {
      lines.push(buildPanelLine(width, [[' No decomposed tasks recorded yet.', C.dim]]));
    } else {
      for (const task of state.tasks) {
        lines.push(...buildBodyText(
          width,
          `${task.id}: ${task.title} [${task.status ?? 'pending'}]${task.canRunConcurrently ? ' - concurrent' : ''}`,
          C,
          task.blockedOnUserInput ? C.blocked : C.value,
        ));
        if (task.dependencies?.length) lines.push(...buildBodyText(width, `Dependencies: ${task.dependencies.join(', ')}`, C, C.dim));
        if (task.verification?.length) lines.push(...buildBodyText(width, `Verification: ${task.verification.join(' | ')}`, C, C.good));
      }
    }

    if (state.verificationGates.length) {
      lines.push(buildPanelLine(width, [[' Verification gates:', C.label]]));
      for (const gate of state.verificationGates) {
        lines.push(...buildBodyText(width, `${gate.id}: ${gate.description} [${gate.status ?? 'pending'}]`, C, gate.required === false ? C.dim : C.good));
      }
    }
    if (state.agentAssignments.length) {
      lines.push(buildPanelLine(width, [[' Agent handoff candidates:', C.label]]));
      for (const assignment of state.agentAssignments) {
        lines.push(...buildBodyText(
          width,
          `${assignment.taskId}: ${assignment.agentType ?? 'none'}${assignment.canRunConcurrently ? ' - can run concurrently' : ''}`,
          C,
          C.info,
        ));
      }
    }
    return { title: 'Task Graph', lines };
  }

  private buildDecisionsSection(
    width: number,
    state: ProjectPlanningState,
    storedDecisions: readonly ProjectPlanningDecision[],
  ): PanelWorkspaceSection {
    const byId = new Map<string, ProjectPlanningDecision>();
    for (const decision of [...storedDecisions, ...state.decisions]) byId.set(decision.id, decision);
    const decisions = [...byId.values()];
    if (decisions.length === 0) {
      return {
        title: 'Decisions',
        lines: [buildPanelLine(width, [[' No durable planning decisions recorded yet.', C.dim]])],
      };
    }
    return {
      title: 'Decisions',
      lines: decisions.slice(0, 12).flatMap((decision) => buildBodyText(
        width,
        `${decision.title}: ${decision.decision} [${decision.status ?? 'accepted'}]`,
        C,
        decision.status === 'rejected' ? C.rejected : C.value,
      )),
    };
  }

  private buildLanguageSection(width: number, language: ProjectPlanningLanguageArtifact | null): PanelWorkspaceSection {
    if (!language || (language.terms.length === 0 && language.ambiguities.length === 0)) {
      return {
        title: 'Project Language',
        lines: [buildPanelLine(width, [[' No project language terms or ambiguity resolutions recorded yet.', C.dim]])],
      };
    }
    const lines: Line[] = [];
    for (const term of language.terms.slice(0, 8)) {
      lines.push(...buildBodyText(width, `${term.term}: ${term.definition}`, C, C.value));
      if (term.avoid?.length) lines.push(...buildBodyText(width, `Avoid: ${term.avoid.join(', ')}`, C, C.blocked));
    }
    for (const ambiguity of language.ambiguities.slice(0, 8)) {
      lines.push(...buildBodyText(width, `Resolved ambiguity - ${ambiguity.phrase}: ${ambiguity.resolution}`, C, C.info));
    }
    return { title: 'Project Language', lines };
  }

  private refresh(force = false): void {
    if (this.loading && !force) return;
    this.loading = true;
    this.markDirty();
    this.requestRender();
    void (async () => {
      try {
        const [status, stateResult, decisionsResult, languageResult] = await Promise.all([
          this.service.status({ projectId: this.projectId }),
          this.service.getState({ projectId: this.projectId }),
          this.service.listDecisions({ projectId: this.projectId }),
          this.service.getLanguage({ projectId: this.projectId }),
        ]);
        const evaluation = await this.service.evaluate({ projectId: this.projectId });
        this.snapshot = {
          status,
          state: stateResult.state,
          evaluation,
          decisions: decisionsResult.decisions,
          language: languageResult.language,
        };
        this.clearError();
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
      } finally {
        this.loading = false;
        this.markDirty();
        this.requestRender();
      }
    })();
  }

  private getCurrentQuestion(): ProjectPlanningQuestion | null {
    const state = this.snapshot?.state;
    const open = state?.openQuestions.find((question) => (question.status ?? 'open') === 'open');
    return open ?? this.snapshot?.evaluation?.nextQuestion ?? null;
  }

  private getAnswerActions(question: ProjectPlanningQuestion): PlanningAnswerAction[] {
    const actions: PlanningAnswerAction[] = [];
    const prompt = question.prompt.toLowerCase();
    const isScopeQuestion = prompt.includes('scope') || prompt.includes('in or out');
    const isTaskQuestion = prompt.includes('task') || prompt.includes('dependency') || prompt.includes('work breakdown');
    const isVerificationQuestion = prompt.includes('verification') || prompt.includes('test') || prompt.includes('prove');
    const isApprovalQuestion = prompt.includes('approved') || prompt.includes('approve') || prompt.includes('execution');
    if (isApprovalQuestion) {
      actions.push({
        id: 'approve-execution',
        label: 'Approve execution',
        detail: 'Mark this plan approved so execution may proceed.',
        answer: 'Approve this planning state for execution.',
        kind: 'approve',
      });
    }
    if (isScopeQuestion) {
      actions.push({
        id: 'scope-focused-first-pass',
        label: 'Use focused first-pass scope',
        detail: 'Fill a concrete end-to-end scope for this goal and keep unrelated work out.',
        answer: 'Use a focused first-pass scope for this goal.',
      });
    }
    if (isTaskQuestion) {
      actions.push({
        id: 'tasks-default-breakdown',
        label: 'Create default task breakdown',
        detail: 'Create inspect, implement, wire, and verify tasks with dependencies.',
        answer: 'Create the default task breakdown for this goal.',
      });
    }
    if (isVerificationQuestion) {
      actions.push({
        id: 'verification-default-gates',
        label: 'Use standard verification gates',
        detail: 'Require focused regression coverage, typecheck/build validation, and a runtime smoke where feasible.',
        answer: 'Use standard verification gates for this goal.',
      });
    }
    if (question.recommendedAnswer?.trim() && !this.isGenericRecommendation(question.recommendedAnswer)) {
      actions.push({
        id: 'recommended',
        label: 'Use recommended answer',
        detail: this.compact(question.recommendedAnswer),
        answer: question.recommendedAnswer,
      });
    }
    if (isScopeQuestion) {
      actions.push({
        id: 'scope-end-to-end',
        label: 'End-to-end required scope',
        detail: 'Let the plan include every component needed to make this work, but avoid unrelated cleanup.',
        answer: 'Scope is everything required to make the requested outcome work end-to-end. Include TUI, daemon composition, configuration, docs, and tests if they are required. Do not include unrelated cleanup or broad refactors unless they are necessary for this task.',
      });
      actions.push({
        id: 'scope-tui-first',
        label: 'TUI-first scope',
        detail: 'Fix TUI behavior here; report SDK blockers instead of patching around SDK-owned bugs.',
        answer: 'Scope is TUI-owned behavior first. If a blocker is SDK-owned, report the exact SDK contract/runtime issue instead of patching around it in the TUI. Include daemon composition only where the TUI owns the wiring.',
      });
    }
    actions.push({
      id: 'ask-narrower',
      label: 'I am not sure yet',
      detail: 'Break this into smaller concrete choices with examples and a recommended default.',
      answer: `I do not know enough to answer "${question.prompt}" as asked. Break it into smaller concrete questions with 2-4 specific choices, explain the tradeoffs, recommend a default, and ask me the first one.`,
    });
    actions.push({
      id: 'custom',
      label: 'Submit typed answer',
      detail: this.draftAnswer ? this.compact(this.draftAnswer) : 'Type an answer first; this row becomes the custom answer.',
      answer: this.draftAnswer.trim(),
      disabled: !this.draftAnswer.trim(),
    });
    actions.push({
      id: 'dismiss-planning',
      label: 'Close planning and continue without it',
      detail: 'Pause project planning for this workspace. Normal chat continues; /plan can reopen it later.',
      answer: 'Pause project planning for this workspace and continue without the planning panel.',
      kind: 'dismiss',
    });
    return actions;
  }

  private isGenericRecommendation(value: string): boolean {
    return /\bdefine the first-pass scope\b/i.test(value)
      || /\bcreate task records\b/i.test(value)
      || /\brecord concrete tests\b/i.test(value)
      || /\bseparate out-of-scope work\b/i.test(value);
  }

  private submitSelectedAction(question: ProjectPlanningQuestion, actions: readonly PlanningAnswerAction[]): void {
    const action = actions[this.clampActionIndex(actions.length)];
    if (!action || action.disabled || !action.answer.trim()) {
      this.setError('Type an answer or choose a non-empty answer option.');
      this.requestRender();
      return;
    }
    if (action.kind === 'approve') {
      this.approveExecution();
      return;
    }
    if (action.kind === 'dismiss') {
      this.pausePlanning(question);
      return;
    }
    if (!this.submitAnswer) {
      this.setError('Planning answer submission is not wired in this runtime.');
      this.requestRender();
      return;
    }
    void (async () => {
      try {
        await this.persistQuestionIfNeeded(question);
        this.draftAnswer = '';
        this.submitAnswer?.(action.answer.trim());
        this.refresh(true);
        this.registerTimer(setTimeout(() => this.refresh(true), 250));
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
        this.requestRender();
      }
    })();
  }

  private async persistQuestionIfNeeded(question: ProjectPlanningQuestion): Promise<void> {
    const state = this.snapshot?.state;
    if (!state) return;
    if (state.openQuestions.some((entry) => entry.id === question.id)) return;
    await this.service.upsertState({
      projectId: this.projectId,
      state: {
        ...state,
        openQuestions: [
          { ...question, status: question.status ?? 'open' },
          ...state.openQuestions,
        ],
      },
    });
  }

  private pausePlanning(question: ProjectPlanningQuestion): void {
    const state = this.snapshot?.state;
    if (!state) {
      this.dismissPlanning?.();
      this.requestRender();
      return;
    }
    void (async () => {
      try {
        await this.service.upsertState({
          projectId: this.projectId,
          state: {
            ...state,
            openQuestions: state.openQuestions.map((entry) =>
              entry.id === question.id
                ? { ...entry, status: entry.status ?? 'open' }
                : entry,
            ),
            metadata: {
              ...(state.metadata ?? {}),
              active: false,
              pausedAt: Date.now(),
              pausedFrom: 'project-planning-panel',
            },
          },
        });
        this.dismissPlanning?.();
        this.refresh(true);
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
        this.requestRender();
      }
    })();
  }

  private clampActionIndex(count: number): number {
    if (count <= 0) return 0;
    return Math.max(0, Math.min(count - 1, this.selectedActionIndex));
  }

  private isPrintableKey(key: string): boolean {
    return key.length === 1 && key >= ' ';
  }

  private compact(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > 86 ? `${normalized.slice(0, 83)}...` : normalized;
  }

  private approveExecution(): void {
    const state = this.snapshot?.state;
    if (!state) {
      this.setError('No planning state exists to approve.');
      this.requestRender();
      return;
    }
    void (async () => {
      try {
        await this.service.upsertState({
          projectId: this.projectId,
          state: {
            ...state,
            executionApproved: true,
            metadata: {
              ...(state.metadata ?? {}),
              approvedFrom: 'project-planning-panel',
              approvedAt: Date.now(),
            },
          },
        });
        this.refresh(true);
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
        this.requestRender();
      }
    })();
  }
}
