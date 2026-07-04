import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ProjectPlanningDecision,
  ProjectPlanningEvaluation,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningQuestion,
  ProjectPlanningService,
  ProjectPlanningState,
  ProjectPlanningStatus,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { buildAnswerActions, isGenericRecommendation, type PlanningAnswerAction } from '../project-planning-answer-actions.ts';

// ---------------------------------------------------------------------------
// Project Planning → 'planning' config-modal surface (W6.1 group-B port). Shows
// readiness/questions/decisions/task-graph/handoff — read-only except choosing
// and submitting an answer to the current open question, approving execution,
// or refreshing. Submit/approve route to the `/plan` command.
//
// KNOWN GAP (flagged in the report): `/plan` has no subcommand that answers the
// CURRENT open question. The live app calls a submitPlanningAnswer callback that
// feeds the answer through the normal chat prompt — the action context has no
// such seam. Lacking a slash-command equivalent, submit routes the chosen answer
// text through `/plan <answer text>` (the free-form branch, which RESEEDS the
// goal rather than resolving the specific question) — a known-imprecise
// stand-in, surfaced honestly in an in-modal note.
// ---------------------------------------------------------------------------

export type PlanningModalService = Pick<ProjectPlanningService, 'status' | 'getState' | 'listDecisions' | 'getLanguage' | 'evaluate'>;

export interface PlanningModalDeps {
  readonly service: PlanningModalService;
  readonly projectId: string;
  readonly requestRender?: () => void;
}

interface PlanningModalSnapshot {
  readonly status: ProjectPlanningStatus | null;
  readonly state: ProjectPlanningState | null;
  readonly evaluation: ProjectPlanningEvaluation | null;
  readonly decisions: readonly ProjectPlanningDecision[];
  readonly language: ProjectPlanningLanguageArtifact | null;
}

interface TextLine { readonly content: string; readonly fg?: string; }

const GOOD = MODAL_TONES.good;
const WARN = MODAL_TONES.warn;
const BAD = MODAL_TONES.bad;
const INFO = MODAL_TONES.info;

function getCurrentQuestion(state: ProjectPlanningState, evaluation: ProjectPlanningEvaluation | null): ProjectPlanningQuestion | null {
  const open = state.openQuestions.find((question) => (question.status ?? 'open') === 'open');
  return open ?? evaluation?.nextQuestion ?? null;
}

function buildStateLines(state: ProjectPlanningState, evaluation: ProjectPlanningEvaluation | null): TextLine[] {
  const readiness = evaluation?.readiness ?? state.readiness;
  const readinessColor = readiness === 'executable' ? GOOD : readiness === 'needs-user-input' ? WARN : undefined;
  const blockingGaps = (evaluation?.gaps ?? []).filter((gap) => gap.severity === 'blocking').length;
  const lines: TextLine[] = [
    { content: `readiness ${readiness}  approved ${state.executionApproved ? 'yes' : 'no'}  questions ${state.openQuestions.length} open / ${state.answeredQuestions.length} answered`, ...(readinessColor ? { fg: readinessColor } : {}) },
    { content: `blocking gaps ${blockingGaps}  tasks ${state.tasks.length}  gates ${state.verificationGates.length}` },
    { content: `goal: ${state.goal || '(not set)'}` },
  ];
  if (state.scope) lines.push({ content: `scope: ${state.scope}` });
  if (state.knownContext.length) lines.push({ content: `known context: ${state.knownContext.join(' | ')}` });
  if (evaluation?.nextQuestion) lines.push({ content: `next question: ${evaluation.nextQuestion.prompt}`, fg: INFO });
  return lines;
}

function buildGapsLines(evaluation: ProjectPlanningEvaluation | null): TextLine[] {
  const gaps = evaluation?.gaps ?? [];
  if (gaps.length === 0) return [{ content: 'Readiness gaps: none.', fg: GOOD }];
  return [{ content: 'Readiness gaps:' }, ...gaps.slice(0, 12).map((gap) => ({ content: `  ${gap.severity.toUpperCase()} ${gap.kind}: ${gap.message}`, fg: gap.severity === 'blocking' ? BAD : WARN }))];
}

function buildTasksLines(state: ProjectPlanningState): TextLine[] {
  const lines: TextLine[] = [{ content: 'Task graph:' }];
  if (state.tasks.length === 0) {
    lines.push({ content: '  No decomposed tasks recorded yet.' });
  } else {
    for (const task of state.tasks) {
      lines.push({ content: `  ${task.id}: ${task.title} [${task.status ?? 'pending'}]${task.canRunConcurrently ? ' - concurrent' : ''}`, ...(task.blockedOnUserInput ? { fg: WARN } : {}) });
      if (task.dependencies?.length) lines.push({ content: `    dependencies: ${task.dependencies.join(', ')}` });
      if (task.verification?.length) lines.push({ content: `    verification: ${task.verification.join(' | ')}`, fg: GOOD });
    }
  }
  if (state.verificationGates.length) {
    lines.push({ content: 'Verification gates:' });
    for (const gate of state.verificationGates) lines.push({ content: `  ${gate.id}: ${gate.description} [${gate.status ?? 'pending'}]`, fg: gate.required === false ? undefined : GOOD });
  }
  if (state.agentAssignments.length) {
    lines.push({ content: 'Agent handoff candidates:' });
    for (const assignment of state.agentAssignments) lines.push({ content: `  ${assignment.taskId}: ${assignment.agentType ?? 'none'}${assignment.canRunConcurrently ? ' - can run concurrently' : ''}`, fg: INFO });
  }
  return lines;
}

function buildDecisionsLines(state: ProjectPlanningState, storedDecisions: readonly ProjectPlanningDecision[]): TextLine[] {
  const byId = new Map<string, ProjectPlanningDecision>();
  for (const decision of [...storedDecisions, ...state.decisions]) byId.set(decision.id, decision);
  const decisions = [...byId.values()];
  if (decisions.length === 0) return [{ content: 'Decisions: none recorded yet.' }];
  return [{ content: 'Decisions:' }, ...decisions.slice(0, 12).map((decision) => ({ content: `  ${decision.title}: ${decision.decision} [${decision.status ?? 'accepted'}]`, fg: decision.status === 'rejected' ? BAD : undefined }))];
}

function buildLanguageLines(language: ProjectPlanningLanguageArtifact | null): TextLine[] {
  if (!language || (language.terms.length === 0 && language.ambiguities.length === 0)) return [{ content: 'Project language: no terms or ambiguity resolutions recorded yet.' }];
  const lines: TextLine[] = [{ content: 'Project language:' }];
  for (const term of language.terms.slice(0, 8)) {
    lines.push({ content: `  ${term.term}: ${term.definition}` });
    if (term.avoid?.length) lines.push({ content: `    avoid: ${term.avoid.join(', ')}`, fg: BAD });
  }
  for (const ambiguity of language.ambiguities.slice(0, 8)) lines.push({ content: `  resolved ambiguity - ${ambiguity.phrase}: ${ambiguity.resolution}`, fg: INFO });
  return lines;
}

class PlanningModalSurface implements ConfigModalSurface {
  readonly name = 'planning-modal';
  readonly title = 'Planning';
  private snapshot: PlanningModalSnapshot | null = null;
  private loading = false;
  private requestRender: () => void = () => {};

  constructor(private readonly deps: PlanningModalDeps) {}

  readonly actions = [
    { key: 'enter', id: 'submit', label: 'submit', enabledFor: () => this.currentAnswerActions().actions.length > 0 },
    { key: 'a', id: 'approve', label: 'approve execution' },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; this.refresh(); }

  private refresh(): void {
    if (this.loading) return;
    this.loading = true;
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [status, stateResult, decisionsResult, languageResult] = await Promise.all([
        this.deps.service.status({ projectId: this.deps.projectId }),
        this.deps.service.getState({ projectId: this.deps.projectId }),
        this.deps.service.listDecisions({ projectId: this.deps.projectId }),
        this.deps.service.getLanguage({ projectId: this.deps.projectId }),
      ]);
      const evaluation = await this.deps.service.evaluate({ projectId: this.deps.projectId });
      this.snapshot = { status, state: stateResult.state, evaluation, decisions: decisionsResult.decisions, language: languageResult.language };
    } catch {
      // Leave the previous snapshot (if any) in place.
    } finally {
      this.loading = false;
      this.requestRender();
      this.deps.requestRender?.();
    }
  }

  private currentAnswerActions(): { readonly question: ProjectPlanningQuestion | null; readonly actions: readonly PlanningAnswerAction[] } {
    if (!this.snapshot?.state) return { question: null, actions: [] };
    const question = getCurrentQuestion(this.snapshot.state, this.snapshot.evaluation);
    if (!question) return { question: null, actions: [] };
    return { question, actions: buildAnswerActions(question, '') };
  }

  buildView(): ConfigModalView {
    if (!this.snapshot) {
      return { title: 'Planning', tabs: [{ id: 'planning', label: 'Planning', rows: [infoRow('load', this.loading ? 'Loading project planning state...' : 'Project planning state unavailable.', { dim: true })] }], hints: ['r refresh'] };
    }

    const { status, state, evaluation, decisions, language } = this.snapshot;
    const header = [`project ${this.deps.projectId}  space ${status?.knowledgeSpaceId ?? `project:${this.deps.projectId}`}`];
    const rows: ConfigModalRow[] = [];
    let n = 0;
    const line = (l: TextLine): void => { rows.push({ id: `p:${n++}`, label: l.content, selectable: false, ...(l.fg ? { style: { fg: l.fg } } : {}) }); };

    if (!state) {
      line({ content: 'No project planning state has been saved for this workspace.' });
      line({ content: 'Describe the intended change in normal chat to start the planning interview.', fg: undefined });
      return { title: 'Planning', tabs: [{ id: 'planning', label: 'Planning', header, rows, emptyText: '' }], hints: ['r refresh'] };
    }

    for (const l of buildStateLines(state, evaluation)) line(l);

    const { question, actions } = this.currentAnswerActions();
    if (question) {
      line({ content: 'Answer Current Question' });
      line({ content: question.prompt, fg: INFO });
      if (question.whyItMatters) line({ content: `Why this matters: ${question.whyItMatters}` });
      if (question.recommendedAnswer && !isGenericRecommendation(question.recommendedAnswer)) line({ content: `Recommendation: ${question.recommendedAnswer}`, fg: GOOD });
      for (const action of actions) {
        rows.push({ id: action.id, label: `${action.label} - ${action.detail}`, ...(action.disabled ? { selectable: false } : {}) });
      }
      line({ content: 'Note: submit reseeds the plan goal via /plan <text> (no per-question answer command exists yet).', fg: undefined });
    }

    for (const l of buildGapsLines(evaluation)) line(l);
    for (const l of buildTasksLines(state)) line(l);
    for (const l of buildDecisionsLines(state, decisions)) line(l);
    for (const l of buildLanguageLines(language)) line(l);

    return {
      title: 'Planning',
      tabs: [{ id: 'planning', label: 'Planning', header, rows, hints: [...(question ? ['enter submit'] : []), 'a approve execution'] }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reloading project planning state…'); return; }
    if (id === 'approve') { void ctx.executeCommand?.('plan', ['approve']); ctx.setStatus('Dispatched /plan approve.'); return; }
    if (id !== 'submit') return;
    const { question, actions } = this.currentAnswerActions();
    if (!question || actions.length === 0) return;
    const action = ctx.row ? actions.find((a) => a.id === ctx.row!.id) : undefined;
    if (!action || action.disabled || !action.answer.trim()) { ctx.print('Choose a non-empty answer option.'); return; }
    if (action.kind === 'approve') { void ctx.executeCommand?.('plan', ['approve']); ctx.setStatus('Dispatched /plan approve.'); return; }
    if (action.kind === 'dismiss') {
      // There is NO `/plan dismiss` subcommand. Dispatching it fell through to
      // planning-runtime's free-form goal-seed branch and OVERWROTE the project
      // goal with the literal string "dismiss". Do not dispatch and do not
      // mutate any state — print an honest note and close the panel. Planning
      // is untouched (matching the relabeled "Close (planning unchanged)" row).
      ctx.print('Pausing project planning isn\'t available as a command yet; planning state left unchanged. Closing the panel.');
      ctx.close();
      return;
    }
    void ctx.executeCommand?.('plan', action.answer.trim().split(/\s+/));
    ctx.setStatus(`Dispatched /plan ${action.answer.trim()} (reseeds the goal — see the in-modal note).`);
  }
}

export function createPlanningModalSurface(deps: PlanningModalDeps): ConfigModalSurface {
  return new PlanningModalSurface(deps);
}

function buildGoldenService(): PlanningModalService {
  const state: ProjectPlanningState = {
    id: 'golden-state-1', projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project',
    goal: 'Ship the golden fixture end-to-end.', scope: 'Golden fixture scope only.', knownContext: ['Seeded for a deterministic golden render.'],
    openQuestions: [{ id: 'golden-question-1', prompt: 'What is in scope for this golden fixture?', whyItMatters: 'Keeps the render deterministic.', recommendedAnswer: 'Use a focused first-pass scope for this goal.', status: 'open' }],
    answeredQuestions: [{ id: 'golden-question-0', prompt: 'Is this a golden fixture?', status: 'answered', answer: 'Yes.', answeredAt: 0 }],
    decisions: [], assumptions: [], constraints: [], risks: [],
    tasks: [{ id: 'golden-task-1', title: 'Implement the golden fixture', status: 'pending', dependencies: [], verification: ['bun test src/test/panels/modals/planning-modal.test.ts'] }],
    dependencies: [], verificationGates: [{ id: 'golden-gate-1', description: 'Golden render is byte-stable.', status: 'pending', required: true }],
    agentAssignments: [{ taskId: 'golden-task-1', agentType: 'worker', canRunConcurrently: false }],
    readiness: 'needs-user-input', executionApproved: false, createdAt: 0, updatedAt: 0,
  };
  const evaluation: ProjectPlanningEvaluation = {
    ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', readiness: 'needs-user-input',
    gaps: [{ id: 'golden-gap-1', kind: 'open-question', severity: 'blocking', message: 'One open question remains.' }],
    nextQuestion: state.openQuestions[0], state,
  };
  const decision: ProjectPlanningDecision = { id: 'golden-decision-1', title: 'Use a golden fixture', decision: 'Freeze all ids/timestamps for a byte-stable render.', status: 'accepted' };
  const language: ProjectPlanningLanguageArtifact = { projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', terms: [{ term: 'golden fixture', definition: 'A deterministic, frozen input used for byte-stable tests.' }], ambiguities: [], updatedAt: 0 };
  return {
    status: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', passiveOnly: true, counts: { states: 1, decisions: 1, languageArtifacts: 1, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
    getState: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', state }),
    listDecisions: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', decisions: [decision] }),
    getLanguage: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', language }),
    evaluate: async () => evaluation,
  };
}

/**
 * Deterministic golden fixture. All ids/timestamps are frozen literals. Because
 * every service method is Promise-based, this helper is async — it opens the
 * surface, waits a macrotask so the fire-and-forget load resolves, then returns.
 */
export async function planningModalGoldenSurface(): Promise<ConfigModalSurface> {
  const surface = createPlanningModalSurface({ service: buildGoldenService(), projectId: 'golden-project' });
  surface.onOpen?.(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  return surface;
}
