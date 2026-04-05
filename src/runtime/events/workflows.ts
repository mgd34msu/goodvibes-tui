/**
 * WorkflowEvent — discriminated union for WRFC workflow lifecycle events.
 */
import type { WrfcState } from '../../agents/wrfc-types.ts';

export type WorkflowEvent =
  | { type: 'WORKFLOW_CHAIN_CREATED'; chainId: string; task: string }
  | { type: 'WORKFLOW_STATE_CHANGED'; chainId: string; from: WrfcState; to: WrfcState }
  | { type: 'WORKFLOW_REVIEW_COMPLETED'; chainId: string; score: number; passed: boolean }
  | { type: 'WORKFLOW_FIX_ATTEMPTED'; chainId: string; attempt: number; maxAttempts: number }
  | { type: 'WORKFLOW_GATE_RESULT'; chainId: string; gate: string; passed: boolean }
  | { type: 'WORKFLOW_CHAIN_PASSED'; chainId: string }
  | { type: 'WORKFLOW_CHAIN_FAILED'; chainId: string; reason: string }
  | { type: 'WORKFLOW_AUTO_COMMITTED'; chainId: string; commitHash?: string }
  | { type: 'WORKFLOW_CASCADE_ABORTED'; chainId: string; reason: string };

export type WorkflowEventType = WorkflowEvent['type'];
