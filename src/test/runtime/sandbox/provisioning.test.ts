import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      expect(manifest.recommendedSettings.qemuBinary).toBe('qemu-system-x86_64');
      expect(manifest.recommendedSettings.sessionMode).toBe('launch-per-command');
      expect(manifest.recommendedSettings.replJavaScriptCommand).toBe('/home/goodvibes/.bun/bin/bun');
      expect(manifest.seedIsoPath.endsWith('/seed/nocloud.iso')).toBe(true);
      expect(inspectSandboxQemuSetupManifest(manifest)).toContain('QEMU sandbox setup manifest');
      expect(existsSync(bundle.wrapperPath)).toBe(true);
      expect(existsSync(bundle.imageCreateScriptPath)).toBe(true);
      expect(existsSync(bundle.guestBootstrapScriptPath)).toBe(true);
      expect(readFileSync(bundle.wrapperPath, 'utf8')).toContain('GV_SANDBOX_WRAPPER_MODE');
      expect(readFileSync(bundle.wrapperPath, 'utf8')).toContain('launch-qemu-ssh');
      expect(readFileSync(bundle.wrapperPath, 'utf8')).toContain('-netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$port-:22"');
      expect(readFileSync(bundle.wrapperPath, 'utf8')).toContain('export PATH=\\$HOME/.bun/bin:\\$HOME/.deno/bin:\\$HOME/.local/bin:\\$PATH');
      expect(readFileSync(join(bundle.seedDirectory, 'network-config'), 'utf8')).toContain('name: "ens3"');
      expect(readFileSync(join(bundle.seedDirectory, 'user-data'), 'utf8')).toContain('systemd-networkd-wait-online.service');
      expect(readFileSync(bundle.imageCreateScriptPath, 'utf8')).toContain('debian-12-genericcloud-amd64.qcow2');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('tsx ts-node graphql');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('postgresql-client');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('mariadb-client');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('golang');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('GOODVIBES_QEMU_INSTALL_BUN:-1');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('GOODVIBES_QEMU_INSTALL_DUCKDB:-1');
      expect(readFileSync(bundle.guestBootstrapScriptPath, 'utf8')).toContain('/usr/local/bin/bun');

      const target = makeManager();
      applySandboxQemuSetupManifest(target as never, manifest);
      expect(target.get('sandbox.vmBackend')).toBe('qemu');
      expect(target.get('sandbox.qemuBinary')).toBe('qemu-system-x86_64');
      expect(target.get('sandbox.qemuExecWrapper')).toBe(bundle.wrapperPath);
      expect(target.get('sandbox.qemuImagePath')).toBe(bundle.imagePath);
      expect(target.get('sandbox.qemuGuestHost')).toBe('127.0.0.1');
      expect(target.get('sandbox.qemuGuestWorkspacePath')).toBeUndefined();
      expect(target.get('sandbox.qemuWorkspacePath')).toBe('/workspace');
      expect(target.get('sandbox.qemuSessionMode')).toBe('launch-per-command');
      expect(target.get('sandbox.replJavaScriptCommand')).toBe('/home/goodvibes/.bun/bin/bun');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('scaffolded setup bundle can target an absolute user GoodVibes directory', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gv-sandbox-provision-workspace-'));
    const home = mkdtempSync(join(tmpdir(), 'gv-sandbox-provision-home-'));
    try {
      const manager = makeManager();
      const targetDir = join(home, '.goodvibes', 'tui', 'sandbox');
      const bundle = scaffoldSandboxQemuSetupBundle(manager as never, cwd, targetDir, { surfaceRoot: 'tui' });
      expect(bundle.directory).toBe(targetDir);
      expect(bundle.wrapperPath).toBe(join(targetDir, 'qemu-wrapper.sh'));
      expect(bundle.imagePath).toBe(join(targetDir, 'goodvibes-sandbox.qcow2'));
      expect(existsSync(bundle.wrapperPath)).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
