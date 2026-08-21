import type { ProjectPlanningQuestion } from '@pellux/goodvibes-sdk/platform/knowledge';

// ---------------------------------------------------------------------------
// Answer-action helpers for the Project Planning panel.
//
// Extracted from project-planning-panel.ts to keep that module under the
// architecture line-count cap. Leaf module (only the SDK question type);
// the panel is their public import site.
// ---------------------------------------------------------------------------

export interface PlanningAnswerAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly answer: string;
  readonly kind?: 'answer' | 'approve';
  readonly disabled?: boolean;
}

/** SDK placeholder recommendations that carry no real signal, never surfaced as an answer action. */
export function isGenericRecommendation(value: string): boolean {
  return /\bdefine the first-pass scope\b/i.test(value)
    || /\bcreate task records\b/i.test(value)
    || /\brecord concrete tests\b/i.test(value)
    || /\bseparate out-of-scope work\b/i.test(value);
}

function compactAnswerDetail(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 86 ? `${normalized.slice(0, 83)}...` : normalized;
}

/**
 * Builds the answer-action list for the current question: keyword-matched
 * canned suggestions first (de-duplicated by normalized answer text, a
 * question that matches more than one keyword category, e.g. scope +
 * recommendedAnswer echoing one of the scope answers verbatim, must not show
 * the same suggested answer twice), then the fixed ask-narrower/custom actions.
 *
 * dismissing planning is no longer a pseudo answer-row, it is a
 * first-class confirmed modal action (the `d` key), so no dismiss row is
 * produced here. A canned answer records against the current open question via
 * /plan answer; the custom row's free-form text is submitted to chat.
 */
export function buildAnswerActions(question: ProjectPlanningQuestion, draftAnswer: string): PlanningAnswerAction[] {
  const canned: PlanningAnswerAction[] = [];
  const prompt = question.prompt.toLowerCase();
  const isScopeQuestion = prompt.includes('scope') || prompt.includes('in or out');
  const isTaskQuestion = prompt.includes('task') || prompt.includes('dependency') || prompt.includes('work breakdown');
  const isVerificationQuestion = prompt.includes('verification') || prompt.includes('test') || prompt.includes('prove');
  const isApprovalQuestion = prompt.includes('approved') || prompt.includes('approve') || prompt.includes('execution');
  if (isApprovalQuestion) {
    canned.push({
      id: 'approve-execution',
      label: 'Approve execution',
      detail: 'Mark this plan approved so execution may proceed.',
      answer: 'Approve this planning state for execution.',
      kind: 'approve',
    });
  }
  if (isScopeQuestion) {
    canned.push({
      id: 'scope-focused-first-pass',
      label: 'Use focused first-pass scope',
      detail: 'Fill a concrete end-to-end scope for this goal and keep unrelated work out.',
      answer: 'Use a focused first-pass scope for this goal.',
    });
  }
  if (isTaskQuestion) {
    canned.push({
      id: 'tasks-default-breakdown',
      label: 'Create default task breakdown',
      detail: 'Create inspect, implement, wire, and verify tasks with dependencies.',
      answer: 'Create the default task breakdown for this goal.',
    });
  }
  if (isVerificationQuestion) {
    canned.push({
      id: 'verification-default-gates',
      label: 'Use standard verification gates',
      detail: 'Require focused regression coverage, typecheck/build validation, and a runtime smoke where feasible.',
      answer: 'Use standard verification gates for this goal.',
    });
  }
  if (question.recommendedAnswer?.trim() && !isGenericRecommendation(question.recommendedAnswer)) {
    canned.push({
      id: 'recommended',
      label: 'Use recommended answer',
      detail: compactAnswerDetail(question.recommendedAnswer),
      answer: question.recommendedAnswer,
    });
  }
  if (isScopeQuestion) {
    canned.push({
      id: 'scope-end-to-end',
      label: 'End-to-end required scope',
      detail: 'Let the plan include every component needed to make this work, but avoid unrelated cleanup.',
      answer: 'Scope is everything required to make the requested outcome work end-to-end. Include TUI, daemon composition, configuration, docs, and tests if they are required. Do not include unrelated cleanup or broad refactors unless they are necessary for this task.',
    });
    canned.push({
      id: 'scope-tui-first',
      label: 'TUI-first scope',
      detail: 'Fix TUI behavior here; report SDK blockers instead of patching around SDK-owned bugs.',
      answer: 'Scope is TUI-owned behavior first. If a blocker is SDK-owned, report the exact SDK contract/runtime issue instead of patching around it in the TUI. Include daemon composition only where the TUI owns the wiring.',
    });
  }

  const seenAnswers = new Set<string>();
  const actions: PlanningAnswerAction[] = [];
  for (const action of canned) {
    const key = action.answer.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length > 0 && seenAnswers.has(key)) continue;
    if (key.length > 0) seenAnswers.add(key);
    actions.push(action);
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
    detail: draftAnswer ? compactAnswerDetail(draftAnswer) : 'Type an answer first; this row submits it to chat.',
    answer: draftAnswer.trim(),
    disabled: !draftAnswer.trim(),
  });
  return actions;
}
