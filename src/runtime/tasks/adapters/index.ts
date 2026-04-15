/**
 * Task adapter barrel — re-exports all subsystem-to-RuntimeTask bridge adapters.
 *
 * Each adapter converts a subsystem-specific task representation into the
 * unified RuntimeTask model and handles lifecycle transitions.
 */

export { ProcessTaskAdapter } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/process-adapter';
export type { ProcessOwner } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/process-adapter';

export { AgentTaskAdapter } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/agent-adapter';
export type { AgentOwner } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/agent-adapter';

export { AcpTaskAdapter } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/acp-adapter';

export { SchedulerTaskAdapter } from '@pellux/goodvibes-sdk/platform/runtime/tasks/adapters/scheduler-adapter';
