import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { BRIEF_TOOL_SCHEMA, type BriefToolInput } from './schema.ts';

interface BriefRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly goals: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly audience?: string;
  readonly status: 'draft' | 'published';
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt?: number;
}

const BRIEFS_PATH = join('.goodvibes', 'tui', 'briefs.json');

function loadBriefs(): BriefRecord[] {
  try {
    return JSON.parse(readFileSync(BRIEFS_PATH, 'utf-8')) as BriefRecord[];
  } catch {
    return [];
  }
}

function saveBriefs(records: readonly BriefRecord[]): void {
  mkdirSync(join('.goodvibes', 'tui'), { recursive: true });
  writeFileSync(BRIEFS_PATH, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

export const briefTool: Tool = {
  definition: {
    name: 'brief',
    description: 'Manage durable implementation briefs and published execution packets.',
    parameters: BRIEF_TOOL_SCHEMA.parameters,
    sideEffects: ['workflow', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as BriefToolInput;
    const records = loadBriefs();

    if (input.mode === 'create') {
      if (!input.briefId || !input.title || !input.summary) {
        return { success: false, error: 'create requires briefId, title, and summary.' };
      }
      const now = Date.now();
      const record: BriefRecord = {
        id: input.briefId,
        title: input.title,
        summary: input.summary,
        goals: [...(input.goals ?? [])],
        constraints: [...(input.constraints ?? [])],
        risks: [...(input.risks ?? [])],
        ...(input.audience ? { audience: input.audience } : {}),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      saveBriefs([...records.filter((entry) => entry.id !== record.id), record]);
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'list') {
      return { success: true, output: JSON.stringify({ count: records.length, briefs: records }) };
    }

    const record = records.find((entry) => entry.id === input.briefId);
    if (!record) return { success: false, error: `Unknown brief: ${input.briefId ?? '(missing)'}` };

    if (input.mode === 'show') {
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'revise') {
      const next: BriefRecord = {
        ...record,
        title: input.title ?? record.title,
        summary: input.summary ?? record.summary,
        goals: input.goals ? [...input.goals] : record.goals,
        constraints: input.constraints ? [...input.constraints] : record.constraints,
        risks: input.risks ? [...input.risks] : record.risks,
        audience: input.audience ?? record.audience,
        updatedAt: Date.now(),
      };
      saveBriefs(records.map((entry) => (entry.id === next.id ? next : entry)));
      return { success: true, output: JSON.stringify(next) };
    }

    if (input.mode === 'publish') {
      const next: BriefRecord = {
        ...record,
        status: 'published',
        publishedAt: Date.now(),
        updatedAt: Date.now(),
      };
      saveBriefs(records.map((entry) => (entry.id === next.id ? next : entry)));
      return { success: true, output: JSON.stringify(next) };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
