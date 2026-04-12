import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '../../config/manager.ts';

export function resetSettingsControlPlaneStore(configManager: ConfigManager): void {
  rmSync(join(configManager.getControlPlaneConfigDir(), 'settings-sync.json'), {
    force: true,
  });
}
