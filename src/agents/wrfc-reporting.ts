import type { CompletionReport, ReviewerReport } from './completion-report.ts';
import { parseCompletionReport } from './completion-report.ts';
import { logger } from '../utils/logger.ts';

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

export function parseEngineerCompletionReport(rawOutput: string, template?: string): CompletionReport {
  const report = parseCompletionReport(rawOutput);
  if (report) return report;
  return {
    version: 1,
    archetype: template ?? 'engineer',
    summary: rawOutput.slice(0, 500) || '(no output)',
    gatheredContext: [],
    plannedActions: [],
    appliedChanges: [],
    result: rawOutput,
  } as CompletionReport;
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
  return [
    `WRFC Review Request`,
    `Chain ID: ${chainId}`,
    ``,
    `Engineer completion report:`,
    `\`\`\`json`,
    JSON.stringify(report, null, 2),
    `\`\`\``,
    ``,
    `Instructions:`,
    `1. Read all files listed in the engineer report (filesCreated, filesModified).`,
    `2. Inspect the engineer's gatheredContext, plannedActions, and appliedChanges for discipline and coherence.`,
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
