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

const OWNER_BLOCKED_TEMPLATES = new Set(['reviewer', 'review', 'verifier', 'tester', 'test']);
const OWNER_BLOCKED_TASK_PREFIXES = [
  'review ',
  'review:',
  'review the ',
  'verify ',
  'verify:',
  'verify the ',
  'test ',
  'test:',
  'test the ',
];

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
  if (args.mode === 'spawn') {
    if (isExplicitWrfcTask(args, args) && isBlockedRootTask(args, args)) {
      return [
        'WRFC spawn blocked: a WRFC root task must be an owner/engineer task, not a reviewer/verifier/tester task.',
        'Spawn one engineer/general owner with reviewMode:"wrfc"; WRFC creates reviewer and fixer agents only after owner output exists.',
      ].join(' ');
    }
    return null;
  }

  if (args.mode !== 'batch-spawn') return null;
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
  if (tasks.length === 1 && wrfcTasks.length === 1 && !isBlockedRootTask(tasks[0], args)) {
    return {
      ...args,
      reviewMode: 'wrfc',
      dangerously_disable_wrfc: false,
      tasks: [{ ...tasks[0], reviewMode: 'wrfc', dangerously_disable_wrfc: false }],
    };
  }

  const ownerTask = buildCollapsedWrfcOwnerTask(args, tasks);
  return {
    ...args,
    template: normalizeOwnerTemplate(args.template),
    reviewMode: 'wrfc',
    dangerously_disable_wrfc: false,
    tasks: [ownerTask],
  };
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

function isBlockedOwnerTemplate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return OWNER_BLOCKED_TEMPLATES.has(value.trim().toLowerCase());
}

function isBlockedRootTask(task: AgentTaskArgs, root: AgentToolArgs): boolean {
  if (isBlockedOwnerTemplate(task.template ?? root.template)) return true;
  if (typeof task.task !== 'string') return false;
  const normalized = task.task.trim().toLowerCase();
  return OWNER_BLOCKED_TASK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeOwnerTemplate(value: unknown): string {
  if (isBlockedOwnerTemplate(value)) return 'engineer';
  return typeof value === 'string' && value.trim().length > 0 ? value : 'engineer';
}

function buildCollapsedWrfcOwnerTask(root: AgentToolArgs, taskList: AgentTaskArgs[]): AgentTaskArgs {
  const firstOwner = taskList.find((task) => isExplicitWrfcTask(task, root) && !isBlockedRootTask(task, root))
    ?? taskList.find((task) => !isBlockedRootTask(task, root))
    ?? taskList[0]
    ?? {};
  const taskLines = taskList.map((task, index) => {
    const body = typeof task.task === 'string' && task.task.trim().length > 0 ? task.task.trim() : '(missing task text)';
    const template = typeof task.template === 'string' && task.template.trim().length > 0 ? task.template.trim() : 'default';
    return `${index + 1}. [${template}] ${body}`;
  });
  const rootTask = typeof root.task === 'string' && root.task.trim().length > 0
    ? `\n\nRoot task:\n${root.task.trim()}`
    : '';
  return {
    ...firstOwner,
    task: [
      'Complete the requested work as a single WRFC owner chain.',
      'Do not spawn reviewer, verifier, tester, or parallel root WRFC agents yourself.',
      'Use the attempted batch items below as context for one coherent owner deliverable; the WRFC controller will create review/fix agents after owner output exists.',
      rootTask,
      '',
      'Attempted batch items:',
      ...taskLines,
    ].join('\n'),
    template: normalizeOwnerTemplate(firstOwner.template ?? root.template),
    reviewMode: 'wrfc',
    dangerously_disable_wrfc: false,
  };
}

function containsWrfcSignal(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\bwrfc\b|work[-\s]*review[-\s]*fix/i.test(value);
}
