import type { SubmissionIntent } from './submission-intent.ts';

export interface SubmissionRouterInput {
  readonly text: string;
  readonly commandMode?: boolean;
  readonly panelFocused?: boolean;
  readonly hasAttachments?: boolean;
}

const PLAN_COMMANDS = new Set(['plan']);
const REVIEW_COMMANDS = new Set(['review']);
const PANEL_COMMANDS = new Set(['panel']);
const ORCHESTRATION_COMMANDS = new Set([
  'wrfc',
  'orchestration',
  'teamwork',
  'tasks',
  'agents',
  'remote',
  'bridge',
  'teleport',
  'sandbox',
]);

export function routeSubmissionIntent(input: SubmissionRouterInput): SubmissionIntent {
  const trimmed = input.text.trim();
  const hasAttachments = input.hasAttachments ?? false;

  if (!trimmed) {
    return {
      kind: input.panelFocused ? 'panel-action' : 'empty',
      label: input.panelFocused ? 'panel action' : 'prompt',
      hasAttachments,
    };
  }

  if (trimmed.startsWith('!#')) {
    return { kind: 'memory-pin', label: 'memory pin', hasAttachments };
  }

  if (trimmed.startsWith('!')) {
    return { kind: 'shell', label: 'shell', hasAttachments };
  }

  if (input.commandMode || trimmed.startsWith('/')) {
    const commandName = trimmed.replace(/^\//, '').split(/\s+/, 1)[0] ?? '';
    if (PLAN_COMMANDS.has(commandName)) {
      return { kind: 'plan', label: 'plan', commandName, hasAttachments };
    }
    if (REVIEW_COMMANDS.has(commandName)) {
      return { kind: 'review', label: 'review', commandName, hasAttachments };
    }
    if (PANEL_COMMANDS.has(commandName)) {
      return { kind: 'panel-action', label: 'panel action', commandName, hasAttachments };
    }
    if (ORCHESTRATION_COMMANDS.has(commandName)) {
      return { kind: 'orchestration', label: 'orchestration', commandName, hasAttachments };
    }
    return { kind: 'slash-command', label: 'command', commandName, hasAttachments };
  }

  return { kind: 'prompt', label: 'prompt', hasAttachments };
}

