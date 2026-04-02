/**
 * Task adapter barrel — re-exports all subsystem-to-RuntimeTask bridge adapters.
 *
 * Each adapter converts a subsystem-specific task representation into the
 * unified RuntimeTask model and handles lifecycle transitions.
 */

export { ProcessTaskAdapter } from './process-adapter.ts';
export type { ProcessOwner } from './process-adapter.ts';

export { AgentTaskAdapter } from './agent-adapter.ts';
export type { AgentOwner } from './agent-adapter.ts';

export { AcpTaskAdapter } from './acp-adapter.ts';

export { SchedulerTaskAdapter } from './scheduler-adapter.ts';
