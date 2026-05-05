import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applySandboxQemuSetupManifest,
  inspectSandboxQemuSetupManifest,
  loadSandboxQemuSetupManifest,
  scaffoldSandboxQemuSetupBundle,
} from '@/runtime/index.ts';

function makeManager(overrides: Partial<Record<string, unknown>> = {}) {
  const values = new Map<string, unknown>([
    ['sandbox.vmBackend', 'local'],
    ['sandbox.qemuBinary', 'qemu-system-x86_64'],
    ['sandbox.qemuImagePath', ''],
    ['sandbox.qemuExecWrapper', ''],
    ['sandbox.qemuGuestHost', '127.0.0.1'],
    ['sandbox.qemuGuestPort', 2222],
    ['sandbox.qemuGuestUser', 'goodvibes'],
    ['sandbox.qemuWorkspacePath', '/workspace'],
    ['sandbox.qemuSessionMode', 'attach'],
    ...Object.entries(overrides),
  ]);
  return {
    get(key: string) {
      return values.get(key);
    },
    setDynamic(key: string, value: unknown) {
      values.set(key, value);
    },
  };
}

describe('sandbox provisioning', () => {
  test('scaffolded setup bundle includes an inspectable/applyable manifest', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gv-sandbox-provision-'));
    try {
      const manager = makeManager();
      const bundle = scaffoldSandboxQemuSetupBundle(manager as never, cwd, '.goodvibes/tui/sandbox', { surfaceRoot: 'tui' });
      const manifest = loadSandboxQemuSetupManifest(cwd, bundle.manifestPath);
      expect(manifest.recommendedSettings.backend).toBe('qemu');
      expect(inspectSandboxQemuSetupManifest(manifest)).toContain('QEMU sandbox setup manifest');

      const target = makeManager();
      applySandboxQemuSetupManifest(target as never, manifest);
      expect(target.get('sandbox.vmBackend')).toBe('qemu');
      expect(target.get('sandbox.qemuExecWrapper')).toBe(bundle.wrapperPath);
      expect(target.get('sandbox.qemuImagePath')).toBe(bundle.imagePath);
      expect(target.get('sandbox.qemuGuestHost')).toBe('127.0.0.1');
      expect(target.get('sandbox.qemuGuestWorkspacePath')).toBeUndefined();
      expect(target.get('sandbox.qemuWorkspacePath')).toBe('/workspace');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
