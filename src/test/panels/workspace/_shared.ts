// ---------------------------------------------------------------------------
// src/test/panels/workspace/_shared.ts
//
// Shared fixtures used by the per-panel shared-workspace suites in this
// directory (WO-006 decongestion of the former workspace-migration.test.ts).
// Panels that also carry a BasePanel contract entry (WrfcPanel) had their
// shared-workspace test moved into the matching
// src/test/panels/contract/<panel-id>.contract.ts module instead of living
// here. (agent-logs-panel.contract.ts was removed under WO-110: AgentLogsPanel
// was merged into AgentInspectorPanel; ContextVisualizerPanel's contract
// module was folded into TokenBudgetPanel's by WO-113 when the two panels
// merged.)
// ---------------------------------------------------------------------------

import { RuntimeEventBus } from '@/runtime/index.ts';
import type { Line } from '../../../types/grid.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
export const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

export function linesText(lines: Line[]): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('')).join('\n');
}

export function createRuntimeBusStub(): RuntimeEventBus {
  return new RuntimeEventBus();
}
