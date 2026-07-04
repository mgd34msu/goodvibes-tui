/**
 * EvalRegistry — holds the latest evaluation harness run state.
 *
 * W6.1 (the purge): extracted out of eval-panel.ts. 'eval' was
 * DELETE-disposition (no surviving human surface — the evaluation harness
 * is driven and reviewed via the `/eval` CLI command, input/commands/eval.ts)
 * but this registry is still a live consumer of `/eval run` output, so it
 * survives as a standalone read-model rather than being deleted with the
 * view. See .goodvibes/audit/2026-07-04-wave6-briefs.json (W6.1).
 */

import type { EvalSuiteResult, EvalGateResult } from '@/runtime/index.ts';

export class EvalRegistry {
  private _suiteResults: EvalSuiteResult[] = [];
  private _gateResults: EvalGateResult[] = [];
  private _running = false;
  private _lastRunAt: number | null = null;
  private readonly _subscribers = new Set<() => void>();

  push(result: EvalSuiteResult): void {
    const idx = this._suiteResults.findIndex((r) => r.suite === result.suite);
    if (idx >= 0) {
      this._suiteResults[idx] = result;
    } else {
      this._suiteResults.push(result);
    }
    this._lastRunAt = Date.now();
    this._notify();
  }

  pushGate(gate: EvalGateResult): void {
    const idx = this._gateResults.findIndex((g) => g.suite === gate.suite);
    if (idx >= 0) {
      this._gateResults[idx] = gate;
    } else {
      this._gateResults.push(gate);
    }
    this._notify();
  }

  setRunning(running: boolean): void {
    this._running = running;
    this._notify();
  }

  isRunning(): boolean { return this._running; }
  getLastRunAt(): number | null { return this._lastRunAt; }
  getSuiteResults(): EvalSuiteResult[] { return this._suiteResults; }
  getGateResults(): EvalGateResult[] { return this._gateResults; }

  subscribe(cb: () => void): () => void {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  private _notify(): void {
    for (const cb of this._subscribers) cb();
  }
}
