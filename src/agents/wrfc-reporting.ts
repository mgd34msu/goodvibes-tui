import type { CompletionReport, EngineerReport, ReviewerReport } from '@pellux/goodvibes-sdk/platform/agents/completion-report';
import { parseCompletionReport } from '@pellux/goodvibes-sdk/platform/agents/completion-report';
import type { QualityGateResult } from '@pellux/goodvibes-sdk/platform/agents/wrfc-types';
import { logger } from '@pellux/goodvibes-sdk/platform/utils/logger';

const REVIEW_BRIEF_ITEM_LIMIT = 6;
const REVIEW_BRIEF_FILE_LIMIT = 8;
const REVIEW_BRIEF_TEXT_LIMIT = 220;

export function extractScoreFromText(text: string): number | null {
  const scorePattern = /\*{0,2}(?:overall\s+)?score\s*:?\s*\*{0,2}\s*(\d+(?:\.\d+)?)\s*\/\s*10/i;
  const matchScore = text.match(scorePattern);
  if (matchScore) {
    const value = parseFloat(matchScore[1]);
    if (value <= 10) return value;
  }

  const slashPattern = /(\d+(?:\.\d+)?)\s*\/\s*10/;
  const matchSlash = text.match(slashPattern);
  if (matchSlash) {
    const value = parseFloat(matchSlash[1]);
    if (value <= 10) return value;
  }

  const ratedPattern = /\b(?:rated|scored|rating)\s*:?\s*(\d+(?:\.\d+)?)/i;
  const matchRated = text.match(ratedPattern);
  if (matchRated) {
    const value = parseFloat(matchRated[1]);
    if (value <= 10) return value;
  }

  return null;
}

export function extractPassedFromText(text: string, score: number, threshold: number): boolean {
  if (score >= threshold) return true;
  if (/\bpass(ed|es|ing)?\b/i.test(text) && !/\bfail/i.test(text)) return true;
  if (/\bapproved?\b/i.test(text)) return true;
  return false;
}

export function extractIssuesFromText(text: string): ReviewerReport['issues'] {
  const issues: ReviewerReport['issues'] = [];
  const issuePattern = /(?:^|\n)\s*(?:\d+\.\s*|-\s*|\*\s*)?(?:\*{1,2})?\[?\(?(critical|major|minor|suggestion)\)?\]?(?:\*{1,2})?[\s:*]*(.+)/gi;
  let match: RegExpExecArray | null;
  while ((match = issuePattern.exec(text)) !== null) {
    const severity = match[1].toLowerCase() as 'critical' | 'major' | 'minor' | 'suggestion';
    issues.push({
      severity,
      description: match[2].trim(),
      pointValue: severity === 'critical' ? 3 : severity === 'major' ? 2 : 1,
    });
  }
  return issues;
}

export function parseEngineerCompletionReport(rawOutput: string, _template?: string): CompletionReport {
  const report = parseCompletionReport(rawOutput);
  if (report) return report;
  return {
    version: 1,
    archetype: 'engineer',
    summary: rawOutput.slice(0, 500) || '(no output)',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: [],
    filesCreated: [],
    filesModified: [],
    filesDeleted: [],
    decisions: [],
    issues: [],
    uncertainties: [],
  } as EngineerReport;
}

export function parseReviewerCompletionReport(
  chainId: string,
  rawOutput: string,
  threshold: number,
): ReviewerReport {
  const reviewerReport = parseCompletionReport(rawOutput);
  if (reviewerReport && reviewerReport.archetype === 'reviewer') {
    return reviewerReport as ReviewerReport;
  }

  const extractedScore = extractScoreFromText(rawOutput);
  const extractedPassed = extractedScore !== null
    ? extractPassedFromText(rawOutput, extractedScore, threshold)
    : false;
  const extractedIssues = extractIssuesFromText(rawOutput);

  logger.warn('WrfcController: no structured ReviewerReport found, extracting from text', {
    chainId,
    extractedScore,
  });
  if (extractedScore === null) {
    logger.warn('WrfcController: score extraction returned null, defaulting to 0', { chainId });
  }

  return {
    version: 1,
    archetype: 'reviewer',
    summary: rawOutput.slice(0, 500) || '(no reviewer output)',
    score: extractedScore ?? 0,
    passed: extractedPassed,
    dimensions: [],
    issues: extractedIssues,
  };
}

export function buildReviewTask(
  chainId: string,
  report: CompletionReport,
  threshold: number,
): string {
  const lines = buildReviewBrief(report);
  return [
    `WRFC Review Request`,
    `Chain ID: ${chainId}`,
    ``,
    `Engineer report digest:`,
    ...lines,
    ``,
    `Instructions:`,
    `1. Read the referenced files directly before scoring. Do not rely on this digest alone.`,
    `2. Inspect the engineer's gatheredContext, plannedActions, appliedChanges, and decisions for discipline and coherence.`,
    `3. Verify the implementation meets all stated requirements.`,
    `4. Score the implementation using the 10-dimension review rubric.`,
    `5. The passing score threshold is ${threshold}/10.`,
    `6. Return a structured ReviewerReport JSON block in your final response.`,
    ``,
    `The ReviewerReport must include:`,
    `- version: 1`,
    `- archetype: "reviewer"`,
    `- score: <number 0-10>`,
    `- passed: <boolean>`,
    `- dimensions: array of { name, score, maxScore, issues[] }`,
    `- issues: array of { severity, description, file?, line?, pointValue }`,
  ].join('\n');
}

function truncateReviewText(text: string, max = REVIEW_BRIEF_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function formatInlineList(items: readonly string[], limit: number): string {
  if (items.length === 0) return 'none';
  const visible = items.slice(0, limit).map((item) => truncateReviewText(item, 120));
  if (items.length <= limit) return visible.join(', ');
  return `${visible.join(', ')} (+${items.length - limit} more)`;
}

function appendListSection(
  lines: string[],
  title: string,
  items: readonly string[],
  limit = REVIEW_BRIEF_ITEM_LIMIT,
): void {
  if (items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items.slice(0, limit)) {
    lines.push(`- ${truncateReviewText(item)}`);
  }
  if (items.length > limit) {
    lines.push(`- (+${items.length - limit} more)`);
  }
}

function appendDecisionSection(
  lines: string[],
  decisions: EngineerReport['decisions'],
  limit = 4,
): void {
  if (decisions.length === 0) return;
  lines.push('Decisions:');
  for (const decision of decisions.slice(0, limit)) {
    lines.push(`- ${truncateReviewText(decision.what, 120)} | why: ${truncateReviewText(decision.why, 120)}`);
  }
  if (decisions.length > limit) {
    lines.push(`- (+${decisions.length - limit} more)`);
  }
}

function normalizeEngineerReport(report: CompletionReport): EngineerReport {
  const candidate = report as Partial<EngineerReport>;
  return {
    version: 1,
    archetype: 'engineer',
    summary: typeof candidate.summary === 'string' ? candidate.summary : '(no summary)',
    ...(typeof candidate.wrfcId === 'string' ? { wrfcId: candidate.wrfcId } : {}),
    gatheredContext: Array.isArray(candidate.gatheredContext) ? candidate.gatheredContext.filter((item): item is string => typeof item === 'string') : [],
    plannedActions: Array.isArray(candidate.plannedActions) ? candidate.plannedActions.filter((item): item is string => typeof item === 'string') : [],
    appliedChanges: Array.isArray(candidate.appliedChanges) ? candidate.appliedChanges.filter((item): item is string => typeof item === 'string') : [],
    filesCreated: Array.isArray(candidate.filesCreated) ? candidate.filesCreated.filter((item): item is string => typeof item === 'string') : [],
    filesModified: Array.isArray(candidate.filesModified) ? candidate.filesModified.filter((item): item is string => typeof item === 'string') : [],
    filesDeleted: Array.isArray(candidate.filesDeleted) ? candidate.filesDeleted.filter((item): item is string => typeof item === 'string') : [],
    decisions: Array.isArray(candidate.decisions)
      ? candidate.decisions.filter((decision): decision is { what: string; why: string } =>
        Boolean(decision) &&
        typeof decision === 'object' &&
        typeof decision.what === 'string' &&
        typeof decision.why === 'string')
      : [],
    issues: Array.isArray(candidate.issues) ? candidate.issues.filter((item): item is string => typeof item === 'string') : [],
    uncertainties: Array.isArray(candidate.uncertainties) ? candidate.uncertainties.filter((item): item is string => typeof item === 'string') : [],
  };
}

function buildReviewBrief(report: CompletionReport): string[] {
  const engineer = normalizeEngineerReport(report);
  const lines = [
    `- Summary: ${truncateReviewText(engineer.summary)}`,
    `- Files created (${engineer.filesCreated.length}): ${formatInlineList(engineer.filesCreated, REVIEW_BRIEF_FILE_LIMIT)}`,
    `- Files modified (${engineer.filesModified.length}): ${formatInlineList(engineer.filesModified, REVIEW_BRIEF_FILE_LIMIT)}`,
    `- Files deleted (${engineer.filesDeleted.length}): ${formatInlineList(engineer.filesDeleted, REVIEW_BRIEF_FILE_LIMIT)}`,
  ];

  appendListSection(lines, 'Gathered context', engineer.gatheredContext);
  appendListSection(lines, 'Planned actions', engineer.plannedActions);
  appendListSection(lines, 'Applied changes', engineer.appliedChanges);
  appendDecisionSection(lines, engineer.decisions);
  appendListSection(lines, 'Known issues', engineer.issues, 4);
  appendListSection(lines, 'Uncertainties', engineer.uncertainties, 4);

  return lines;
}

export function buildFixTask(
  chainId: string,
  review: ReviewerReport,
  threshold: number,
  fixAttempts: number,
): string {
  const issueList = review.issues
    .map((issue) => {
      const location = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ''})` : '';
      return `- [${issue.severity.toUpperCase()}] ${issue.description}${location} (-${issue.pointValue} pts)`;
    })
    .join('\n');
  return [
    `WRFC Fix Request`,
    `Chain ID: ${chainId}`,
    ``,
    `Review score: ${review.score}/10 (threshold: ${threshold}/10)`,
    `Fix attempt: ${fixAttempts}`,
    ``,
    `Issues to address:`,
    issueList || '(no structured issues — see review summary)',
    ``,
    `Review summary: ${review.summary}`,
    ``,
    `Instructions:`,
    `1. Address ALL issues listed above, prioritizing critical and major items.`,
    `2. Fix each issue completely — partial fixes will reduce your score.`,
    `3. Re-run Gather, Plan, Apply explicitly before writing your final answer.`,
    `4. Return a structured EngineerReport JSON block including gatheredContext, plannedActions, and appliedChanges in your final response.`,
  ].join('\n');
}

export function buildGateFailureTask(
  chainId: string,
  task: string,
  failedGates: readonly QualityGateResult[],
): string {
  const gateFailureSummary = failedGates
    .map((result) => `- ${result.gate}: ${result.output.slice(0, 300)}`)
    .join('\n');
  return [
    `WRFC Gate Failure Fix`,
    `Parent Chain ID: ${chainId}`,
    ``,
    `The following quality gates failed after review passed:`,
    gateFailureSummary,
    ``,
    `Original task: ${task}`,
    ``,
    `Instructions:`,
    `1. Fix all gate failures listed above.`,
    `2. Ensure typecheck, lint, and test gates pass.`,
    `3. Return a structured EngineerReport in your final response.`,
  ].join('\n');
}
