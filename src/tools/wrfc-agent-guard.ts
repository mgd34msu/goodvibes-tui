import type { Tool } from '@pellux/goodvibes-sdk/platform/types';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';

type AgentToolArgs = {
  readonly mode?: unknown;
  readonly template?: unknown;
  readonly reviewMode?: unknown;
  readonly dangerously_disable_wrfc?: unknown;
  readonly tasks?: unknown;
};

type AgentTaskArgs = {
  readonly template?: unknown;
  readonly reviewMode?: unknown;
  readonly dangerously_disable_wrfc?: unknown;
};

const OWNER_BLOCKED_TEMPLATES = new Set(['reviewer', 'review', 'verifier', 'tester', 'test']);

export function installWrfcAgentToolGuard(registry: ToolRegistry): void {
  const agentTool = registry.list().find((tool) => tool.definition.name === 'agent');
  if (!agentTool) throw new Error('WRFC agent guard could not find the agent tool.');
  wrapWrfcAgentTool(agentTool);
}

export function wrapWrfcAgentTool(tool: Tool): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const denial = validateWrfcAgentToolInvocation(args as AgentToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(args);
  };
}

export function validateWrfcAgentToolInvocation(args: AgentToolArgs): string | null {
  if (args.mode === 'spawn') {
    if (isWrfcEnabled(args, args) && isBlockedOwnerTemplate(args.template)) {
      return [
        'WRFC spawn blocked: a WRFC root task must be an owner/engineer task, not a reviewer/verifier/tester task.',
        'Spawn one engineer/general owner with reviewMode:"wrfc"; WRFC creates reviewer and fixer agents only after owner output exists.',
      ].join(' ');
    }
    return null;
  }

  if (args.mode !== 'batch-spawn') return null;
  const tasks = Array.isArray(args.tasks) ? args.tasks.filter(isRecord) : [];
  const wrfcTasks = tasks.filter((task) => isWrfcEnabled(task, args));
  if (wrfcTasks.length === 0) return null;

  if (tasks.length !== 1 || wrfcTasks.length !== 1) {
    return [
      'WRFC batch-spawn blocked: WRFC must start as exactly one owner task.',
      'Do not batch an engineer with reviewer/verifier/tester tasks.',
      'Spawn one engineer/general owner with reviewMode:"wrfc"; the WRFC controller creates review/fix agents after the owner deliverable exists.',
    ].join(' ');
  }

  const [task] = wrfcTasks;
  if (isBlockedOwnerTemplate(task.template ?? args.template)) {
    return [
      'WRFC batch-spawn blocked: the single WRFC task must be an owner/engineer task, not a reviewer/verifier/tester task.',
      'Use template:"engineer" or template:"general" with reviewMode:"wrfc".',
    ].join(' ');
  }

  return null;
}

function isRecord(value: unknown): value is AgentTaskArgs {
  return Boolean(value) && typeof value === 'object';
}

function isWrfcEnabled(task: AgentTaskArgs, root: AgentToolArgs): boolean {
  const disabled = task.dangerously_disable_wrfc === true || root.dangerously_disable_wrfc === true;
  if (disabled) return false;
  return task.reviewMode === 'wrfc' || root.reviewMode === 'wrfc';
}

function isBlockedOwnerTemplate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return OWNER_BLOCKED_TEMPLATES.has(value.trim().toLowerCase());
}
