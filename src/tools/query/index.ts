import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

function summarizeQuery(record: QueryRecord) {
  return {
    id: record.id,
    prompt: record.prompt,
    askedBy: record.askedBy,
    target: record.target,
    status: record.status,
    hasAnswer: typeof record.answer === 'string' && record.answer.length > 0,
    hasResolution: typeof record.resolution === 'string' && record.resolution.length > 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createQueryTool(workingDirectory: string): Tool {
  const workspaceRoot = resolve(workingDirectory);
  const queriesDir = join(workspaceRoot, '.goodvibes', 'tui');
  const queriesPath = join(queriesDir, 'queries.json');

  function loadQueries(): QueryRecord[] {
    try {
      return JSON.parse(readFileSync(queriesPath, 'utf-8')) as QueryRecord[];
    } catch {
      return [];
    }
  }

  function saveQueries(records: readonly QueryRecord[]): void {
    mkdirSync(queriesDir, { recursive: true });
    writeFileSync(queriesPath, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
  }

  return {
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
      const view = input.view ?? 'summary';

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
        return {
          success: true,
          output: JSON.stringify({
            view,
            count: records.length,
            queries: view === 'full' ? records : records.map(summarizeQuery),
          }),
        };
      }

      const record = records.find((entry) => entry.id === input.queryId);
      if (!record) return { success: false, error: `Unknown query: ${input.queryId ?? '(missing)'}` };

      if (input.mode === 'show') {
        return { success: true, output: JSON.stringify(view === 'full' ? record : summarizeQuery(record)) };
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
}
