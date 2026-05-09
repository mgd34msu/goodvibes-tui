import type { Tool } from '@pellux/goodvibes-sdk/platform/types';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';

type AgentToolArgs = {
  readonly mode?: unknown;
  readonly task?: unknown;
  readonly template?: unknown;
  readonly reviewMode?: unknown;
  readonly dangerously_disable_wrfc?: unknown;
  readonly tasks?: unknown;
  readonly [key: string]: unknown;
};

type AgentTaskArgs = {
  readonly task?: unknown;
  readonly template?: unknown;
  readonly reviewMode?: unknown;
  readonly dangerously_disable_wrfc?: unknown;
  readonly [key: string]: unknown;
};

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
    return originalExecute(normalizeWrfcAgentToolInvocation(args as AgentToolArgs) as Parameters<Tool['execute']>[0]);
  };
}

export function validateWrfcAgentToolInvocation(args: AgentToolArgs): string | null {
  if (args.mode !== 'spawn' && args.mode !== 'batch-spawn') return null;
  // SDK owns WRFC topology enforcement. TUI must not block reviewer/tester/
  // verifier root requests because the SDK normalizes those into owner chains.
  return null;
}

export function normalizeWrfcAgentToolInvocation(args: AgentToolArgs): AgentToolArgs {
  if (args.mode === 'spawn') {
    if (isExplicitWrfcTask(args, args)) return { ...args, reviewMode: 'wrfc', dangerously_disable_wrfc: false };
    return { ...args, reviewMode: 'none', dangerously_disable_wrfc: true };
  }

  if (args.mode !== 'batch-spawn') return args;
  const tasks = Array.isArray(args.tasks) ? args.tasks.filter(isRecord) : [];
  const wrfcTasks = tasks.filter((task) => isExplicitWrfcTask(task, args));
  if (wrfcTasks.length === 0) {
    return {
      ...args,
      reviewMode: args.reviewMode === 'none' ? args.reviewMode : 'none',
      dangerously_disable_wrfc: true,
      tasks: tasks.map((task) => task.dangerously_disable_wrfc === true
        ? task
        : { ...task, reviewMode: 'none', dangerously_disable_wrfc: true }),
    };
  }
  if (wrfcTasks.length > 0) {
    return {
      ...args,
      reviewMode: 'wrfc',
      dangerously_disable_wrfc: false,
      tasks: tasks.map((task) => isExplicitWrfcTask(task, args)
        ? { ...task, reviewMode: 'wrfc', dangerously_disable_wrfc: false }
        : task),
    };
  }
  return args;
}

function isRecord(value: unknown): value is AgentTaskArgs {
  return Boolean(value) && typeof value === 'object';
}

function isExplicitWrfcTask(task: AgentTaskArgs, root: AgentToolArgs): boolean {
  const disabled = task.dangerously_disable_wrfc === true || root.dangerously_disable_wrfc === true;
  if (disabled) return false;
  return task.reviewMode === 'wrfc'
    || root.reviewMode === 'wrfc'
    || containsWrfcSignal(task.task)
    || containsWrfcSignal(root.task);
}

function containsWrfcSignal(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\bwrfc\b|work[-\s]*review[-\s]*fix/i.test(value);
}
