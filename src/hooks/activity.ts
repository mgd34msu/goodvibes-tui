import type { HookEvent, HookResult, HookType } from './types.ts';

export interface HookActivityRecord {
  readonly timestamp: number;
  readonly path: string;
  readonly specific: string;
  readonly pattern: string;
  readonly hookName: string;
  readonly hookType: HookType;
  readonly ok: boolean;
  readonly decision?: HookResult['decision'];
  readonly error?: string;
  readonly durationMs: number;
  readonly async: boolean;
}

const MAX_ACTIVITY = 100;

export class HookActivityTracker {
  private readonly records: HookActivityRecord[] = [];

  public record(
    event: HookEvent,
    params: {
      pattern: string;
      hookName?: string;
      hookType: HookType;
      result: HookResult;
      durationMs: number;
      async: boolean;
    },
  ): void {
    this.records.unshift({
      timestamp: Date.now(),
      path: event.path,
      specific: event.specific,
      pattern: params.pattern,
      hookName: params.hookName ?? '(unnamed)',
      hookType: params.hookType,
      ok: params.result.ok,
      decision: params.result.decision,
      error: params.result.error,
      durationMs: params.durationMs,
      async: params.async,
    });
    if (this.records.length > MAX_ACTIVITY) {
      this.records.length = MAX_ACTIVITY;
    }
  }

  public listRecent(limit = 20): readonly HookActivityRecord[] {
    return this.records.slice(0, limit);
  }

  public clear(): void {
    this.records.length = 0;
  }
}

let _hookActivityTracker: HookActivityTracker | undefined;
export function getHookActivityTracker(): HookActivityTracker {
  if (!_hookActivityTracker) _hookActivityTracker = new HookActivityTracker();
  return _hookActivityTracker;
}
