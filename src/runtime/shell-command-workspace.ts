import type { PanelHealthMonitor } from './perf/panel-health-monitor.ts';
import type { SandboxSessionRegistry } from './sandbox/session-registry.ts';
import type { ShellPathService } from './shell-paths.ts';
import type { WorktreeRegistry } from './worktree/registry.ts';

export interface CommandWorkspaceShellServices {
  readonly shellPaths?: ShellPathService;
  readonly panelHealthMonitor?: PanelHealthMonitor;
  readonly worktreeRegistry?: WorktreeRegistry;
  readonly sandboxSessionRegistry?: SandboxSessionRegistry;
}

export interface CreateShellWorkspaceServicesOptions extends CommandWorkspaceShellServices {}

export function createShellWorkspaceServices(
  options: CreateShellWorkspaceServicesOptions,
): CommandWorkspaceShellServices {
  const {
    shellPaths,
    panelHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
  } = options;

  return {
    shellPaths,
    panelHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
  };
}
