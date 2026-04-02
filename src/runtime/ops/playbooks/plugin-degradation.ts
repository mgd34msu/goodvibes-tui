/**
 * Playbook: Plugin Degradation
 *
 * Diagnoses and resolves scenarios where a plugin is operating in a
 * degraded state — returning errors, crashing, or producing incorrect output.
 */
import type { Playbook, DiagnosticCheckResult } from '../types.ts';
import { safeCheck } from '../safe-check.ts';

/** Plugin degradation resolution playbook. */
export const pluginDegradationPlaybook: Playbook = {
  id: 'plugin-degradation',
  name: 'Plugin Degradation',
  description:
    'Diagnoses and resolves plugins operating in a degraded state. ' +
    'Covers plugin crashes, capability failures, and incompatible plugin versions.',
  symptoms: [
    'Plugin health check returns DEGRADED or ERROR',
    'Tool calls routed to the plugin consistently failing',
    'Plugin span shows repeated ERROR events with short durations',
    'Plugin capability telemetry shows 0 successful invocations',
    'MCP server for the plugin is unresponsive',
  ],
  checks: [
    {
      id: 'plugin.health-status',
      label: 'Plugin health status',
      description: 'Checks the current health status reported by the plugin.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Plugin health status requires live PluginManager context.',
          severity: 'warning',
          context: { hint: 'Inspect PluginManager.getHealth(pluginId)' },
        })),
    },
    {
      id: 'plugin.capability-available',
      label: 'Required capability available',
      description: 'Checks whether the plugin exposes the expected capability/tool.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Capability availability requires live plugin registry context.',
          severity: 'warning',
          context: { hint: 'Run PluginRegistry.listCapabilities(pluginId)' },
        })),
    },
    {
      id: 'plugin.version-compat',
      label: 'Plugin version compatible',
      description: 'Checks whether the plugin version is compatible with the current runtime version.',
      run: async (): Promise<DiagnosticCheckResult> =>
        safeCheck(async () => ({
          passed: false,
          summary: 'Version compatibility requires live plugin manifest context.',
          severity: 'warning',
          context: { hint: 'Compare plugin.manifest.runtimeVersion with runtime.version' },
        })),
    },
  ],
  steps: [
    {
      step: 1,
      title: 'Inspect plugin error telemetry',
      action:
        'Review the local ledger for plugin.* spans with ERROR status. ' +
        'Note the error message, plugin ID, and capability being invoked.',
      kind: 'observe',
      expectedOutcome: 'Root cause identified from span error messages.',
      automatable: false,
    },
    {
      step: 2,
      title: 'Restart the plugin',
      action:
        'Trigger a graceful plugin restart via the PluginManager. ' +
        'This resets the plugin process and re-establishes MCP connection.',
      kind: 'command',
      command: 'runtime.plugins.restart(pluginId)',
      expectedOutcome: 'Plugin lifecycle spans show INIT → READY sequence.',
      automatable: true,
    },
    {
      step: 3,
      title: 'Disable degraded plugin',
      action:
        'If the restart does not recover the plugin, disable it to prevent ' +
        'further tool-call failures. Other plugins and turns can continue.',
      kind: 'command',
      command: 'runtime.plugins.disable(pluginId)',
      expectedOutcome: 'Plugin disabled; tool calls routed away or failing fast.',
      automatable: true,
    },
    {
      step: 4,
      title: 'Check plugin version compatibility',
      action:
        'Verify that the installed plugin version is compatible with the current runtime. ' +
        'Update or downgrade the plugin if needed.',
      kind: 'observe',
      expectedOutcome: 'Compatible version identified and installed.',
      automatable: false,
    },
    {
      step: 5,
      title: 'Re-enable plugin after fix',
      action:
        'After resolving the root cause, re-enable the plugin and verify ' +
        'capability invocations succeed.',
      kind: 'command',
      command: 'runtime.plugins.enable(pluginId)',
      expectedOutcome: 'Plugin health returns to HEALTHY; tool calls succeed.',
      automatable: false,
    },
  ],
  escalationCriteria: [
    'Plugin crashes immediately after restart (< 5 s uptime)',
    'All available plugin versions are incompatible with the runtime',
    'Plugin degradation causes cascading failures in dependent plugins',
    'MCP server for the plugin cannot be started (port conflict, missing binary)',
  ],
  tags: ['plugin', 'mcp', 'capability', 'crash', 'degradation'],
};
