import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { WORKLIST_TOOL_SCHEMA, type WorklistToolInput } from './schema.ts';

interface WorklistItem {
  readonly id: string;
  readonly text: string;
  readonly status: 'open' | 'done';
  readonly owner?: string;
  readonly priority: 'low' | 'medium' | 'high';
}

interface WorklistRecord {
  readonly id: string;
  readonly title: string;
  readonly items: readonly WorklistItem[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface WorklistFile {
  readonly version: 1;
  readonly worklists: readonly WorklistRecord[];
}

function summarizeWorklist(record: WorklistRecord) {
  const openCount = record.items.filter((item) => item.status === 'open').length;
  const doneCount = record.items.filter((item) => item.status === 'done').length;
  return {
    id: record.id,
    title: record.title,
    itemCount: record.items.length,
    openCount,
    doneCount,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function worklistsPath(): string {
  return join(process.cwd(), '.goodvibes', 'tui', 'worklists.json');
}

function loadWorklists(): WorklistRecord[] {
  const path = worklistsPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as WorklistFile;
    return parsed?.version === 1 && Array.isArray(parsed.worklists) ? [...parsed.worklists] : [];
  } catch {
    return [];
  }
}

function saveWorklists(worklists: readonly WorklistRecord[]): void {
  const path = worklistsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, worklists }, null, 2) + '\n', 'utf-8');
}

export const worklistTool: Tool = {
  definition: {
    name: 'worklist',
    description: 'Manage durable worklists and checklist items for execution planning and follow-up.',
    parameters: WORKLIST_TOOL_SCHEMA as unknown as Record<string, unknown>,
    sideEffects: ['workflow', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as WorklistToolInput;
    const worklists = loadWorklists();
    const view = input.view ?? 'summary';

    if (input.mode === 'create') {
      if (!input.worklistId || !input.title) {
        return { success: false, error: 'create requires worklistId and title.' };
      }
      if (worklists.some((entry) => entry.id === input.worklistId)) {
        return { success: false, error: `Worklist already exists: ${input.worklistId}` };
      }
      const now = Date.now();
      const record: WorklistRecord = {
        id: input.worklistId,
        title: input.title,
        items: [],
        createdAt: now,
        updatedAt: now,
      };
      saveWorklists([...worklists, record]);
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'list') {
      return {
        success: true,
        output: JSON.stringify({
          view,
          count: worklists.length,
          worklists: view === 'full' ? worklists : worklists.map(summarizeWorklist),
        }),
      };
    }

    const index = worklists.findIndex((entry) => entry.id === input.worklistId);
    if (index < 0) {
      return { success: false, error: `Unknown worklist: ${input.worklistId ?? '(missing)'}` };
    }
    const current = worklists[index]!;

    if (input.mode === 'show') {
      return {
        success: true,
        output: JSON.stringify(view === 'full' ? current : {
          ...summarizeWorklist(current),
          items: current.items.map((item) => ({
            id: item.id,
            text: item.text,
            status: item.status,
            owner: item.owner,
            priority: item.priority,
          })),
        }),
      };
    }

    if (input.mode === 'add-item') {
      if (!input.itemId || !input.text) return { success: false, error: 'add-item requires itemId and text.' };
      const next: WorklistRecord = {
        ...current,
        items: [
          ...current.items.filter((item) => item.id !== input.itemId),
          { id: input.itemId, text: input.text, status: 'open', priority: input.priority ?? 'medium', ...(input.owner ? { owner: input.owner } : {}) },
        ],
        updatedAt: Date.now(),
      };
      worklists[index] = next;
      saveWorklists(worklists);
      return { success: true, output: JSON.stringify(next) };
    }

    if (!input.itemId) return { success: false, error: `${input.mode} requires itemId.` };
    const nextItems = current.items
      .filter((item) => input.mode !== 'remove-item' || item.id !== input.itemId)
      .map((item) => {
        if (item.id !== input.itemId) return item;
        if (input.mode === 'complete-item') return { ...item, status: 'done' as const };
        if (input.mode === 'reopen-item') return { ...item, status: 'open' as const };
        return item;
      });
    const next: WorklistRecord = {
      ...current,
      items: nextItems,
      updatedAt: Date.now(),
    };
    worklists[index] = next;
    saveWorklists(worklists);
    return { success: true, output: JSON.stringify(next) };
  },
};
