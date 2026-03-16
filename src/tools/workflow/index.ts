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

export const WORKFLOW_DEFINITIONS: Record<string, WorkflowDefinition> = {
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
};

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

export interface WorkflowInstance {
  id: string;
  definition: string;
  currentState: string;
  task: string;
  startedAt: number;
  transitions: number;
  context: Record<string, unknown>;
  cancelled?: boolean;
}

export class WorkflowManager {
  private static _instance: WorkflowManager | null = null;
  private workflows = new Map<string, WorkflowInstance>();
  private idCounter = 0;

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

    const id = `wf_${Date.now()}_${++this.idCounter}`;
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
    return { success: true };
  }

  cancel(id: string): boolean {
    const instance = this.workflows.get(id);
    if (!instance) return false;
    instance.cancelled = true;
    return true;
  }

  list(): WorkflowInstance[] {
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
  private idCounter = 0;

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
    const id = `trig_${Date.now()}_${++this.idCounter}`;
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

export class ScheduleManager {
  private static _instance: ScheduleManager | null = null;
  private schedules = new Map<string, ScheduleEntry>();

  static getInstance(): ScheduleManager {
    if (!ScheduleManager._instance) {
      ScheduleManager._instance = new ScheduleManager();
    }
    return ScheduleManager._instance;
  }

  /** Reset singleton — for testing only. */
  static _resetForTest(): void {
    ScheduleManager._instance = null;
  }

  add(name: string, interval: string, command: string): ScheduleEntry {
    const entry: ScheduleEntry = {
      name,
      interval,
      command,
      enabled: true,
    };
    this.schedules.set(name, entry);
    return entry;
  }

  remove(name: string): boolean {
    return this.schedules.delete(name);
  }

  list(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
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
