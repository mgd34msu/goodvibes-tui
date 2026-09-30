import { describe, expect, test } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSandboxProfiles } from '@/runtime/index.ts';
import {
  buildSandboxLaunchPlan,
  executeSandboxCommand,
  executeSandboxManagedCommand,
  probeSandboxBackends,
  resolveSandboxCommandPlan,
} from '@/runtime/index.ts';
import { renderQemuWrapperTemplate } from '@/runtime/index.ts';

function makeManager(overrides: Partial<Record<string, unknown>> = {}) {
  const values = new Map<string, unknown>([
    ['sandbox.replIsolation', 'shared-vm'],
    ['sandbox.mcpIsolation', 'disabled'],
    ['sandbox.windowsMode', 'native-basic'],
    ['sandbox.vmBackend', 'local'],
    ['sandbox.qemuBinary', 'qemu-system-x86_64'],
    ['sandbox.qemuImagePath', ''],
    ['sandbox.qemuExecWrapper', ''],
    ['sandbox.qemuGuestHost', ''],
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
  };
}

const WORKSPACE_ROOT = process.cwd();

describe('sandbox manager', () => {

  test('probes backends and builds launch plans', () => {
    const manager = makeManager({ 'sandbox.vmBackend': 'local' });
    const probe = probeSandboxBackends(manager as never);
    expect(probe.backends.some((entry) => entry.id === 'local' && entry.available)).toBe(true);

    const profile = listSandboxProfiles(manager as never).find((entry) => entry.id === 'eval-py');
    expect(profile).toBeDefined();
    const plan = buildSandboxLaunchPlan(profile!, 'Python eval', manager as never, WORKSPACE_ROOT);
    expect(plan.summary.length).toBeGreaterThan(0);
    expect(plan.workspaceRoot.length).toBeGreaterThan(0);
  });

  test('qemu launch plans carry configured binary and image path', () => {
    const manager = makeManager({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuBinary': 'bash',
      'sandbox.qemuImagePath': '/tmp/gv-sandbox.qcow2',
    });
    const profile = listSandboxProfiles(manager as never).find((entry) => entry.id === 'eval-py');
    expect(profile).toBeDefined();
    const plan = buildSandboxLaunchPlan(profile!, 'Python eval', manager as never, WORKSPACE_ROOT);
    expect(plan.command).toBe('bash');
    expect(plan.imagePath).toBe('/tmp/gv-sandbox.qcow2');
    expect(plan.summary).toContain('/tmp/gv-sandbox.qcow2');
  });

  test('resolves and executes local sandbox commands', () => {
    const commandPlan = resolveSandboxCommandPlan({
      backend: 'local',
      command: 'bash',
      args: ['-lc', 'true'],
      workspaceRoot: process.cwd(),
      summary: 'local',
    }, 'bash', ['-lc', 'printf sandbox-ok']);
    expect(commandPlan.command).toBe('bash');
    expect(commandPlan.summary).toContain('printf sandbox-ok');

    const result = executeSandboxCommand({
      backend: 'local',
      command: 'bash',
      args: ['-lc', 'true'],
      workspaceRoot: process.cwd(),
      summary: 'local',
    }, 'bash', ['-lc', 'printf sandbox-ok']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sandbox-ok');
  });

  test('qemu wrapper template can execute bridge commands in host-exec mode', () => {
    const wrapperPath = join(tmpdir(), `gv-qemu-wrapper-template-${Date.now()}.sh`);
    writeFileSync(wrapperPath, renderQemuWrapperTemplate(), 'utf-8');
    chmodSync(wrapperPath, 0o755);
    const manager = makeManager({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuBinary': 'bash',
      'sandbox.qemuImagePath': '/tmp/gv-sandbox.qcow2',
      'sandbox.qemuExecWrapper': wrapperPath,
    });
    const profile = listSandboxProfiles(manager as never).find((entry) => entry.id === 'eval-js');
    expect(profile).toBeDefined();
    const plan = buildSandboxLaunchPlan(profile!, 'JavaScript eval', manager as never, WORKSPACE_ROOT);
    const result = executeSandboxManagedCommand(plan, 'bash', ['-lc', 'printf wrapper-ok'], manager as never, {
      env: {
        GV_SANDBOX_WRAPPER_MODE: 'host-exec',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wrapper-ok');
  });

  test('qemu command plan switches wrapper mode to ssh-guest when guest transport is configured', () => {
    const wrapperPath = join(tmpdir(), `gv-qemu-wrapper-mode-${Date.now()}.sh`);
    writeFileSync(wrapperPath, renderQemuWrapperTemplate(), 'utf-8');
    chmodSync(wrapperPath, 0o755);
    const manager = makeManager({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuBinary': 'bash',
      'sandbox.qemuImagePath': '/tmp/gv-sandbox.qcow2',
      'sandbox.qemuExecWrapper': wrapperPath,
      'sandbox.qemuGuestHost': '127.0.0.1',
      'sandbox.qemuGuestPort': 2222,
      'sandbox.qemuGuestUser': 'goodvibes',
      'sandbox.qemuWorkspacePath': '/workspace',
    });
    const profile = listSandboxProfiles(manager as never).find((entry) => entry.id === 'eval-js');
    expect(profile).toBeDefined();
    const plan = buildSandboxLaunchPlan(profile!, 'JavaScript eval', manager as never, WORKSPACE_ROOT);
    const resolved = resolveSandboxCommandPlan(plan, 'bash', ['-lc', 'printf guest-ok'], manager as never);
    expect(resolved.command).toBe(wrapperPath);
    expect(resolved.env?.GV_SANDBOX_WRAPPER_MODE).toBe('ssh-guest');
    expect(resolved.env?.GV_SANDBOX_GUEST_HOST).toBe('127.0.0.1');
  });

  test('qemu command plan can request launch-per-command guest lifecycle', () => {
    const wrapperPath = join(tmpdir(), `gv-qemu-wrapper-launch-${Date.now()}.sh`);
    writeFileSync(wrapperPath, renderQemuWrapperTemplate(), 'utf-8');
    chmodSync(wrapperPath, 0o755);
    const manager = makeManager({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuBinary': 'bash',
      'sandbox.qemuImagePath': '/tmp/gv-sandbox.qcow2',
      'sandbox.qemuExecWrapper': wrapperPath,
      'sandbox.qemuGuestHost': '127.0.0.1',
      'sandbox.qemuSessionMode': 'launch-per-command',
    });
    const profile = listSandboxProfiles(manager as never).find((entry) => entry.id === 'eval-js');
    expect(profile).toBeDefined();
    const plan = buildSandboxLaunchPlan(profile!, 'JavaScript eval', manager as never, WORKSPACE_ROOT);
    const resolved = resolveSandboxCommandPlan(plan, 'bash', ['-lc', 'printf guest-ok'], manager as never);
    expect(resolved.env?.GV_SANDBOX_WRAPPER_MODE).toBe('launch-qemu-ssh');
  });

  test('qemu probe warns when wrapper path is missing or not executable', () => {
    const missingPath = join(tmpdir(), `gv-missing-wrapper-${Date.now()}.sh`);
    const missingProbe = probeSandboxBackends(makeManager({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuImagePath': '/tmp/gv-sandbox.qcow2',
      'sandbox.qemuExecWrapper': missingPath,
    }) as never);
    expect(missingProbe.warnings.join('\n')).toContain('does not exist');

    const nonExecPath = join(tmpdir(), `gv-nonexec-wrapper-${Date.now()}.sh`);
    writeFileSync(nonExecPath, '#!/usr/bin/env bash\nexit 0\n', 'utf-8');
    chmodSync(nonExecPath, 0o644);
    const nonExecProbe = probeSandboxBackends(makeManager({
      'sandbox.vmBackend': 'qemu',
      'sandbox.qemuImagePath': '/tmp/gv-sandbox.qcow2',
      'sandbox.qemuExecWrapper': nonExecPath,
    }) as never);
    expect(nonExecProbe.warnings.join('\n')).toContain('not executable');
  });
});
