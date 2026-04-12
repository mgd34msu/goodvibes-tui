import { CodeIntelligence, uriToPath } from '../../intelligence/index.ts';
import type { ReferencesQuery, OutputOptions } from './shared.ts';
import { collectTextFiles, makeCountResult, makeFilesResult, makeLocationsResult, readTextFile } from './shared.ts';

export async function executeReferencesQuery(
  query: ReferencesQuery,
  output: OutputOptions,
): Promise<Record<string, unknown>> {
  const projectRoot = process.cwd();
  const maxResults = output.max_results ?? 100;

  interface ReferenceLocation { file: string; line: number; }
  let locations: ReferenceLocation[] = [];

  const ci = new CodeIntelligence();
  try {
    const lspLocations = await ci.getReferences(query.file, query.line, query.column);
    if (lspLocations.length > 0) {
      for (const loc of lspLocations) {
        if (locations.length >= maxResults) break;
        try {
          const filePath = uriToPath(loc.uri);
          locations.push({ file: filePath, line: loc.range.start.line + 1 });
        } catch {
          // skip invalid URIs
        }
      }

      if (output.format === 'count_only') return makeCountResult(locations.length);
      if (output.format === 'files_only') {
        const uniqueFiles = [...new Set(locations.map((l) => l.file))];
        return makeFilesResult(uniqueFiles, locations.length);
      }
      return makeLocationsResult(locations, locations.length);
    }
  } catch {
    // LSP unavailable — fall through to grep fallback
  }

  if (!query.symbol) {
    return makeLocationsResult([], 0, 'fallback');
  }

  let regex: RegExp;
  try {
    regex = new RegExp(`\\b${query.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  } catch {
    return { error: `Invalid symbol name: ${query.symbol}` };
  }

  const files = await collectTextFiles(projectRoot);
  for (const file of files) {
    if (locations.length >= maxResults) break;
    const content = await readTextFile(file);
    if (content === null) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (locations.length >= maxResults) break;
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        locations.push({ file, line: i + 1 });
      }
    }
  }

  if (output.format === 'count_only') return makeCountResult(locations.length, 'fallback');
  if (output.format === 'files_only') {
    const uniqueFiles = [...new Set(locations.map((l) => l.file))];
    return makeFilesResult(uniqueFiles, locations.length, 'fallback');
  }
  return makeLocationsResult(locations, locations.length, 'fallback');
}
