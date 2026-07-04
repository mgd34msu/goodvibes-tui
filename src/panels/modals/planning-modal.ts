import { MODAL_TONES } from './modal-theme.ts';
import type {
  ProjectPlanningDecision,
  ProjectPlanningEvaluation,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningQuestion,
  ProjectPlanningService,
  ProjectPlanningState,
  ProjectPlanningStatus,
} from '@pellux/goodvibes-sdk/platform/knowledge';
import type { ModalConfig, ModalSection, ModalListItem } from '../../renderer/modal-factory.ts';
import type { BoundModalSurface, ModalAction, ModalViewState } from './modal-surface.ts';
import { buildAnswerActions, isGenericRecommendation, type PlanningAnswerAction } from '../project-planning-answer-actions.ts';

// ---------------------------------------------------------------------------
// Project Planning → 'planning' modal (W6 WO-B). Mirrors
// src/panels/project-planning-panel.ts (ProjectPlanningPanel), constructed
// there as `new ProjectPlanningPanel({ service, projectId, requestRender,
// submitAnswer, dismissPlanning })`. Shows readiness/questions/decisions/task
// graph/handoff — read-only except for choosing and submitting an answer to
// the current open question, approving execution, or dismissing planning,
// all of which route to the `/plan` command (charter rule — see
// modal-surface.ts: submit/dismiss/approve are mutations, never modal-ized
// directly, and `/plan` already owns the write path via
// ProjectPlanningService.upsertState).
//
// KNOWN GAP (flagged in the work-order report, not fixed here — command
// runtimes are off-limits for this work order): `/plan` (src/input/commands/
// planning-runtime.ts) has `panel`, `approve`, `list`, `show <id>`, and a
// mode/explain/override/status/clear bridge, but no subcommand that answers
// the CURRENT open question or dismisses/pauses planning. `/plan approve`
// maps cleanly to the panel's `approveExecution()`. For "submit an answer"
// and "dismiss", the live app instead calls `submitPlanningAnswer`/
// `dismissPlanning` callbacks directly (src/runtime/bootstrap-shell.ts:
// submitPlanningAnswer feeds the answer through the normal chat prompt via
// `commandContextRef.submitInput`, not a slash command at all). Lacking any
// slash-command equivalent, this modal routes the chosen answer text through
// `/plan <answer text>` — the free-form branch of that command, which
// reseeds `state.goal` rather than resolving the specific open question, so
// this is a known-imprecise stand-in — and dismiss through `/plan dismiss`, a
// subcommand that does not exist yet. Both would need a real subcommand
// added to planning-runtime.ts to be fully correct.
// ---------------------------------------------------------------------------

/**
 * Minimal structural slice of `ProjectPlanningService`
 * (@pellux/goodvibes-sdk/platform/knowledge) this modal reads. Mutation
 * methods (upsertState, recordDecision, work-plan writes) are intentionally
 * excluded from this shape — answer submission, dismiss, and approve all
 * route to the `/plan` command path instead of calling them directly here.
 */
export type PlanningModalService = Pick<ProjectPlanningService, 'status' | 'getState' | 'listDecisions' | 'getLanguage' | 'evaluate'>;

export interface PlanningModalDeps {
  readonly service: PlanningModalService;
  readonly projectId: string;
  /**
   * Optional re-render nudge. Every `PlanningModalService` read is
   * Promise-based (service.d.ts), so `refresh()` below fires an async load
   * in the background and cannot itself trigger a host repaint once that
   * load resolves — mirrors `ProjectPlanningPanelOptions.requestRender` in
   * src/panels/project-planning-panel.ts, which exists for the same reason.
   */
  readonly requestRender?: () => void;
}

interface PlanningModalSnapshot {
  readonly status: ProjectPlanningStatus | null;
  readonly state: ProjectPlanningState | null;
  readonly evaluation: ProjectPlanningEvaluation | null;
  readonly decisions: readonly ProjectPlanningDecision[];
  readonly language: ProjectPlanningLanguageArtifact | null;
}

interface TextLine {
  readonly content: string;
  readonly fg?: string;
}

const GOOD = MODAL_TONES.good;
const WARN = MODAL_TONES.warn;
const BAD = MODAL_TONES.bad;
const INFO = MODAL_TONES.info;

function toSections(lines: readonly TextLine[]): ModalSection[] {
  return lines.map((line) => ({ type: 'text', content: line.content, ...(line.fg ? { style: { fg: line.fg } } : {}) }));
}

function getCurrentQuestion(state: ProjectPlanningState, evaluation: ProjectPlanningEvaluation | null): ProjectPlanningQuestion | null {
  const open = state.openQuestions.find((question) => (question.status ?? 'open') === 'open');
  return open ?? evaluation?.nextQuestion ?? null;
}

function buildStateLines(state: ProjectPlanningState, evaluation: ProjectPlanningEvaluation | null): TextLine[] {
  const readiness = evaluation?.readiness ?? state.readiness;
  const readinessColor = readiness === 'executable' ? GOOD : readiness === 'needs-user-input' ? WARN : undefined;
  const blockingGaps = (evaluation?.gaps ?? []).filter((gap) => gap.severity === 'blocking').length;
  const lines: TextLine[] = [
    {
      content: `readiness ${readiness}  approved ${state.executionApproved ? 'yes' : 'no'}  questions ${state.openQuestions.length} open / ${state.answeredQuestions.length} answered`,
      ...(readinessColor ? { fg: readinessColor } : {}),
    },
    { content: `blocking gaps ${blockingGaps}  tasks ${state.tasks.length}  gates ${state.verificationGates.length}` },
    { content: `goal: ${state.goal || '(not set)'}` },
  ];
  if (state.scope) lines.push({ content: `scope: ${state.scope}` });
  if (state.knownContext.length) lines.push({ content: `known context: ${state.knownContext.join(' | ')}`, fg: undefined });
  if (evaluation?.nextQuestion) lines.push({ content: `next question: ${evaluation.nextQuestion.prompt}`, fg: INFO });
  return lines;
}

function buildGapsLines(evaluation: ProjectPlanningEvaluation | null): TextLine[] {
  const gaps = evaluation?.gaps ?? [];
  if (gaps.length === 0) return [{ content: 'Readiness gaps: none.', fg: GOOD }];
  return [
    { content: 'Readiness gaps:' },
    ...gaps.slice(0, 12).map((gap) => ({
      content: `  ${gap.severity.toUpperCase()} ${gap.kind}: ${gap.message}`,
      fg: gap.severity === 'blocking' ? BAD : WARN,
    })),
  ];
}

function buildTasksLines(state: ProjectPlanningState): TextLine[] {
  const lines: TextLine[] = [{ content: 'Task graph:' }];
  if (state.tasks.length === 0) {
    lines.push({ content: '  No decomposed tasks recorded yet.' });
  } else {
    for (const task of state.tasks) {
      lines.push({
        content: `  ${task.id}: ${task.title} [${task.status ?? 'pending'}]${task.canRunConcurrently ? ' - concurrent' : ''}`,
        ...(task.blockedOnUserInput ? { fg: WARN } : {}),
      });
      if (task.dependencies?.length) lines.push({ content: `    dependencies: ${task.dependencies.join(', ')}` });
      if (task.verification?.length) lines.push({ content: `    verification: ${task.verification.join(' | ')}`, fg: GOOD });
    }
  }
  if (state.verificationGates.length) {
    lines.push({ content: 'Verification gates:' });
    for (const gate of state.verificationGates) {
      lines.push({ content: `  ${gate.id}: ${gate.description} [${gate.status ?? 'pending'}]`, fg: gate.required === false ? undefined : GOOD });
    }
  }
  if (state.agentAssignments.length) {
    lines.push({ content: 'Agent handoff candidates:' });
    for (const assignment of state.agentAssignments) {
      lines.push({ content: `  ${assignment.taskId}: ${assignment.agentType ?? 'none'}${assignment.canRunConcurrently ? ' - can run concurrently' : ''}`, fg: INFO });
    }
  }
  return lines;
}

function buildDecisionsLines(state: ProjectPlanningState, storedDecisions: readonly ProjectPlanningDecision[]): TextLine[] {
  const byId = new Map<string, ProjectPlanningDecision>();
  for (const decision of [...storedDecisions, ...state.decisions]) byId.set(decision.id, decision);
  const decisions = [...byId.values()];
  if (decisions.length === 0) return [{ content: 'Decisions: none recorded yet.' }];
  return [
    { content: 'Decisions:' },
    ...decisions.slice(0, 12).map((decision) => ({
      content: `  ${decision.title}: ${decision.decision} [${decision.status ?? 'accepted'}]`,
      fg: decision.status === 'rejected' ? BAD : undefined,
    })),
  ];
}

function buildLanguageLines(language: ProjectPlanningLanguageArtifact | null): TextLine[] {
  if (!language || (language.terms.length === 0 && language.ambiguities.length === 0)) {
    return [{ content: 'Project language: no terms or ambiguity resolutions recorded yet.' }];
  }
  const lines: TextLine[] = [{ content: 'Project language:' }];
  for (const term of language.terms.slice(0, 8)) {
    lines.push({ content: `  ${term.term}: ${term.definition}` });
    if (term.avoid?.length) lines.push({ content: `    avoid: ${term.avoid.join(', ')}`, fg: BAD });
  }
  for (const ambiguity of language.ambiguities.slice(0, 8)) {
    lines.push({ content: `  resolved ambiguity - ${ambiguity.phrase}: ${ambiguity.resolution}`, fg: INFO });
  }
  return lines;
}

/**
 * Project Planning → modal. `ProjectPlanningService` reads are all
 * Promise-based, so `refresh()` fires an async load and `buildConfig` renders
 * whatever the last-resolved snapshot holds (or a loading placeholder before
 * the first one resolves) — same fire-and-forget shape as the real panel's
 * own `refresh()`/`this.snapshot`.
 */
export function bindPlanningModal(deps: PlanningModalDeps): BoundModalSurface {
  let snapshot: PlanningModalSnapshot | null = null;
  let loading = false;

  async function load(): Promise<void> {
    try {
      const [status, stateResult, decisionsResult, languageResult] = await Promise.all([
        deps.service.status({ projectId: deps.projectId }),
        deps.service.getState({ projectId: deps.projectId }),
        deps.service.listDecisions({ projectId: deps.projectId }),
        deps.service.getLanguage({ projectId: deps.projectId }),
      ]);
      const evaluation = await deps.service.evaluate({ projectId: deps.projectId });
      snapshot = {
        status,
        state: stateResult.state,
        evaluation,
        decisions: decisionsResult.decisions,
        language: languageResult.language,
      };
    } catch {
      // Leave the previous snapshot (if any) in place — BoundModalSurface has
      // no error-line contract the way BasePanel.setError/lastError does, so
      // a failed reload just means the modal keeps showing the last-good data
      // (or the loading placeholder, if this was the first load).
    } finally {
      loading = false;
      deps.requestRender?.();
    }
  }

  function refresh(): void {
    if (loading) return;
    loading = true;
    void load();
  }

  function currentAnswerActions(view: ModalViewState): { readonly question: ProjectPlanningQuestion | null; readonly actions: readonly PlanningAnswerAction[] } {
    if (!snapshot?.state) return { question: null, actions: [] };
    const question = getCurrentQuestion(snapshot.state, snapshot.evaluation);
    if (!question) return { question: null, actions: [] };
    return { question, actions: buildAnswerActions(question, view.query) };
  }

  const buildConfig = (view: ModalViewState): ModalConfig => {
    if (!snapshot && !loading) refresh();

    if (!snapshot) {
      return {
        title: 'Planning',
        width: 84,
        sections: [{ type: 'text', content: loading ? 'Loading project planning state...' : 'Project planning state unavailable.', style: { dim: true } }],
        footer: 'esc close',
      };
    }

    const { status, state, evaluation, decisions, language } = snapshot;
    const sections: ModalSection[] = [];
    sections.push({
      type: 'text',
      content: `project ${deps.projectId}  space ${status?.knowledgeSpaceId ?? `project:${deps.projectId}`}`,
      style: { dim: true },
    });

    if (!state) {
      sections.push({ type: 'separator' });
      sections.push({ type: 'text', content: 'No project planning state has been saved for this workspace.' });
      sections.push({ type: 'text', content: 'Describe the intended change in normal chat to start the planning interview.', style: { dim: true } });
      return { title: 'Planning', width: 84, sections, hints: ['r refresh'] };
    }

    sections.push({ type: 'separator' });
    sections.push(...toSections(buildStateLines(state, evaluation)));

    const { question, actions } = currentAnswerActions(view);
    if (question) {
      sections.push({ type: 'separator' });
      sections.push({ type: 'title', content: 'Answer Current Question' });
      sections.push({ type: 'text', content: question.prompt, style: { fg: INFO } });
      if (question.whyItMatters) sections.push({ type: 'text', content: `Why this matters: ${question.whyItMatters}`, style: { dim: true } });
      if (question.recommendedAnswer && !isGenericRecommendation(question.recommendedAnswer)) {
        sections.push({ type: 'text', content: `Recommendation: ${question.recommendedAnswer}`, style: { fg: GOOD } });
      }
      const clampedIndex = actions.length > 0 ? Math.max(0, Math.min(view.selectedIndex, actions.length - 1)) : 0;
      const items: ModalListItem[] = actions.map((action, index) => ({
        label: `${action.label} - ${action.detail}`,
        selected: index === clampedIndex,
        ...(action.disabled ? { style: { dim: true } } : {}),
      }));
      sections.push({ type: 'list', items });
      sections.push({
        type: 'text',
        content: `typed answer (filter box): ${view.query || '(type while filtering to draft a custom answer)'}`,
        style: { dim: true },
      });
    }

    sections.push({ type: 'separator' });
    sections.push(...toSections(buildGapsLines(evaluation)));
    sections.push({ type: 'separator' });
    sections.push(...toSections(buildTasksLines(state)));
    sections.push({ type: 'separator' });
    sections.push(...toSections(buildDecisionsLines(state, decisions)));
    sections.push({ type: 'separator' });
    sections.push(...toSections(buildLanguageLines(language)));

    return {
      title: 'Planning',
      width: 84,
      ...(question ? { search: view.query } : {}),
      sections,
      hints: [
        ...(question ? ['up/down choose answer', 'enter submit'] : []),
        'a approve execution',
        'r refresh',
      ],
    };
  };

  const submit: ModalAction = (view) => {
    const { question, actions } = currentAnswerActions(view);
    if (!question || actions.length === 0) return { kind: 'none' };
    const index = Math.max(0, Math.min(view.selectedIndex, actions.length - 1));
    const action = actions[index];
    if (!action || action.disabled || !action.answer.trim()) {
      return { kind: 'print', text: 'Type an answer or choose a non-empty answer option.' };
    }
    if (action.kind === 'approve') return { kind: 'runCommand', command: '/plan approve' };
    // See the module-level "KNOWN GAP" comment: neither of these subcommands
    // exists on `/plan` yet.
    if (action.kind === 'dismiss') return { kind: 'runCommand', command: '/plan dismiss' };
    return { kind: 'runCommand', command: `/plan ${action.answer}` };
  };

  const approve: ModalAction = () => ({ kind: 'runCommand', command: '/plan approve' });

  return {
    name: 'planning',
    title: 'Planning',
    refresh,
    buildConfig,
    rowIds: (view) => currentAnswerActions(view).actions.map((action) => action.id),
    actions: {
      submit,
      approve,
      refresh: () => ({ kind: 'refresh' }),
    },
  };
}

function buildGoldenService(): PlanningModalService {
  const state: ProjectPlanningState = {
    id: 'golden-state-1',
    projectId: 'golden-project',
    knowledgeSpaceId: 'project:golden-project',
    goal: 'Ship the golden fixture end-to-end.',
    scope: 'Golden fixture scope only.',
    knownContext: ['Seeded for a deterministic golden render.'],
    openQuestions: [{
      id: 'golden-question-1',
      prompt: 'What is in scope for this golden fixture?',
      whyItMatters: 'Keeps the render deterministic.',
      recommendedAnswer: 'Use a focused first-pass scope for this goal.',
      status: 'open',
    }],
    answeredQuestions: [{
      id: 'golden-question-0',
      prompt: 'Is this a golden fixture?',
      status: 'answered',
      answer: 'Yes.',
      answeredAt: 0,
    }],
    decisions: [],
    assumptions: [],
    constraints: [],
    risks: [],
    tasks: [{
      id: 'golden-task-1',
      title: 'Implement the golden fixture',
      status: 'pending',
      dependencies: [],
      verification: ['bun test src/test/panels/modals/planning-modal.test.ts'],
    }],
    dependencies: [],
    verificationGates: [{
      id: 'golden-gate-1',
      description: 'Golden render is byte-stable.',
      status: 'pending',
      required: true,
    }],
    agentAssignments: [{
      taskId: 'golden-task-1',
      agentType: 'worker',
      canRunConcurrently: false,
    }],
    readiness: 'needs-user-input',
    executionApproved: false,
    createdAt: 0,
    updatedAt: 0,
  };
  const evaluation: ProjectPlanningEvaluation = {
    ok: true,
    projectId: 'golden-project',
    knowledgeSpaceId: 'project:golden-project',
    readiness: 'needs-user-input',
    gaps: [{
      id: 'golden-gap-1',
      kind: 'open-question',
      severity: 'blocking',
      message: 'One open question remains.',
    }],
    nextQuestion: state.openQuestions[0],
    state,
  };
  const decision: ProjectPlanningDecision = {
    id: 'golden-decision-1',
    title: 'Use a golden fixture',
    decision: 'Freeze all ids/timestamps for a byte-stable render.',
    status: 'accepted',
  };
  const language: ProjectPlanningLanguageArtifact = {
    projectId: 'golden-project',
    knowledgeSpaceId: 'project:golden-project',
    terms: [{ term: 'golden fixture', definition: 'A deterministic, frozen input used for byte-stable tests.' }],
    ambiguities: [],
    updatedAt: 0,
  };
  return {
    status: async () => ({
      ok: true,
      projectId: 'golden-project',
      knowledgeSpaceId: 'project:golden-project',
      passiveOnly: true,
      counts: { states: 1, decisions: 1, languageArtifacts: 1, workPlans: 0, workPlanTasks: 0 },
      capabilities: [],
    }),
    getState: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', state }),
    listDecisions: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', decisions: [decision] }),
    getLanguage: async () => ({ ok: true, projectId: 'golden-project', knowledgeSpaceId: 'project:golden-project', language }),
    evaluate: async () => evaluation,
  };
}

/**
 * Deterministic golden fixture. All ids/timestamps are frozen literals (no
 * Date.now(), no random ids). Because every `PlanningModalService` method is
 * Promise-based, this helper is async (unlike the sync marketplace/plugins
 * goldens) — it calls `surface.refresh()` and then waits a macrotask so the
 * fire-and-forget load has resolved before returning, keeping the fixture
 * deterministic without adding a test-only escape hatch to the surface.
 */
export async function planningModalGoldenSurface(): Promise<BoundModalSurface> {
  const surface = bindPlanningModal({ service: buildGoldenService(), projectId: 'golden-project' });
  surface.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return surface;
}
