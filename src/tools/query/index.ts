import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { QUERY_TOOL_SCHEMA, type QueryToolInput } from './schema.ts';

interface QueryRecord {
  readonly id: string;
  readonly prompt: string;
  readonly askedBy?: string;
  readonly target?: string;
  readonly answer?: string;
  readonly resolution?: string;
  readonly status: 'open' | 'answered' | 'closed';
  readonly createdAt: number;
  readonly updatedAt: number;
}

const QUERIES_PATH = join('.goodvibes', 'tui', 'queries.json');

function loadQueries(): QueryRecord[] {
  try {
    return JSON.parse(readFileSync(QUERIES_PATH, 'utf-8')) as QueryRecord[];
  } catch {
    return [];
  }
}

function saveQueries(records: readonly QueryRecord[]): void {
  mkdirSync(join('.goodvibes', 'tui'), { recursive: true });
  writeFileSync(QUERIES_PATH, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

export const queryTool: Tool = {
  definition: {
    name: 'query',
    description: 'Track operator queries, answers, escalation, and closure.',
    parameters: QUERY_TOOL_SCHEMA.parameters,
    sideEffects: ['workflow', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as QueryToolInput;
    const records = loadQueries();

    if (input.mode === 'ask') {
      if (!input.queryId || !input.prompt) {
        return { success: false, error: 'ask requires queryId and prompt.' };
      }
      const now = Date.now();
      const record: QueryRecord = {
        id: input.queryId,
        prompt: input.prompt,
        ...(input.askedBy ? { askedBy: input.askedBy } : {}),
        ...(input.target ? { target: input.target } : {}),
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      saveQueries([...records.filter((entry) => entry.id !== record.id), record]);
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'list') {
      return { success: true, output: JSON.stringify({ count: records.length, queries: records }) };
    }

    const record = records.find((entry) => entry.id === input.queryId);
    if (!record) return { success: false, error: `Unknown query: ${input.queryId ?? '(missing)'}` };

    if (input.mode === 'show') {
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'answer') {
      if (!input.answer) return { success: false, error: 'answer requires answer text.' };
      const next: QueryRecord = {
        ...record,
        answer: input.answer,
        status: 'answered',
        updatedAt: Date.now(),
      };
      saveQueries(records.map((entry) => (entry.id === next.id ? next : entry)));
      return { success: true, output: JSON.stringify(next) };
    }

    if (input.mode === 'close') {
      const next: QueryRecord = {
        ...record,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        status: 'closed',
        updatedAt: Date.now(),
      };
      saveQueries(records.map((entry) => (entry.id === next.id ? next : entry)));
      return { success: true, output: JSON.stringify(next) };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
