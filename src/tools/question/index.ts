import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '../../types/tools.ts';
import { QUESTION_TOOL_SCHEMA, type QuestionToolInput } from './schema.ts';

interface QuestionRecord {
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

const QUESTIONS_PATH = join('.goodvibes', 'tui', 'questions.json');

function loadQuestions(): QuestionRecord[] {
  try {
    return JSON.parse(readFileSync(QUESTIONS_PATH, 'utf-8')) as QuestionRecord[];
  } catch {
    return [];
  }
}

function saveQuestions(records: readonly QuestionRecord[]): void {
  mkdirSync(join('.goodvibes', 'tui'), { recursive: true });
  writeFileSync(QUESTIONS_PATH, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

export const questionTool: Tool = {
  definition: {
    name: 'question',
    description: 'Track operator questions, answers, escalation, and closure.',
    parameters: QUESTION_TOOL_SCHEMA.parameters,
    sideEffects: ['workflow', 'state'],
    concurrency: 'serial',
  },

  async execute(args: Record<string, unknown>) {
    if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
      return { success: false, error: 'Invalid args: mode is required.' };
    }
    const input = args as unknown as QuestionToolInput;
    const records = loadQuestions();

    if (input.mode === 'ask') {
      if (!input.questionId || !input.prompt) {
        return { success: false, error: 'ask requires questionId and prompt.' };
      }
      const now = Date.now();
      const record: QuestionRecord = {
        id: input.questionId,
        prompt: input.prompt,
        ...(input.askedBy ? { askedBy: input.askedBy } : {}),
        ...(input.target ? { target: input.target } : {}),
        status: 'open',
        createdAt: now,
        updatedAt: now,
      };
      saveQuestions([...records.filter((entry) => entry.id !== record.id), record]);
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'list') {
      return { success: true, output: JSON.stringify({ count: records.length, questions: records }) };
    }

    const record = records.find((entry) => entry.id === input.questionId);
    if (!record) return { success: false, error: `Unknown question: ${input.questionId ?? '(missing)'}` };

    if (input.mode === 'show') {
      return { success: true, output: JSON.stringify(record) };
    }

    if (input.mode === 'answer') {
      if (!input.answer) return { success: false, error: 'answer requires answer text.' };
      const next: QuestionRecord = {
        ...record,
        answer: input.answer,
        status: 'answered',
        updatedAt: Date.now(),
      };
      saveQuestions(records.map((entry) => (entry.id === next.id ? next : entry)));
      return { success: true, output: JSON.stringify(next) };
    }

    if (input.mode === 'close') {
      const next: QuestionRecord = {
        ...record,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        status: 'closed',
        updatedAt: Date.now(),
      };
      saveQuestions(records.map((entry) => (entry.id === next.id ? next : entry)));
      return { success: true, output: JSON.stringify(next) };
    }

    return { success: false, error: `Unknown mode: ${input.mode}` };
  },
};
