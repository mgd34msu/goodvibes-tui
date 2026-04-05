import { PolicyRegistry } from './policy-registry.ts';
import { DivergencePanel } from '../diagnostics/panels/divergence.ts';
import type { PolicyPanelSnapshot } from '../diagnostics/panels/policy.ts';
import { PolicyPanel as PolicyDiagnosticsPanel } from '../diagnostics/panels/policy.ts';
import type { DivergenceDashboard } from './divergence-dashboard.ts';

export class PolicyRuntimeState {
  private readonly _registry: PolicyRegistry;
  private _dashboard: DivergenceDashboard | null = null;
  private _divergencePanel: DivergencePanel | null = null;
  private readonly _subscribers = new Set<() => void>();

  public constructor(registry: PolicyRegistry = new PolicyRegistry()) {
    this._registry = registry;
  }

  public getRegistry(): PolicyRegistry {
    return this._registry;
  }

  public getDashboard(): DivergenceDashboard | null {
    return this._dashboard;
  }

  public getDivergencePanel(): DivergencePanel | null {
    return this._divergencePanel;
  }

  public setDashboard(dashboard: DivergenceDashboard | null): void {
    this._divergencePanel?.dispose();
    this._dashboard = dashboard;
    this._divergencePanel = dashboard ? new DivergencePanel(dashboard) : null;
    this.notify();
  }

  public recordTrendEntry(): void {
    this._divergencePanel?.recordTrendEntry();
    this.notify();
  }

  public getSnapshot(): PolicyPanelSnapshot {
    const panel = new PolicyDiagnosticsPanel(this._registry, this._divergencePanel);
    return panel.getSnapshot();
  }

  public subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  public notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch {
        // Panel/runtime subscribers must not break policy state propagation.
      }
    }
  }
}

let _policyRuntimeState: PolicyRuntimeState | null = null;

export function getPolicyRuntimeState(): PolicyRuntimeState {
  if (_policyRuntimeState === null) {
    _policyRuntimeState = new PolicyRuntimeState();
  }
  return _policyRuntimeState;
}

export function resetPolicyRuntimeStateForTests(): void {
  _policyRuntimeState = null;
}
