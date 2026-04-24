import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const ARTIFACT_PATH = join(REPO_ROOT, 'docs', 'wrfc', 'wrfc-a7c9e318-engineer-report.json');

describe('wrfc-a7c9e318 artifact', () => {
  test('stores a task-specific engineer report artifact with changed files', () => {
    expect(existsSync(ARTIFACT_PATH)).toBe(true);

    const report = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      version: number;
      archetype: string;
      wrfcId: string | null;
      filesCreated: string[];
      filesModified: string[];
      filesDeleted: string[];
      appliedChanges: string[];
    };

    expect(report.version).toBe(1);
    expect(report.archetype).toBe('engineer');
    expect(report.wrfcId).toBe('wrfc-a7c9e318');
    expect(report.filesCreated).toContain('docs/wrfc/wrfc-a7c9e318-engineer-report.json');
    expect(report.filesModified).toContain('src/test/agents/wrfc-reporting.test.ts');
    expect(report.filesModified).toContain('src/test/agents/wrfc-controller.test.ts');
    expect(report.filesCreated.length + report.filesModified.length + report.filesDeleted.length).toBeGreaterThan(0);
    expect(report.appliedChanges.some((entry) => entry.includes('wrfc-a7c9e318'))).toBe(true);
  });
});
