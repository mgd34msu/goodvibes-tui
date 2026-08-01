// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';

export function resetSettingsControlPlaneStore(configManager: ConfigManager): void {
  rmSync(join(configManager.getControlPlaneConfigDir(), 'settings-sync.json'), {
    force: true,
  });
}
