import type { Tool } from '../../types/tools.ts';
import { workflowSchema } from './schema.ts';

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

interface WorkflowDefinition {
  name: string;
  states: string[];
  transitions: Record<string, string[]>;
  description: string;
}

export const WORKFLOW_DEFINITIONS: Readonly<Record<string, WorkflowDefinition>> = Object.freeze({
  wrfc: {
    name: 'WRFC Loop',
    states: ['gather', 'plan', 'apply', 'review', 'revision', 'complete'],
    transitions: {
      gather: ['plan'],
      plan: ['apply'],
      apply: ['review'],
      review: ['revision', 'complete'],
      revision: ['apply'],
    },
    description: 'Full work-review-fix cycle',
  },
  fix_loop: {
    name: 'Fix Loop',
    states: ['apply', 'test', 'verify', 'complete'],
    transitions: { apply: ['test'], test: ['verify', 'apply'], verify: ['complete'] },
    description: 'Apply fix, test, verify',
  },
  test_then_fix: {
    name: 'Test Then Fix',
    states: ['test', 'fix', 'verify', 'complete'],
    transitions: { test: ['fix'], fix: ['verify'], verify: ['complete', 'fix'] },
    description: 'Run tests, fix failures, verify',
  },
  review_only: {
    name: 'Review Only',
    states: ['review', 'complete'],
    transitions: { review: ['complete'] },
    description: 'Skip to review phase',
  },
});

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

export interface WorkflowInstance {
  id: string;
  definition: string;
  currentState: string;
  task: string;
  startedAt: number;
  completedAt?: number;
  transitions: number;
  context: Record<string, unknown>;
  cancelled?: boolean;
}

const WORKFLOW_EVICT_AFTER_MS = 60 * 60 * 1000; // 1 hour
const WORKFLOW_MAX_COMPLETED = 50;

export class WorkflowManager {
  private static _instance: WorkflowManager | null = null;
  private workflows = new Map<string, WorkflowInstance>();

  static getInstance(): WorkflowManager {
    if (!WorkflowManager._instance) {
      WorkflowManager._instance = new WorkflowManager();
    }
    return WorkflowManager._instance;
  }

  /** Reset singleton — for testing only. */
  static _resetForTest(): void {
    WorkflowManager._instance = null;
  }

  start(definition: string, task: string): WorkflowInstance {
    const def = WORKFLOW_DEFINITIONS[definition];
    if (!def) {
      throw new Error(`Unknown workflow definition: ${definition}`);
    }

    const id = `wf-${crypto.randomUUID().slice(0, 8)}`;
    const instance: WorkflowInstance = {
      id,
      definition,
      currentState: def.states[0],
      task,
      startedAt: Date.now(),
      transitions: 0,
      context: {},
    };

    this.workflows.set(id, instance);
    return instance;
  }

  getStatus(id: string): WorkflowInstance | null {
    return this.workflows.get(id) ?? null;
  }

  transition(id: string, targetState: string): { success: boolean; error?: string } {
    const instance = this.workflows.get(id);
    if (!instance) {
      return { success: false, error: `Workflow not found: ${id}` };
    }
    if (instance.cancelled) {
      return { success: false, error: 'Workflow is cancelled' };
    }

    const def = WORKFLOW_DEFINITIONS[instance.definition];
    const allowed = def?.transitions[instance.currentState] ?? [];

    if (!allowed.includes(targetState)) {
      return {
        success: false,
        error: `Invalid transition: ${instance.currentState} -> ${targetState}. Allowed: [${allowed.join(', ')}]`,
      };
    }

    instance.currentState = targetState;
    instance.transitions += 1;
    if (targetState === 'complete') {
      instance.completedAt = Date.now();
    }
    return { success: true };
  }

  cancel(id: string): boolean {
    const instance = this.workflows.get(id);
    if (!instance) return false;
    instance.cancelled = true;
    instance.completedAt = Date.now();
    return true;
  }

  list(): WorkflowInstance[] {
    const now = Date.now();
    // Evict old completed/cancelled workflows
    for (const [id, wf] of this.workflows) {
      if (wf.completedAt !== undefined && now - wf.completedAt > WORKFLOW_EVICT_AFTER_MS) {
        this.workflows.delete(id);
      }
    }
    // Cap completed workflows at max
    const all = Array.from(this.workflows.values());
    const completed = all.filter(w => w.completedAt !== undefined);
    if (completed.length > WORKFLOW_MAX_COMPLETED) {
      completed.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
      const toEvict = completed.slice(0, completed.length - WORKFLOW_MAX_COMPLETED);
      for (const wf of toEvict) this.workflows.delete(wf.id);
    }
    return Array.from(this.workflows.values());
  }
}

// ---------------------------------------------------------------------------
// TriggerManager
// ---------------------------------------------------------------------------

export interface TriggerDefinition {
  id: string;
  event: string;
  condition?: string;
  action: string;
  enabled: boolean;
}

export class TriggerManager {
  private static _instance: TriggerManager | null = null;
  private triggers = new Map<string, TriggerDefinition>();

  static getInstance(): TriggerManager {
    if (!TriggerManager._instance) {
      TriggerManager._instance = new TriggerManager();
    }
    return TriggerManager._instance;
  }

  /** Reset singleton — for testing only. */
  static _resetForTest(): void {
    TriggerManager._instance = null;
  }

  add(def: { event: string; condition?: string; action: string }): TriggerDefinition {
    const id = `trg-${crypto.randomUUID().slice(0, 8)}`;
    const trigger: TriggerDefinition = {
      id,
      event: def.event,
      condition: def.condition,
      action: def.action,
      enabled: true,
    };
    this.triggers.set(id, trigger);
    return trigger;
  }

  remove(id: string): boolean {
    return this.triggers.delete(id);
  }

  enable(id: string): boolean {
    const trigger = this.triggers.get(id);
    if (!trigger) return false;
    trigger.enabled = true;
    return true;
  }

  disable(id: string): boolean {
    const trigger = this.triggers.get(id);
    if (!trigger) return false;
    trigger.enabled = false;
    return true;
  }

  list(): TriggerDefinition[] {
    return Array.from(this.triggers.values());
  }
}

// ---------------------------------------------------------------------------
// ScheduleManager
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  name: string;
  interval: string;
  command: string;
  lastRun?: number;
  nextRun?: number;
  enabled: boolean;
}

/**
 * Parse an interval string like '30s', '5m', '1h' to milliseconds.
 * Returns null if the format is unrecognised.
 */
export function parseInterval(interval: string): number | null {
  const match = interval.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case 's': return value * 1_000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

export class ScheduleManager {
  private static _instance: ScheduleManager | null = null;
  private schedules = new Map<string, ScheduleEntry>();
  /** Timer IDs keyed by schedule name */
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  /** Spawned process handles tracked for cleanup in destroy() */
  private spawnedProcs: Array<{ pid: number; proc: ReturnType<typeof Bun.spawn> }> = [];

  static getInstance(): ScheduleManager {
    if (!ScheduleManager._instance) {
      ScheduleManager._instance = new ScheduleManager();
    }
    return ScheduleManager._instance;
  }

  /** Reset singleton — for testing only. */
  static _resetForTest(): void {
    if (ScheduleManager._instance) {
      ScheduleManager._instance.destroy();
    }
    ScheduleManager._instance = null;
  }

  add(name: string, interval: string, command: string): ScheduleEntry {
    // Clear existing timer if re-adding
    this._clearTimer(name);

    const now = Date.now();
    const intervalMs = parseInterval(interval);
    const entry: ScheduleEntry = {
      name,
      interval,
      command,
      enabled: true,
      nextRun: intervalMs !== null ? now + intervalMs : undefined,
    };
    this.schedules.set(name, entry);

    if (intervalMs !== null) {
      const timer = setInterval(() => this._tick(name), intervalMs);
      this.timers.set(name, timer);
    }

    return entry;
  }

  remove(name: string): boolean {
    this._clearTimer(name);
    return this.schedules.delete(name);
  }

  enable(name: string): boolean {
    const entry = this.schedules.get(name);
    if (!entry) return false;
    if (entry.enabled) return true;
    entry.enabled = true;
    // Restart timer
    const intervalMs = parseInterval(entry.interval);
    if (intervalMs !== null && !this.timers.has(name)) {
      entry.nextRun = Date.now() + intervalMs;
      const timer = setInterval(() => this._tick(name), intervalMs);
      this.timers.set(name, timer);
    }
    return true;
  }

  disable(name: string): boolean {
    const entry = this.schedules.get(name);
    if (!entry) return false;
    entry.enabled = false;
    this._clearTimer(name);
    entry.nextRun = undefined;
    return true;
  }

  list(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /** Stop all timers and clear state (called on singleton reset). */
  destroy(): void {
    for (const name of this.timers.keys()) {
      this._clearTimer(name);
    }
    this.schedules.clear();
    // Kill any still-running spawned processes
    for (const { proc } of this.spawnedProcs) {
      try { proc.kill(); } catch { /* non-fatal */ }
    }
    this.spawnedProcs = [];
  }

  /** Execute a schedule tick: run the command and update lastRun/nextRun. */
  private _tick(name: string): void {
    const entry = this.schedules.get(name);
    if (!entry || !entry.enabled) return;

    const now = Date.now();
    entry.lastRun = now;
    const intervalMs = parseInterval(entry.interval);
    entry.nextRun = intervalMs !== null ? now + intervalMs : undefined;

    // Parse command string
    const parts = entry.command.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return;

    try {
      const proc = Bun.spawn(parts, {
        env: { ...process.env, GV_SCHEDULE_NAME: name },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      const pid = proc.pid;
      this.spawnedProcs.push({ pid, proc });
      proc.exited.then(() => {
        // Remove from tracking once the process has exited
        const idx = this.spawnedProcs.findIndex(p => p.pid === pid);
        if (idx !== -1) this.spawnedProcs.splice(idx, 1);
      }).catch(() => { /* non-fatal */ });
    } catch {
      // Spawn failure is non-fatal for the scheduler
    }
  }

  private _clearTimer(name: string): void {
    const timer = this.timers.get(name);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface WorkflowInput {
  mode: 'start' | 'status' | 'transition' | 'cancel' | 'list' | 'triggers' | 'schedule';
  definition?: string;
  task?: string;
  workflowId?: string;
  targetState?: string;
  triggerAction?: 'list' | 'add' | 'remove' | 'enable' | 'disable';
  triggerId?: string;
  triggerDefinition?: {
    event: string;
    condition?: string;
    action: string;
  };
  scheduleAction?: 'list' | 'add' | 'remove';
  scheduleName?: string;
  scheduleInterval?: string;
  scheduleCommand?: string;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export const workflowTool: Tool = {
  definition: workflowSchema,

  async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    try {
      if (!args.mode || typeof args.mode !== 'string') {
        return { success: false, error: 'Missing required "mode" field' };
      }

      const input = args as unknown as WorkflowInput;
      const wm = WorkflowManager.getInstance();
      const tm = TriggerManager.getInstance();
      const sm = ScheduleManager.getInstance();

      switch (input.mode) {
        case 'start': {
          if (!input.definition) {
            return { success: false, error: 'mode "start" requires "definition"' };
          }
          if (!input.task) {
            return { success: false, error: 'mode "start" requires "task"' };
          }
          if (!WORKFLOW_DEFINITIONS[input.definition]) {
            return { success: false, error: `Unknown workflow definition: ${input.definition}` };
          }
          const instance = wm.start(input.definition, input.task);
          return { success: true, output: JSON.stringify(instance) };
        }

        case 'status': {
          if (!input.workflowId) {
            return { success: false, error: 'mode "status" requires "workflowId"' };
          }
          const instance = wm.getStatus(input.workflowId);
          if (!instance) {
            return { success: false, error: `Workflow not found: ${input.workflowId}` };
          }
          return { success: true, output: JSON.stringify(instance) };
        }

        case 'transition': {
          if (!input.workflowId) {
            return { success: false, error: 'mode "transition" requires "workflowId"' };
          }
          if (!input.targetState) {
            return { success: false, error: 'mode "transition" requires "targetState"' };
          }
          const result = wm.transition(input.workflowId, input.targetState);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          const updated = wm.getStatus(input.workflowId);
          return { success: true, output: JSON.stringify(updated) };
        }

        case 'cancel': {
          if (!input.workflowId) {
            return { success: false, error: 'mode "cancel" requires "workflowId"' };
          }
          const cancelled = wm.cancel(input.workflowId);
          if (!cancelled) {
            return { success: false, error: `Workflow not found: ${input.workflowId}` };
          }
          return { success: true, output: JSON.stringify({ cancelled: true, workflowId: input.workflowId }) };
        }

        case 'list': {
          const workflows = wm.list();
          return { success: true, output: JSON.stringify({ workflows, count: workflows.length }) };
        }

        case 'triggers': {
          const action = input.triggerAction ?? 'list';
          switch (action) {
            case 'list': {
              const triggers = tm.list();
              return { success: true, output: JSON.stringify({ triggers, count: triggers.length }) };
            }
            case 'add': {
              if (!input.triggerDefinition) {
                return { success: false, error: 'triggers/add requires "triggerDefinition"' };
              }
              const trigger = tm.add(input.triggerDefinition);
              return { success: true, output: JSON.stringify(trigger) };
            }
            case 'remove': {
              if (!input.triggerId) {
                return { success: false, error: 'triggers/remove requires "triggerId"' };
              }
              const removed = tm.remove(input.triggerId);
              return { success: true, output: JSON.stringify({ removed, triggerId: input.triggerId }) };
            }
            case 'enable': {
              if (!input.triggerId) {
                return { success: false, error: 'triggers/enable requires "triggerId"' };
              }
              const enabled = tm.enable(input.triggerId);
              if (!enabled) {
                return { success: false, error: `Trigger not found: ${input.triggerId}` };
              }
              return { success: true, output: JSON.stringify({ enabled: true, triggerId: input.triggerId }) };
            }
            case 'disable': {
              if (!input.triggerId) {
                return { success: false, error: 'triggers/disable requires "triggerId"' };
              }
              const disabled = tm.disable(input.triggerId);
              if (!disabled) {
                return { success: false, error: `Trigger not found: ${input.triggerId}` };
              }
              return { success: true, output: JSON.stringify({ disabled: true, triggerId: input.triggerId }) };
            }
            default: {
              const exhaustive: never = action;
              return { success: false, error: `Unknown triggerAction: ${exhaustive as string}` };
            }
          }
        }

        case 'schedule': {
          const action = input.scheduleAction ?? 'list';
          switch (action) {
            case 'list': {
              const schedules = sm.list();
              return { success: true, output: JSON.stringify({ schedules, count: schedules.length }) };
            }
            case 'add': {
              if (!input.scheduleName) {
                return { success: false, error: 'schedule/add requires "scheduleName"' };
              }
              if (!input.scheduleInterval) {
                return { success: false, error: 'schedule/add requires "scheduleInterval"' };
              }
              if (!input.scheduleCommand) {
                return { success: false, error: 'schedule/add requires "scheduleCommand"' };
              }
              const entry = sm.add(input.scheduleName, input.scheduleInterval, input.scheduleCommand);
              return { success: true, output: JSON.stringify(entry) };
            }
            case 'remove': {
              if (!input.scheduleName) {
                return { success: false, error: 'schedule/remove requires "scheduleName"' };
              }
              const removed = sm.remove(input.scheduleName);
              return { success: true, output: JSON.stringify({ removed, scheduleName: input.scheduleName }) };
            }
            default: {
              const exhaustive: never = action;
              return { success: false, error: `Unknown scheduleAction: ${exhaustive as string}` };
            }
          }
        }

        default: {
          const exhaustive: never = input.mode;
          return { success: false, error: `Unknown mode: ${exhaustive as string}` };
        }
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
