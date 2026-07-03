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
import { handleConfirmInput, renderConfirmLines, type ConfirmState } from './confirm-state.ts';
import { isTextBackspace, isTextForwardDelete } from '../input/delete-key-policy.ts';
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
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { buildAnswerActions, isGenericRecommendation, type PlanningAnswerAction } from './project-planning-answer-actions.ts';

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
  // Pending confirmation for Delete (clear draft). Null when inactive.
  private clearDraftConfirm: ConfirmState<'clear-draft'> | null = null;

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

  /**
   * The draft-answer text field wants every character of a burst (paste, or
   * fast typing landing in one input.feed() call) delivered one at a time,
   * same as it always has — see the interface doc on
   * `Panel.isCapturingTextBurst`.
   */
  public isCapturingTextBurst(): boolean {
    return this.getCurrentQuestion() !== null;
  }

  public handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    // ConfirmState gate: Delete (clear draft) requires y/n confirmation.
    // handleConfirmInput absorbs all keys while a confirmation is pending.
    const confirmResult = handleConfirmInput(this.clearDraftConfirm, key);
    if (confirmResult === 'confirmed') {
      this.draftAnswer = '';
      this.clearDraftConfirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.clearDraftConfirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') {
      return true;
    }
    // confirmResult === 'inactive': proceed with normal dispatch.

    // Ctrl+R (refresh) / Ctrl+A (approve) are alternate bindings for 'r'/'a'
    // that stay reachable while a question is active, where plain 'r'/'a'
    // are swallowed into the draft-answer text below instead. They are
    // checked before the question gate so they work in both modes.
    //
    // NOTE: the input-routing layer (src/input/handler-feed-routes.ts, owned
    // by WO-150 in this wave) does not yet forward ctrl-modified keys to the
    // active panel — it currently intercepts all `token.ctrl` input before
    // panel.handleInput is ever called, and a bare Ctrl+R is already bound
    // globally to 'history-search'. This handler recognizes the logical key
    // strings 'ctrl+r'/'ctrl+a' so the panel-side behavior is correct and
    // testable now; wiring a real Ctrl+R/Ctrl+A keypress through to these
    // strings is an input-handler change outside this work order's file
    // scope.
    if (key === 'ctrl+r') {
      this.refresh(true);
      return true;
    }
    if (key === 'ctrl+a') {
      this.approveExecution();
      return true;
    }

    const question = this.getCurrentQuestion();
    if (question) {
      const actions = buildAnswerActions(question, this.draftAnswer);
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
      if (isTextBackspace(key)) {
        this.draftAnswer = this.draftAnswer.slice(0, -1);
        this.markDirty();
        return true;
      }
      // 'delete' opens the clear-draft confirmation gate (per delete-key policy).
      // The draft is not wiped until the user confirms with y/Enter.
      if (isTextForwardDelete(key)) {
        this.clearDraftConfirm = { subject: 'clear-draft', label: 'draft answer' };
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
          // Live artifact counts from the SDK status route (same counts /plan
          // prints at planning-runtime.ts:90) instead of static filler prose.
          status
            ? buildKeyValueLine(width, [
                { label: 'states', value: String(status.counts.states), valueColor: status.counts.states > 0 ? C.value : C.dim },
                { label: 'decisions', value: String(status.counts.decisions), valueColor: status.counts.decisions > 0 ? C.value : C.dim },
                { label: 'language', value: String(status.counts.languageArtifacts), valueColor: status.counts.languageArtifacts > 0 ? C.value : C.dim },
              ], C)
            : buildPanelLine(width, [[' Artifact counts unavailable — refreshing…', C.dim]]),
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
        sections.push(this.buildAnsweredHistorySection(width, state));
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
          ['Backspace', C.info],
          [' edit  ', C.dim],
          ['Del', C.info],
          [' clear draft  ', C.dim],
          ['Enter', C.info],
          [' submit  Esc prompt focus  Ctrl+X close panel', C.dim],
        ]),
        buildPanelLine(width, [
          [' Ctrl+R', C.info],
          [' refresh  ', C.dim],
          ['Ctrl+A', C.info],
          [' approve  (r/a type into the draft while a question is active)', C.dim],
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
    const actions = buildAnswerActions(question, this.draftAnswer);
    this.selectedActionIndex = this.clampActionIndex(actions.length);
    // When a clear-draft confirmation is pending, show the confirm prompt
    // inline above the draft line instead of the normal content.
    if (this.clearDraftConfirm) {
      const confirmLines = renderConfirmLines(width, this.clearDraftConfirm);
      const lines: Line[] = [
        ...buildBodyText(width, question.prompt, C, C.planning),
        ...confirmLines,
      ];
      return { title: 'Answer Current Question', lines, selectedLineIndex: undefined };
    }
    const lines: Line[] = [
      ...buildBodyText(width, question.prompt, C, C.planning),
    ];
    if (question.whyItMatters) {
      lines.push(...buildBodyText(width, `Why this matters: ${question.whyItMatters}`, C, C.dim));
    }
    if (question.recommendedAnswer && !isGenericRecommendation(question.recommendedAnswer)) {
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
    const blockingGaps = (evaluation?.gaps ?? []).filter((gap) => gap.severity === 'blocking').length;
    const openQuestions = state.openQuestions.filter((q) => (q.status ?? 'open') === 'open').length;
    // Surface the most important thing first: is this plan executable, and what
    // is the single blocker to getting there.
    const nextStep = state.executionApproved
      ? 'approved — execution may proceed'
      : openQuestions > 0
      ? `answer ${openQuestions} open question${openQuestions === 1 ? '' : 's'}`
      : blockingGaps > 0
      ? `resolve ${blockingGaps} blocking gap${blockingGaps === 1 ? '' : 's'}`
      : readiness === 'executable'
      ? 'press a to approve execution'
      : 'continue the planning interview';
    const lines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'readiness', value: readiness, valueColor: readinessColor },
        { label: 'approved', value: state.executionApproved ? 'yes' : 'no', valueColor: state.executionApproved ? C.approved : C.blocked },
        { label: 'questions', value: `${state.openQuestions.length} open / ${state.answeredQuestions.length} answered`, valueColor: C.value },
      ], C),
      buildKeyValueLine(width, [
        { label: 'blocking gaps', value: String(blockingGaps), valueColor: blockingGaps > 0 ? C.blocked : C.good },
        { label: 'tasks', value: String(state.tasks.length), valueColor: state.tasks.length > 0 ? C.value : C.dim },
        { label: 'gates', value: String(state.verificationGates.length), valueColor: state.verificationGates.length > 0 ? C.good : C.dim },
      ], C),
      buildPanelLine(width, [
        [' Next step ', C.label],
        [nextStep, state.executionApproved ? C.approved : C.planning],
      ]),
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
      if (evaluation.nextQuestion.recommendedAnswer && !isGenericRecommendation(evaluation.nextQuestion.recommendedAnswer)) {
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

  private buildAnsweredHistorySection(width: number, state: ProjectPlanningState): PanelWorkspaceSection {
    const answered = state.answeredQuestions;
    if (answered.length === 0) {
      return {
        title: 'Answered Questions',
        lines: [buildPanelLine(width, [[' No questions answered yet.', C.dim]])],
      };
    }
    const ordered = [...answered].sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0));
    return {
      title: 'Answered Questions',
      lines: ordered.slice(0, 12).flatMap((entry) => [
        ...buildBodyText(width, `Q: ${entry.prompt}`, C, C.value),
        ...buildBodyText(width, `A: ${entry.answer?.trim() || '(no answer recorded)'}`, C, entry.answer?.trim() ? C.good : C.dim),
      ]),
    };
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
        this.setError(summarizeError(err));
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
        this.setError(summarizeError(err));
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
        this.setError(summarizeError(err));
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
        this.setError(summarizeError(err));
        this.requestRender();
      }
    })();
  }
}
