import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GitService } from '../../git/service.ts';
import type { ToolLLM } from '../../config/tool-llm.ts';
import type { AnalyzeInput, SemanticDiffSummary } from './types.ts';
import { summarizeError } from '../../utils/error-display.ts';
import {
  isBreakingUpgrade,
  loadDependencyVersions,
  parseDiffStats,
  parseSemver,
  readJsonFile,
  truncateDiffAtBoundary,
  validateGitRefs,
} from './shared.ts';

function parseSemanticDiffResponse(
  llmResponse: string | null,
  changedFiles: string[],
): SemanticDiffSummary {
  let summary = 'LLM unavailable — diff available in raw_diff field.';
  let impact: string[] = changedFiles.map((f) => `Changed file: ${f}`);
  let risk: 'low' | 'medium' | 'high' = 'medium';

  if (llmResponse) {
    try {
      const cleaned = llmResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(cleaned) as {
        summary?: string;
        impact?: unknown[];
        risk?: string;
      };
      if (typeof parsed.summary === 'string') summary = parsed.summary;
      if (Array.isArray(parsed.impact)) {
        impact = parsed.impact.map((i) => String(i));
      }
      if (parsed.risk === 'low' || parsed.risk === 'medium' || parsed.risk === 'high') {
        risk = parsed.risk;
      }
    } catch {
      summary = llmResponse.slice(0, 500);
    }
  }

  return { summary, impact, risk };
}

function buildSemanticDiffFallback(
  fullDiff: string,
  changedFiles: string[],
): SemanticDiffSummary {
  const hasAsyncShift = /\basync\s+function\b|\bawait\b/.test(fullDiff);
  const hasExportShift = /^\s*[+-]\s*export\s/m.test(fullDiff);
  const hasSignatureShift = /^\s*[+-].*\([^)]*\)/m.test(fullDiff);
  const hasBehaviorShift =
    /^\s*[+-].*\breturn\b/m.test(fullDiff) ||
    /^\s*[+-].*\bthrow\b/m.test(fullDiff) ||
    /^\s*[+-].*\bif\b/m.test(fullDiff);

  let risk: 'low' | 'medium' | 'high' = 'low';
  if (hasExportShift || hasSignatureShift) {
    risk = 'high';
  } else if (hasAsyncShift || hasBehaviorShift || changedFiles.length > 1) {
    risk = 'medium';
  }

  const summaryParts: string[] = [];
  if (changedFiles.length === 0) {
    summaryParts.push('No changed files were detected in the requested diff.');
  } else if (changedFiles.length === 1) {
    summaryParts.push(`Changed ${changedFiles[0]}.`);
  } else {
    summaryParts.push(`Changed ${changedFiles.length} files.`);
  }
  if (hasAsyncShift) {
    summaryParts.push('The diff introduces or expands asynchronous behavior.');
  }
  if (hasExportShift || hasSignatureShift) {
    summaryParts.push('Public callable surfaces or signatures changed.');
  } else if (hasBehaviorShift) {
    summaryParts.push('The implementation behavior changed within existing code paths.');
  }

  const impact = changedFiles.map((file) => `Review downstream callers and tests for ${file}.`);
  return {
    summary: summaryParts.join(' ').trim() || 'Diff analyzed without LLM assistance.',
    impact,
    risk,
  };
}

async function trySemanticDiffLlm(
  toolLLM: Pick<ToolLLM, 'chat'>,
  prompt: string,
): Promise<string> {
  try {
    return await Promise.race([
      toolLLM.chat(prompt, { maxTokens: 512 }),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 1200)),
    ]);
  } catch {
    return '';
  }
}

export async function runDiff(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = new GitService(projectRoot);

  let statOutput: string;
  try {
    statOutput = await git.diffStat(before, after);
  } catch (err) {
    return { error: `git diff failed: ${summarizeError(err)}`, before, after };
  }

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch {
    fullDiff = '';
  }

  return {
    before,
    after,
    stat: statOutput.trim(),
    files: parseDiffStats(statOutput),
    diff: fullDiff.slice(0, 10000),
  };
}

function extractSignaturesFromDiff(diff: string): {
  before: Map<string, string>;
  after: Map<string, string>;
} {
  const before = new Map<string, string>();
  const after = new Map<string, string>();

  const lines = diff.split('\n');
  const exportLinePattern =
    /^([+-])\s*export\s+(?:(?:async|default|declare)\s+)*(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(exportLinePattern);
    if (!m) continue;

    const marker = m[1] as '-' | '+';
    const name = m[2];
    let rest = m[3];

    if (!rest.includes('{') && !rest.includes(';')) {
      for (let j = i + 1; j < lines.length; j++) {
        const contLine = lines[j];
        if (!contLine.startsWith(marker) && !contLine.startsWith(' ')) break;
        const stripped = contLine.startsWith(marker)
          ? contLine.slice(1)
          : contLine.slice(1);
        rest += ' ' + stripped.trim();
        if (stripped.includes('{') || stripped.includes(';')) break;
      }
    }

    const braceIdx = rest.indexOf('{');
    const sig = `${name}${braceIdx >= 0 ? rest.slice(0, braceIdx).trimEnd() : rest.replace(/;.*$/, '').trimEnd()}`;

    if (marker === '-') {
      before.set(name, sig);
    } else {
      after.set(name, sig);
    }
  }

  return { before, after };
}

export async function runBreaking(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = new GitService(projectRoot);

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch (err) {
    return { error: `git diff failed: ${summarizeError(err)}`, before, after };
  }

  const { before: beforeSigs, after: afterSigs } = extractSignaturesFromDiff(fullDiff);
  const breaking_changes: Array<{ name: string; before: string; after: string; reason: string }> = [];
  const additions: Array<{ name: string; signature: string }> = [];
  const safe_modifications: Array<{ name: string; before: string; after: string }> = [];

  for (const [name, sig] of beforeSigs) {
    if (!afterSigs.has(name)) {
      breaking_changes.push({
        name,
        before: sig,
        after: '(removed)',
        reason: 'export removed',
      });
    } else {
      const newSig = afterSigs.get(name)!;
      if (sig !== newSig) {
        breaking_changes.push({
          name,
          before: sig,
          after: newSig,
          reason: 'signature changed',
        });
      } else {
        safe_modifications.push({ name, before: sig, after: newSig });
      }
    }
  }

  for (const [name, sig] of afterSigs) {
    if (!beforeSigs.has(name)) {
      additions.push({ name, signature: sig });
    }
  }

  return {
    before,
    after,
    breaking_changes,
    additions,
    safe_modifications,
    total_breaking: breaking_changes.length,
    total_additions: additions.length,
  };
}

export async function runSemanticDiff(
  input: AnalyzeInput,
  projectRoot: string,
  toolLLM: Pick<ToolLLM, 'chat'>,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = new GitService(projectRoot);

  let fullDiff: string;
  let statOutput: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
    statOutput = await git.diffStat(before, after);
  } catch (err) {
    return { error: `git diff failed: ${summarizeError(err)}`, before, after };
  }

  const changedFiles = parseDiffStats(statOutput).map((file) => file.file);
  const fallback = buildSemanticDiffFallback(fullDiff, changedFiles);
  const truncatedDiff = truncateDiffAtBoundary(fullDiff, 6000);
  const prompt =
    `You are a code reviewer. Analyze the following git diff and provide:
1. A concise summary of what changed and why (2-4 sentences)
2. Impact analysis: list the downstream functions/modules/callers that may be affected
3. Risk level: low (pure additions/docs), medium (refactors, optional param changes), or high (API removals, signature changes, behavior changes)

Respond in JSON with fields: summary (string), impact (array of strings), risk ("low"|"medium"|"high")

Diff (${before}..${after}):
${truncatedDiff}`;

  const llmResponse = await trySemanticDiffLlm(toolLLM, prompt);
  const { summary, impact, risk } = llmResponse
    ? parseSemanticDiffResponse(llmResponse, changedFiles)
    : fallback;

  return {
    before,
    after,
    summary,
    impact,
    risk,
    changed_files: changedFiles,
  };
}

export async function runUpgrade(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  let packageNames: string[];

  if (input.packages && input.packages.length > 0) {
    packageNames = input.packages;
  } else {
    const pkgPath = join(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      return { error: 'No package.json found and no packages specified', projectRoot };
    }
    const pkgJson = await readJsonFile(pkgPath);
    if (pkgJson === null) {
      return { error: 'Failed to parse package.json' };
    }
    const deps = loadDependencyVersions(pkgJson);
    packageNames = Object.keys(deps);
    if (packageNames.length === 0) {
      return { packages: [], total: 0, outdated: 0, breaking: 0 };
    }
  }

  const currentVersions: Record<string, string> = {};
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkgJson = await readJsonFile(pkgPath);
      if (pkgJson === null) {
        throw new Error('Failed to parse package.json');
      }
      const allDeps = loadDependencyVersions(pkgJson);
      for (const [name, ver] of Object.entries(allDeps)) {
        currentVersions[name] = ver;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const BATCH_SIZE = 20;
  const batch = packageNames.slice(0, BATCH_SIZE);
  const results: Array<{ name: string; current: string; latest: string; breaking: boolean }> = [];

  await Promise.all(
    batch.map(async (name) => {
      const current = currentVersions[name] ?? 'unknown';
      try {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          results.push({ name, current, latest: 'unknown', breaking: false });
          return;
        }
        const data = await res.json() as { version?: string };
        const latest = data.version ?? 'unknown';
        const breaking = current !== 'unknown' && latest !== 'unknown'
          ? isBreakingUpgrade(current, latest)
          : false;
        results.push({ name, current, latest, breaking });
      } catch {
        results.push({ name, current, latest: 'fetch_failed', breaking: false });
      }
    }),
  );

  results.sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    packages: results,
    total: results.length,
    outdated: results.filter((r) => r.latest !== 'unknown' && r.latest !== r.current && r.latest !== 'fetch_failed').length,
    breaking: results.filter((r) => r.breaking).length,
  };
}
