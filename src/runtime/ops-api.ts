import type { RuntimeTask } from '@pellux/goodvibes-sdk/platform/runtime/store/domains/tasks';
import type { UiTasksSnapshot } from './ui-read-models.ts';
import type { TaskCreateParams, TaskFailParams, TaskUpdateParams } from '@pellux/goodvibes-sdk/platform/runtime/tasks/types';

export interface OpsTaskApi {
  snapshot(): UiTasksSnapshot;
  list(limit?: number): readonly RuntimeTask[];
  get(taskId: string): RuntimeTask | null;
  running(): readonly RuntimeTask[];
  create(input: TaskCreateParams): RuntimeTask;
  update(taskId: string, input: TaskUpdateParams): RuntimeTask;
  complete(taskId: string, result?: unknown): RuntimeTask;
  fail(taskId: string, input: TaskFailParams): RuntimeTask;
  cancel(taskId: string, note?: string): void;
  pause(taskId: string, note?: string): void;
  resume(taskId: string, note?: string): void;
  retry(taskId: string, note?: string): void;
}

export interface OpsAgentApi {
  cancel(agentId: string, note?: string): void;
}

export interface OpsApi {
  readonly tasks: OpsTaskApi;
  readonly agents: OpsAgentApi;
}
