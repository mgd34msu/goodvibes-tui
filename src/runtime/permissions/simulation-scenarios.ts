import type { PermissionSimulator } from './simulation.ts';
import type { DivergenceType, PermissionDecision, SimulationMode } from './types.ts';

export interface PolicySimulationScenario {
  id: string;
  label: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PolicySimulationScenarioResult {
  scenario: PolicySimulationScenario;
  actualDecision: PermissionDecision;
  simulatedDecision: PermissionDecision;
  authoritativeDecision: PermissionDecision;
  diverged: boolean;
  divergenceType?: DivergenceType;
}

export interface PolicySimulationSummary {
  simulatedAt: string;
  mode: SimulationMode;
  totalScenarios: number;
  divergentScenarios: number;
  allowedByActual: number;
  allowedBySimulated: number;
  results: PolicySimulationScenarioResult[];
}

export function buildDefaultPolicySimulationScenarios(): PolicySimulationScenario[] {
  return [
    { id: 'read-project-file', label: 'Read project file', toolName: 'read', args: { path: '/workspace/README.md' } },
    { id: 'write-project-file', label: 'Write project file', toolName: 'write', args: { path: '/workspace/out.txt', content: 'hello' } },
    { id: 'edit-config', label: 'Edit shell config', toolName: 'edit', args: { path: '/home/user/.bashrc', old_string: 'foo', new_string: 'bar' } },
    { id: 'exec-safe', label: 'Run safe shell command', toolName: 'exec', args: { command: 'git status' } },
    { id: 'exec-network', label: 'Run networked shell command', toolName: 'exec', args: { command: 'curl https://example.com' } },
    { id: 'fetch-remote', label: 'Fetch remote resource', toolName: 'fetch', args: { url: 'https://docs.example.com/reference' } },
    { id: 'spawn-agent', label: 'Delegate a worker', toolName: 'agent', args: { mode: 'spawn', task: 'Inspect repository' } },
    { id: 'mcp-docs', label: 'Call MCP docs search', toolName: 'mcp', args: { server: 'docs', tool: 'search_docs', query: 'runtime hooks' } },
  ];
}

export function runPolicySimulationScenarios(
  simulator: PermissionSimulator,
  scenarios: PolicySimulationScenario[] = buildDefaultPolicySimulationScenarios(),
): PolicySimulationSummary {
  const results = scenarios.map((scenario) => {
    const result = simulator.evaluate(scenario.toolName, scenario.args);
    return {
      scenario,
      actualDecision: result.actualDecision,
      simulatedDecision: result.simulatedDecision,
      authoritativeDecision: result.authoritativeDecision,
      diverged: result.diverged,
      ...(result.divergenceType !== undefined ? { divergenceType: result.divergenceType } : {}),
    };
  });

  return {
    simulatedAt: new Date().toISOString(),
    mode: simulator.getSimulationMode(),
    totalScenarios: results.length,
    divergentScenarios: results.filter((result) => result.diverged).length,
    allowedByActual: results.filter((result) => result.actualDecision.allowed).length,
    allowedBySimulated: results.filter((result) => result.simulatedDecision.allowed).length,
    results,
  };
}
