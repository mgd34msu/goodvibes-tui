/**
 * Playbook: Permission Deadlock
 *
 * Diagnoses and resolves situations where permission requests are blocking
 * forward progress — typically from circular approval chains, missing
 * policy rules, or a stalled permission UI prompt.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.ts';
import { safeCheck } from '../safe-check.ts';

/** Permission deadlock resolution playbook. */
export const permissionDeadlockPlaybook: Playbook = {
  id: 'permission-deadlock',
  name: 'Permission Deadlock',
  description:
    'Diagnoses and resolves permission deadlocks where tool execution is ' +
    'blocked waiting for approvals that never arrive or form a cycle.',
  symptoms: [
    'Tool calls stuck in AWAITING_PERMISSION state for > 30 s',
    'TUI permission prompt displayed but not responding to input',
    'Turn throughput drops to zero with CPU near 0%',
    'Permission span shows no RESOLVED event',
    'Multiple tools queued behind a single blocked permission request',
  ],
  checks: [
    {
      id: 'permission.pending-requests',
      label: 'Pending permission requests',
      description: 'Checks how many permission requests are currently awaiting approval.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Pending request count requires live PermissionManager context.',
          severity: 'warning',
          context: { hint: 'Inspect PermissionManager.pendingRequests()' },
        })),
    },
    {
      id: 'permission.policy-match',
      label: 'Policy rule matched',
      description: 'Checks whether the blocked permission request matches any configured allow/deny rule.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Policy matching requires live policy engine context.',
          severity: 'warning',
          context: { hint: 'Run PermissionPolicyEngine.evaluate(request) to test match' },
        })),
    },
    {
      id: 'permission.ui-responsive',
      label: 'Permission UI responsive',
      description: 'Checks whether the TUI permission prompt is rendered and responding to input.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'UI responsiveness requires live render context.',
          severity: 'warning',
          context: { hint: 'Check Ink render tree for active PermissionPrompt component' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'List pending permission requests',
      action:
        'Enumerate all requests currently in the AWAITING_PERMISSION state. ' +
        'Note the tool name, requested capability, and how long it has been pending.',
      kind: 'observe',
      command: 'runtime.permissions.listPending()',
      expectedOutcome: 'List of pending requests with ages.',
      automatable: true,
    },
    {
      step: 2,
      title: 'Check policy coverage',
      action:
        'Evaluate each pending request against the configured policy rules. ' +
        'Identify requests with no matching rule (falling through to manual approval).',
      kind: 'observe',
      command: 'runtime.permissions.evaluatePolicy(requestId)',
      expectedOutcome: 'Each request either has a matching rule or is identified as uncovered.',
      automatable: true,
    },
    {
      step: 3,
      title: 'Add a temporary allow rule',
      action:
        'Add a scoped allow rule for the blocked capability to unblock forward progress. ' +
        'Log the rule addition for audit review.',
      kind: 'config',
      command: 'runtime.permissions.addRule({ effect: "allow", tool: "<tool>", capability: "<cap>" })',
      expectedOutcome: 'Pending request auto-approved; tool execution resumes.',
      automatable: false,
    },
    {
      step: 4,
      title: 'Deny and skip blocked tool',
      action:
        'If adding an allow rule is not appropriate, deny the pending request and ' +
        'allow the turn to continue without the blocked tool.',
      kind: 'command',
      command: 'runtime.permissions.deny(requestId, { reason: "ops-override" })',
      expectedOutcome: 'Tool call skipped; turn resumes with remaining tools.',
      automatable: true,
    },
    {
      step: 5,
      title: 'Review and update policy ruleset',
      action:
        'Audit the permission policy configuration to add appropriate rules ' +
        'that prevent this deadlock from recurring.',
      kind: 'config',
      expectedOutcome: 'Policy updated; future similar requests handled automatically.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'Permission UI is rendering but unresponsive to keyboard input (Ink render stall)',
    'Adding allow rules does not unblock the pending request',
    'Multiple concurrent permission deadlocks across different turns',
    'Policy engine itself is throwing on evaluation',
  ],
  tags: ['permission', 'deadlock', 'tools', 'policy', 'approval'],
};
