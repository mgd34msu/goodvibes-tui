import type { PanelHealthMonitor } from '@pellux/goodvibes-sdk/platform/runtime/perf/panel-health-monitor';
import type { SandboxSessionRegistry } from '@pellux/goodvibes-sdk/platform/runtime/sandbox/session-registry';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
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
