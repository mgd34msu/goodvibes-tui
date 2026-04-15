import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

export function resetSettingsControlPlaneStore(configManager: ConfigManager): void {
  rmSync(join(configManager.getControlPlaneConfigDir(), 'settings-sync.json'), {
    force: true,
  });
}
