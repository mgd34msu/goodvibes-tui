import { describe, expect, test } from 'bun:test';
import {
  evaluateInstallSelfCheck,
  repairCommandForInstallKind,
  runInstallSelfCheck,
  type DaemonPathResolution,
  type InstallSelfCheckInput,
} from '../../runtime/install-self-check.ts';

// A daemon resolution that points at an existing, absolute binary — the healthy case.
const healthyDaemon: DaemonPathResolution = {
  command: '/opt/goodvibes/vendor/goodvibes-daemon-linux-x64',
  source: 'package',
  absolute: true,
};

// A predicate that treats a fixed set of paths as present and everything else as absent.
function fileExistsFrom(present: readonly string[]): (path: string) => boolean {
  const set = new Set(present);
  return (path: string) => set.has(path);
}

function baseInput(overrides: Partial<InstallSelfCheckInput> = {}): InstallSelfCheckInput {
  return {
    installKind: 'bun-global-package',
    packageRoot: '/opt/goodvibes',
    platform: 'linux',
    arch: 'x64',
    daemon: healthyDaemon,
    fileExists: fileExistsFrom([
      '/opt/goodvibes/vendor/goodvibes-linux-x64',
      '/opt/goodvibes/vendor/goodvibes-daemon-linux-x64',
    ]),
    ...overrides,
  };
}

describe('repairCommandForInstallKind', () => {
  test('a standalone binary install is repaired by the installer one-liner', () => {
    expect(repairCommandForInstallKind('binary')).toBe('curl -fsSL https://goodvibes.sh/install.sh | sh');
  });

  test('a vendored package install is repaired by re-running the global add', () => {
    expect(repairCommandForInstallKind('bun-global-package')).toBe('bun add -g @pellux/goodvibes-tui');
  });
});

describe('evaluateInstallSelfCheck', () => {
  test('a source checkout is never flagged as incomplete', () => {
    const findings = evaluateInstallSelfCheck(baseInput({
      installKind: 'source',
      // Even with nothing on disk, a source checkout is complete by definition.
      fileExists: () => false,
      daemon: { command: 'goodvibes-daemon', source: 'fallback', absolute: false },
    }));
    expect(findings).toEqual([]);
  });

  test('a healthy vendored package install produces no findings', () => {
    expect(evaluateInstallSelfCheck(baseInput())).toEqual([]);
  });

  test('flags missing vendored binaries with the exact repair command', () => {
    const findings = evaluateInstallSelfCheck(baseInput({
      // Only the app binary is present; the daemon vendor binary is absent.
      fileExists: fileExistsFrom(['/opt/goodvibes/vendor/goodvibes-linux-x64']),
      // ...but the daemon resolver still found a runnable path elsewhere, so
      // only the vendor-binary finding should fire here.
      daemon: healthyDaemon,
    }));
    const missing = findings.find((finding) => finding.id === 'missing-vendor-binaries');
    expect(missing).toBeDefined();
    expect(missing?.detail).toContain('goodvibes-daemon-linux-x64');
    expect(missing?.repairCommand).toBe('bun add -g @pellux/goodvibes-tui');
  });

  test('flags a broken daemon path when resolution fell back to a bare PATH command', () => {
    const findings = evaluateInstallSelfCheck(baseInput({
      daemon: { command: 'goodvibes-daemon', source: 'fallback', absolute: false },
    }));
    const broken = findings.find((finding) => finding.id === 'broken-daemon-path');
    expect(broken).toBeDefined();
    expect(broken?.detail).toContain('falls back to a bare');
  });

  test('flags a broken daemon path when the resolved absolute file does not exist', () => {
    const findings = evaluateInstallSelfCheck(baseInput({
      daemon: { command: '/opt/goodvibes/vendor/goodvibes-daemon-linux-x64', source: 'package', absolute: true },
      // The vendor app binary exists but the resolved daemon file does not.
      fileExists: fileExistsFrom(['/opt/goodvibes/vendor/goodvibes-linux-x64']),
    }));
    const broken = findings.find((finding) => finding.id === 'broken-daemon-path');
    expect(broken).toBeDefined();
    expect(broken?.detail).toContain('does not exist');
  });

  test('a standalone binary install checks the daemon path but not a vendor dir', () => {
    const findings = evaluateInstallSelfCheck(baseInput({
      installKind: 'binary',
      // No vendor binaries on disk at all, but a standalone binary has no
      // vendor dir — only the daemon-path check applies, and here it resolves.
      fileExists: () => false,
      daemon: { command: '/home/user/.local/bin/goodvibes-daemon', source: 'sibling', absolute: true },
    }));
    // No missing-vendor-binaries finding for a standalone binary install.
    expect(findings.map((finding) => finding.id)).not.toContain('missing-vendor-binaries');
  });
});

describe('runInstallSelfCheck', () => {
  test('detects the install kind from the exec path and evaluates', () => {
    const findings = runInstallSelfCheck({
      execPath: '/home/user/.bun/install/global/node_modules/@pellux/goodvibes-tui/vendor/goodvibes-linux-x64',
      packageRoot: '/opt/goodvibes',
      platform: 'linux',
      arch: 'x64',
      daemon: { command: 'goodvibes-daemon', source: 'fallback', absolute: false },
      fileExists: fileExistsFrom([
        '/opt/goodvibes/vendor/goodvibes-linux-x64',
        '/opt/goodvibes/vendor/goodvibes-daemon-linux-x64',
      ]),
    });
    // Detected as bun-global-package; vendor binaries present, but the daemon
    // resolution fell back, so exactly the broken-daemon-path finding fires.
    expect(findings.map((finding) => finding.id)).toEqual(['broken-daemon-path']);
  });

  test('a source exec path (running via bun) is never flagged', () => {
    const findings = runInstallSelfCheck({
      execPath: '/home/user/.bun/bin/bun',
      packageRoot: '/opt/goodvibes',
      platform: 'linux',
      arch: 'x64',
      daemon: { command: 'goodvibes-daemon', source: 'fallback', absolute: false },
      fileExists: () => false,
    });
    expect(findings).toEqual([]);
  });
});
