import { mkdirSync } from 'node:fs';
import type { CliCommandRuntime } from './management.ts';
import { buildCliServicePosture, createPlatformServiceManager, formatCliServicePosture, getServiceStateRoot } from './service-posture.ts';
import type { CliCommandOutput } from './types.ts';

function enableServicePosture(runtime: CliCommandRuntime): void {
  runtime.configManager.setDynamic('service.enabled', true);
  runtime.configManager.setDynamic('service.autostart', true);
  runtime.configManager.setDynamic('service.restartOnFailure', true);
}

export async function handleServiceCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub = 'status'] = runtime.cli.commandArgs;
  const json = runtime.cli.flags.outputFormat === 'json';
  if (sub === 'status' || sub === 'check') {
    const posture = await buildCliServicePosture(runtime, { probe: sub === 'check' });
    return {
      output: formatCliServicePosture(posture, json),
      exitCode: sub === 'check' && posture.issues.length > 0 ? 1 : 0,
    };
  }
  if (sub === 'install' || sub === 'start' || sub === 'restart' || sub === 'stop' || sub === 'uninstall') {
    const manager = createPlatformServiceManager(runtime);
    if (sub === 'install' || sub === 'start' || sub === 'restart') enableServicePosture(runtime);
    if (sub === 'install' || sub === 'start' || sub === 'restart') {
      mkdirSync(getServiceStateRoot(runtime), { recursive: true });
    }
    const result =
      sub === 'install' ? manager.install()
        : sub === 'start' ? manager.start()
          : sub === 'restart' ? manager.restart()
            : sub === 'stop' ? manager.stop()
              : manager.uninstall();
    const posture = await buildCliServicePosture(runtime);
    const text = [
      `Service ${sub}: ${result.actionError ? 'failed' : 'ok'}`,
      formatCliServicePosture(posture, false),
      ...(result.actionError ? [`actionError: ${result.actionError}`] : []),
    ].join('\n');
    return {
      output: json ? JSON.stringify({ action: sub, result, posture }, null, 2) : text,
      exitCode: result.actionError ? 1 : 0,
    };
  }
  return {
    output: 'Usage: goodvibes service [status|check|install|start|stop|restart|uninstall]',
    exitCode: 2,
  };
}
