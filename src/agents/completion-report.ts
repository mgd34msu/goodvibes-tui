/**
 * Structured completion reports — per-archetype output contracts.
 * Agents include these in their final output. The WrfcController extracts them.
 */

/** Base fields shared by all completion reports. */
export interface BaseCompletionReport {
  version: 1;
  archetype: string;
  summary: string;
  wrfcId?: string;
}

/** Engineer agent completion report. */
export interface EngineerReport extends BaseCompletionReport {
  archetype: 'engineer';
  gatheredContext: string[];
  plannedActions: string[];
  appliedChanges: string[];
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  decisions: Array<{ what: string; why: string }>;
  issues: string[];
  uncertainties: string[];
}

/** Reviewer agent completion report. */
export interface ReviewerReport extends BaseCompletionReport {
  archetype: 'reviewer';
  score: number;
  passed: boolean;
  dimensions: Array<{
    name: string;
    score: number;
    maxScore: number;
    issues: string[];
  }>;
  issues: Array<{
    severity: 'critical' | 'major' | 'minor' | 'suggestion';
    description: string;
    file?: string;
    line?: number;
    pointValue: number;
  }>;
}

/** Tester agent completion report. */
export interface TesterReport extends BaseCompletionReport {
  archetype: 'tester';
  testsWritten: string[];
  testsPassed: number;
  testsFailed: number;
  coverage?: { lines: number; branches: number; functions: number };
  failures: Array<{ test: string; error: string }>;
}

/** Generic completion report for other archetypes. */
export interface GenericReport extends BaseCompletionReport {
  /** Archetype name. For non-standard archetypes (not engineer/reviewer/tester). */
  archetype: string;
  result: string;
}

export type CompletionReport = EngineerReport | ReviewerReport | TesterReport | GenericReport;

/**
 * Parse a completion report from raw LLM output.
 * Looks for a JSON block delimited by ```json\n{...}\n``` or a bare JSON object
 * with a "version": 1 field.
 * Returns null if no valid report found.
 */
export function parseCompletionReport(rawOutput: string): CompletionReport | null {
  // Strategy 1: Find ```json ... ``` block
  const jsonBlockMatch = rawOutput.match(/```json\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed.version === 1 && parsed.archetype) return parsed as CompletionReport;
    } catch { /* fall through */ }
  }

  // Strategy 2: Brace-counting extraction — find "version": 1, walk backward for opening {,
  // then forward counting braces to find the matching }. Avoids greedy regex over-matching.
  const versionIdx = rawOutput.indexOf('"version"');
  if (versionIdx !== -1) {
    // Walk backward to find opening brace
    let openBrace = -1;
    for (let i = versionIdx - 1; i >= 0; i--) {
      if (rawOutput[i] === '{') { openBrace = i; break; }
    }
    if (openBrace !== -1) {
      // Walk forward with brace counting to find matching close
      let depth = 0;
      let closeBrace = -1;
      for (let i = openBrace; i < rawOutput.length; i++) {
        if (rawOutput[i] === '{') depth++;
        else if (rawOutput[i] === '}') {
          depth--;
          if (depth === 0) { closeBrace = i; break; }
        }
      }
      if (closeBrace !== -1) {
        const candidate = rawOutput.slice(openBrace, closeBrace + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed.version === 1 && parsed.archetype) return parsed as CompletionReport;
        } catch { /* fall through */ }
      }
    }
  }

  return null;
}
