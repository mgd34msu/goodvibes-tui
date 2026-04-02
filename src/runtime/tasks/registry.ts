/**
 * TaskRegistry — in-memory index for RuntimeTask lookup by ID, kind, status,
 * and parent/child relationships.
 *
 * This is a pure data structure with no side effects. The UnifiedTaskManager
 * owns the registry instance and is responsible for keeping it consistent with
 * the Zustand store.
 */
import type { RuntimeTask, TaskKind } from '../store/domains/tasks.ts';

/**
 * TaskRegistry — provides O(1) task lookup by ID and O(k) lookup by kind,
 * running status, and parent task.
 *
 * All mutation methods return `this` for chaining.
 */
export class TaskRegistry {
  /** Primary task index keyed by task ID. */
  private readonly _tasks = new Map<string, RuntimeTask>();

  /**
   * Registers a task in the registry. If a task with the same ID already
   * exists it is replaced (treated as an update).
   *
   * @param task - The RuntimeTask to register.
   */
  public register(task: RuntimeTask): this {
    this._tasks.set(task.id, task);
    return this;
  }

  /**
   * Removes a task from the registry by ID.
   *
   * @param id - The task ID to remove.
   * @returns `true` if the task existed and was removed; `false` otherwise.
   */
  public deregister(id: string): boolean {
    return this._tasks.delete(id);
  }

  /**
   * Retrieves a task by its unique ID.
   *
   * @param id - The task ID to look up.
   * @returns The RuntimeTask if found, or `undefined`.
   */
  public get(id: string): RuntimeTask | undefined {
    return this._tasks.get(id);
  }

  /**
   * Returns all tasks of a given kind.
   *
   * @param kind - The TaskKind to filter by.
   * @returns Array of matching RuntimeTask records (may be empty).
   */
  public getByKind(kind: TaskKind): RuntimeTask[] {
    const results: RuntimeTask[] = [];
    for (const task of this._tasks.values()) {
      if (task.kind === kind) {
        results.push(task);
      }
    }
    return results;
  }

  /**
   * Returns all currently running tasks (status === 'running').
   *
   * @returns Array of RuntimeTask records with status 'running'.
   */
  public getRunning(): RuntimeTask[] {
    const results: RuntimeTask[] = [];
    for (const task of this._tasks.values()) {
      if (task.status === 'running') {
        results.push(task);
      }
    }
    return results;
  }

  /**
   * Returns all tasks that are direct children of the given parent task ID.
   *
   * @param parentId - The parent task ID.
   * @returns Array of child RuntimeTask records (may be empty).
   */
  public getChildren(parentId: string): RuntimeTask[] {
    const results: RuntimeTask[] = [];
    for (const task of this._tasks.values()) {
      if (task.parentTaskId === parentId) {
        results.push(task);
      }
    }
    return results;
  }

  /**
   * Returns all tasks matching the given status.
   *
   * @param status - The lifecycle status to filter by.
   * @returns Array of RuntimeTask records with the given status.
   */
  public getByStatus(
    status: RuntimeTask['status']
  ): RuntimeTask[] {
    const results: RuntimeTask[] = [];
    for (const task of this._tasks.values()) {
      if (task.status === status) {
        results.push(task);
      }
    }
    return results;
  }

  /**
   * Returns the total number of tasks currently tracked in the registry.
   */
  public get size(): number {
    return this._tasks.size;
  }

  /**
   * Returns a snapshot of all tasks as a new Map.
   * Mutations to the returned Map do not affect the registry.
   */
  public snapshot(): Map<string, RuntimeTask> {
    return new Map(this._tasks);
  }
}
