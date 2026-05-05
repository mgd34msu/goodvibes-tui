import type {
  ProjectPlanningDecision,
  ProjectPlanningEvaluation,
  ProjectPlanningLanguageArtifact,
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
}

export class ProjectPlanningPanel extends BasePanel {
  private readonly service: ProjectPlanningService;
  private readonly projectId: string;
  private readonly requestRender: () => void;
  private snapshot: ProjectPlanningPanelSnapshot | null = null;
  private loading = false;
  private scrollOffset = 0;

  public constructor(options: ProjectPlanningPanelOptions) {
    super('project-planning', 'Planning', 'P', 'agent');
    this.service = options.service;
    this.projectId = options.projectId;
    this.requestRender = options.requestRender ?? (() => {});
  }

  public override onActivate(): void {
    super.onActivate();
    this.refresh();
  }

  public handleInput(key: string): boolean {
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

      const sections: PanelWorkspaceSection[] = [];
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
        sections.push(this.buildGapsSection(width, evaluation));
        sections.push(this.buildTasksSection(width, state));
        sections.push(this.buildDecisionsSection(width, state, decisions));
        sections.push(this.buildLanguageSection(width, language));
      }

      if (this.lastError) {
        const line = this.renderErrorLine(width);
        if (line) sections.push({ title: 'Error', lines: [line] });
      }

      const flattened = sections.flatMap((section) => [
        ...(section.title ? [buildPanelLine(width, [[` ${section.title}`, C.label]])] : []),
        ...section.lines,
      ]);
      const scroll = resolveScrollablePanelSection(width, height, {
        intro: 'Project planning state, readiness gaps, decisions, language, task graph, verification gates, and agent handoff metadata.',
        footerLines: this.footerLines(width),
        palette: C,
        section: {
          title: 'Project Planning',
          scrollableLines: flattened,
          selectedIndex: 0,
          scrollOffset: this.scrollOffset,
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
    return [
      buildPanelLine(width, [
        [' Up/Down', C.info],
        [' scroll  ', C.dim],
        ['r', C.info],
        [' refresh  ', C.dim],
        ['a', C.info],
        [' approve execution-ready plan  Esc close panel focus', C.dim],
      ]),
    ];
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
      if (evaluation.nextQuestion.recommendedAnswer) {
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
