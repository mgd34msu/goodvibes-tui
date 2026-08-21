import type { Tool } from '@pellux/goodvibes-sdk/platform/types';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools';

type AgentToolArgs = {
  readonly mode?: unknown;
  readonly task?: unknown;
  readonly template?: unknown;
  readonly tools?: unknown;
  readonly restrictTools?: unknown;
  readonly context?: unknown;
  readonly successCriteria?: unknown;
  readonly requiredEvidence?: unknown;
  readonly writeScope?: unknown;
  readonly executionProtocol?: unknown;
  readonly model?: unknown;
  readonly provider?: unknown;
  readonly fallbackModels?: unknown;
  readonly cohort?: unknown;
  readonly reviewMode?: unknown;
  readonly dangerously_disable_wrfc?: unknown;
  readonly tasks?: unknown;
  readonly [key: string]: unknown;
};

type AgentTaskArgs = {
  readonly task?: unknown;
  readonly template?: unknown;
  readonly tools?: unknown;
  readonly restrictTools?: unknown;
  readonly context?: unknown;
  readonly successCriteria?: unknown;
  readonly requiredEvidence?: unknown;
  readonly writeScope?: unknown;
  readonly executionProtocol?: unknown;
  readonly model?: unknown;
  readonly provider?: unknown;
  readonly fallbackModels?: unknown;
  readonly reviewMode?: unknown;
  readonly dangerously_disable_wrfc?: unknown;
  readonly [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Guard trace
// ---------------------------------------------------------------------------

/**
 * Emitted whenever the guard changes the effective routing decision:
 *   - 'spawn-forced-wrfc'     , implementation-like spawn promoted to WRFC
 *   - 'spawn-suppressed-wrfc' , spawn judged read-only; WRFC suppressed
 *   - 'batch-collapsed-to-wrfc'— batch-spawn collapsed into a single WRFC owner chain
 */
export type WrfcGuardTraceKind =
  | 'spawn-forced-wrfc'
  | 'spawn-suppressed-wrfc'
  | 'batch-collapsed-to-wrfc';

export type WrfcGuardTrace = {
  readonly kind: WrfcGuardTraceKind;
  readonly reason: string;
  readonly task: string;
};

type WrfcAgentToolGuardOptions = {
  readonly getLastUserMessage?: () => string | null;
  readonly onTrace?: (trace: WrfcGuardTrace) => void;
};

export function installWrfcAgentToolGuard(registry: ToolRegistry, options: WrfcAgentToolGuardOptions = {}): void {
  const agentTool = registry.list().find((tool) => tool.definition.name === 'agent');
  if (!agentTool) throw new Error('WRFC agent guard could not find the agent tool.');
  wrapWrfcAgentTool(agentTool, options);
}

export function wrapWrfcAgentTool(tool: Tool, options: WrfcAgentToolGuardOptions = {}): void {
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args) => {
    const denial = validateWrfcAgentToolInvocation(args as AgentToolArgs);
    if (denial) return { success: false, error: denial };
    return originalExecute(normalizeWrfcAgentToolInvocation(args as AgentToolArgs, options) as Parameters<Tool['execute']>[0]);
  };
}

export function validateWrfcAgentToolInvocation(args: AgentToolArgs): string | null {
  if (args.mode !== 'spawn' && args.mode !== 'batch-spawn') return null;
  // SDK owns WRFC topology enforcement. TUI must not block reviewer/tester/
  // verifier root requests because the SDK normalizes those into owner chains.
  return null;
}

export function normalizeWrfcAgentToolInvocation(args: AgentToolArgs, options: WrfcAgentToolGuardOptions = {}): AgentToolArgs {
  const lastUserMessage = cleanText(options.getLastUserMessage?.() ?? null);
  const trace = options.onTrace;
  if (args.mode === 'spawn') {
    if (shouldRouteSpawnToWrfc(args)) {
      const reason = resolveSpawnWrfcReason(args);
      trace?.({
        kind: 'spawn-forced-wrfc',
        reason,
        task: cleanText(args.task) || '(no task)',
      });
      const normalized: AgentToolArgs = {
        ...args,
        task: selectAuthoritativeTask(args.task, lastUserMessage),
        reviewMode: 'wrfc',
        dangerously_disable_wrfc: false,
      };
      return cleanText(args.template) ? normalized : { ...normalized, template: 'engineer' };
    }
    trace?.({
      kind: 'spawn-suppressed-wrfc',
      reason: isReadOnlyTask(cleanText(args.task)) ? 'task judged read-only' : 'no implementation signal detected',
      task: cleanText(args.task) || '(no task)',
    });
    return { ...args, reviewMode: 'none', dangerously_disable_wrfc: true };
  }

  if (args.mode !== 'batch-spawn') return args;
  const tasks = Array.isArray(args.tasks) ? args.tasks.filter(isRecord) : [];
  if (shouldCollapseBatchToAuthoritativeWrfc(args, tasks) && lastUserMessage) {
    trace?.({
      kind: 'batch-collapsed-to-wrfc',
      reason: `WRFC: collapsed ${tasks.length}-agent batch into one reviewed chain`,
      task: lastUserMessage,
    });
    return buildAuthoritativeWrfcSpawn(args, tasks, lastUserMessage);
  }
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

function shouldRouteSpawnToWrfc(args: AgentToolArgs): boolean {
  return isExplicitWrfcTask(args, args)
    || isRootReviewRoleTask(args)
    || isImplementationLikeTask(args);
}

function shouldCollapseBatchToAuthoritativeWrfc(root: AgentToolArgs, tasks: AgentTaskArgs[]): boolean {
  if (tasks.length === 0) return false;
  if (containsWrfcSignal(root.task)) return true;
  return tasks.some((task) => isExplicitWrfcTask(task, root) || isRootReviewRoleTask(task));
}

function buildAuthoritativeWrfcSpawn(root: AgentToolArgs, tasks: AgentTaskArgs[], lastUserMessage: string): AgentToolArgs {
  const context = [
    cleanText(root.context) ? `Caller context:\n${cleanText(root.context)}` : null,
    'TUI WRFC scope guard: the root model attempted to decompose one deliverable into role/root child tasks.',
    'The authoritative task is the user request below. Proposed child tasks are non-authoritative context only.',
    'Ignore any proposed child instruction that narrows the task to design-only/read-only/no-write unless the user request itself says that.',
    `Authoritative user request:\n${lastUserMessage}`,
    'Proposed child tasks:',
    ...tasks.map((task, index) => `${index + 1}. [${cleanText(task.template) || 'general'}] ${cleanText(task.task)}`),
  ].filter((line): line is string => Boolean(line)).join('\n');

  return {
    mode: 'spawn',
    task: lastUserMessage,
    template: 'engineer',
    model: root.model,
    provider: root.provider,
    fallbackModels: root.fallbackModels,
    context,
    successCriteria: uniqueStrings([
      root.successCriteria,
      ...tasks.map((task) => task.successCriteria),
      [
        'Satisfy the original user request, not a narrowed child-task restatement.',
        'Keep review, test, verification, and fix work inside this single WRFC owner chain.',
      ],
    ]),
    requiredEvidence: uniqueStrings([
      root.requiredEvidence,
      ...tasks.map((task) => task.requiredEvidence),
    ]),
    writeScope: uniqueStrings([
      root.writeScope,
      ...tasks.map((task) => task.writeScope),
    ]),
    executionProtocol: root.executionProtocol ?? 'gather-plan-apply',
    reviewMode: 'wrfc',
    dangerously_disable_wrfc: false,
    cohort: root.cohort,
  };
}

function isExplicitWrfcTask(task: AgentTaskArgs, root: AgentToolArgs): boolean {
  const disabled = task.dangerously_disable_wrfc === true || root.dangerously_disable_wrfc === true;
  if (disabled && !containsWrfcSignal(task.task) && !containsWrfcSignal(root.task)) return false;
  return task.reviewMode === 'wrfc'
    || root.reviewMode === 'wrfc'
    || containsWrfcSignal(task.task)
    || containsWrfcSignal(root.task);
}

function containsWrfcSignal(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\bwrfc\b|work[-\s]*review[-\s]*fix/i.test(value);
}

function isRootReviewRoleTask(task: AgentTaskArgs): boolean {
  const template = cleanText(task.template).toLowerCase();
  if (/^(reviewer|tester|verifier|review|test|qa)$/.test(template)) return true;
  const text = cleanText(task.task);
  return /^\s*(?:\[?\s*)?(?:reviewer|tester|verifier|qa|quality\s+assurance|test|review|verify|validator)\b[\]\s:;-]*/i.test(text)
    || /\b(?:test|tests|testing|review|reviews|reviewing|verify|verifies|verifying|verification|validate|validates|validating|validation|qa)\s+(?:the|this|that|implementation|solution|feature|deliverable|code|changes|work|output|result|patch|diff)\b/i.test(text);
}

function resolveSpawnWrfcReason(args: AgentTaskArgs): string {
  if (containsWrfcSignal(args.task)) return 'task contains explicit WRFC signal';
  if (args.reviewMode === 'wrfc') return 'reviewMode explicitly set to wrfc';
  if (isRootReviewRoleTask(args)) return 'task identified as root review-role (reviewer/tester/verifier)';
  return 'task judged implementation-like';
}

function isImplementationLikeTask(task: AgentTaskArgs): boolean {
  const text = cleanText(task.task);
  if (!text) return false;
  // Broad verb set: explicit action words + short imperative phrasings like
  // "make the button blue", "wire up X", "connect X", "rename X", "move X"
  return /\b(?:build|implement|create|add|write|fix|repair|update|refactor|change|modify|deliver|make|patch|wire|connect|rename|move|delete|remove|migrate|configure|set\s+up|set\s+the|turn\s+on|turn\s+off|enable|disable|initialize|init|register|replace|swap|convert|transform|extend|integrate|embed|inject|port|rewrite|restructure)\b/i.test(text)
    && !isReadOnlyTask(text);
}

function isReadOnlyTask(text: string): boolean {
  // Branch A: explicit do-not-write guards
  if (/\bdo\s+not\s+(?:write|edit|modify|change|create)\b|\bread[-\s]*only\b|\bwithout\s+(?:writing|editing|modifying|changing|creating)\b/i.test(text)) return true;
  // Branch B: task leads with an analysis/reporting verb, treat it as read-only regardless
  // of any action verbs that appear later in the sentence. A task that LEADS with
  // "report", "investigate", "describe", "audit", etc. is describing or evaluating an
  // action, not performing it. Examples that must NOT reach WRFC:
  //   "report on how to migrate the auth module"
  //   "investigate what to remove"
  //   "document how we would convert X to Y"
  //   "describe the steps to disable telemetry"
  //   "audit which modules to delete"
  //   "evaluate whether to migrate"
  // The negative-lookahead is intentionally absent: the leading verb is authoritative.
  // Note: 'review' is intentionally excluded, tasks leading with 'review' are caught
  // by isRootReviewRoleTask() and routed to a WRFC chain as a reviewer role.
  return /^\s*(?:inspect|research|read|find|list|summarize|analy[sz]e|explain|report|investigate|document|describe|audit|evaluate|assess|check|compare|tell|show)\b/i.test(text);
}

function selectAuthoritativeTask(candidate: unknown, lastUserMessage: string): string {
  return lastUserMessage || cleanText(candidate);
}

function uniqueStrings(groups: readonly unknown[]): string[] | undefined {
  const values = groups.flatMap((group) => Array.isArray(group) ? group : []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique : undefined;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
