import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AutomationStorePathConfig {
  readonly getControlPlaneConfigDir?: () => string;
}

function resolveDefaultAutomationRootDir(): string {
  const runtime = globalThis as typeof globalThis & { __gvTestConfigDir?: string };
  return runtime.__gvTestConfigDir ?? join(homedir(), '.goodvibes', 'tui');
}

export function resolveAutomationStorePath(
  filename: string,
  configManager?: AutomationStorePathConfig,
): string {
  const controlPlaneDir = typeof configManager?.getControlPlaneConfigDir === 'function'
    ? configManager.getControlPlaneConfigDir()
    : undefined;
  return join(controlPlaneDir ?? resolveDefaultAutomationRootDir(), filename);
}
