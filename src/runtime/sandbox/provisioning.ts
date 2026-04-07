import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ConfigManager } from '../../config/manager.ts';
import { getSandboxConfigSnapshot } from './manager.ts';
import { renderQemuWrapperTemplate } from './qemu-wrapper-template.ts';

export interface SandboxDoctorCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SandboxGuestBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly guest: {
    readonly qemuBinary: string;
    readonly imagePath: string;
    readonly wrapperPath: string;
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly workspacePath: string;
    readonly sessionMode: string;
  };
  readonly nextSteps: readonly string[];
}

export interface SandboxQemuInitBundle {
  readonly directory: string;
  readonly wrapperPath: string;
  readonly guestBundlePath: string;
  readonly readmePath: string;
}

export interface SandboxQemuSetupBundle extends SandboxQemuInitBundle {
  readonly imagePath: string;
  readonly imageCreateScriptPath: string;
  readonly guestBootstrapScriptPath: string;
  readonly projectionPolicyPath: string;
  readonly sshConfigPath: string;
  readonly manifestPath: string;
}

export interface SandboxQemuSetupManifest {
  readonly version: 1;
  readonly createdAt: number;
  readonly wrapperPath: string;
  readonly imagePath: string;
  readonly imageCreateScriptPath: string;
  readonly guestBootstrapScriptPath: string;
  readonly projectionPolicyPath: string;
  readonly sshConfigPath: string;
  readonly recommendedSettings: {
    readonly backend: 'qemu';
    readonly wrapperPath: string;
    readonly imagePath: string;
    readonly guestHost: string;
    readonly guestPort: number;
    readonly guestUser: string;
    readonly guestWorkspacePath: string;
    readonly sessionMode: string;
  };
}

function existsExecutable(pathArg: string): boolean {
  if (!pathArg) return false;
  try {
    const stat = Bun.file(pathArg);
    return stat.size >= 0;
  } catch {
    return false;
  }
}

export function buildSandboxDoctorChecks(manager: ConfigManager): SandboxDoctorCheck[] {
  const config = getSandboxConfigSnapshot(manager);
  return [
    {
      label: 'backend',
      ok: config.vmBackend === 'local' || config.vmBackend === 'qemu',
      detail: `selected=${config.vmBackend}`,
    },
    {
      label: 'qemu image',
      ok: config.vmBackend === 'local' || Boolean(config.qemuImagePath),
      detail: config.qemuImagePath || 'missing sandbox.qemuImagePath',
    },
    {
      label: 'qemu wrapper',
      ok: config.vmBackend === 'local' || Boolean(config.qemuExecWrapper),
      detail: config.qemuExecWrapper || 'missing sandbox.qemuExecWrapper',
    },
    {
      label: 'guest host',
      ok: config.vmBackend === 'local' || Boolean(config.qemuGuestHost),
      detail: config.qemuGuestHost || 'missing sandbox.qemuGuestHost',
    },
    {
      label: 'guest user',
      ok: config.vmBackend === 'local' || Boolean(config.qemuGuestUser),
      detail: config.qemuGuestUser || 'missing sandbox.qemuGuestUser',
    },
    {
      label: 'guest workspace',
      ok: config.vmBackend === 'local' || Boolean(config.qemuWorkspacePath),
      detail: config.qemuWorkspacePath || 'missing sandbox.qemuWorkspacePath',
    },
    {
      label: 'wrapper file',
      ok: config.vmBackend === 'local' || !config.qemuExecWrapper || existsExecutable(config.qemuExecWrapper),
      detail: config.qemuExecWrapper ? `present=${existsExecutable(config.qemuExecWrapper)}` : 'not configured',
    },
  ];
}

export function renderSandboxDoctor(manager: ConfigManager): string {
  const checks = buildSandboxDoctorChecks(manager);
  const failing = checks.filter((check) => !check.ok);
  return [
    'Sandbox Doctor',
    ...checks.map((check) => `  ${check.ok ? 'ok ' : 'bad'}  ${check.label.padEnd(16)} ${check.detail}`),
    '',
    failing.length === 0
      ? '  next: run /sandbox guest-test <profile> or /sandbox session start <profile>'
      : '  next: fix the failing items, then run /sandbox doctor again',
  ].join('\n');
}

export function exportSandboxGuestBundle(
  manager: ConfigManager,
  pathArg: string,
): { path: string; bundle: SandboxGuestBundle } {
  const config = getSandboxConfigSnapshot(manager);
  const targetPath = resolve(process.cwd(), pathArg);
  const bundle: SandboxGuestBundle = {
    version: 1,
    exportedAt: Date.now(),
    guest: {
      qemuBinary: config.qemuBinary,
      imagePath: config.qemuImagePath,
      wrapperPath: config.qemuExecWrapper,
      host: config.qemuGuestHost,
      port: config.qemuGuestPort,
      user: config.qemuGuestUser,
      workspacePath: config.qemuWorkspacePath,
      sessionMode: config.qemuSessionMode,
    },
    nextSteps: [
      'Ensure the image boots with SSH enabled and a user matching qemuGuestUser.',
      'Forward guest port 22 to qemuGuestPort.',
      'Install the wrapper and set /sandbox set-qemu-wrapper <path>.',
      'Run /sandbox guest-test <profile> to validate transport and workspace projection.',
    ],
  };
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
  return { path: targetPath, bundle };
}

export function inspectSandboxGuestBundle(bundle: SandboxGuestBundle): string {
  return [
    'Sandbox Guest Bundle',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  qemu binary: ${bundle.guest.qemuBinary}`,
    `  image: ${bundle.guest.imagePath || '(unset)'}`,
    `  wrapper: ${bundle.guest.wrapperPath || '(unset)'}`,
    `  guest: ${bundle.guest.user || '(unset)'}@${bundle.guest.host || '(unset)'}:${bundle.guest.port}`,
    `  workspace: ${bundle.guest.workspacePath || '(unset)'}`,
    `  session mode: ${bundle.guest.sessionMode}`,
    ...bundle.nextSteps.map((step) => `  next: ${step}`),
  ].join('\n');
}

export function scaffoldSandboxQemuInitBundle(
  manager: ConfigManager,
  pathArg: string,
): SandboxQemuInitBundle {
  const targetDir = resolve(process.cwd(), pathArg);
  mkdirSync(targetDir, { recursive: true });
  const wrapperPath = join(targetDir, 'qemu-wrapper.sh');
  const guestBundlePath = join(targetDir, 'guest-bundle.json');
  const readmePath = join(targetDir, 'README.txt');
  writeFileSync(wrapperPath, renderQemuWrapperTemplate(), { encoding: 'utf-8', mode: 0o755 });
  exportSandboxGuestBundle(manager, guestBundlePath);
  const config = getSandboxConfigSnapshot(manager);
  const readme = [
    'GoodVibes QEMU Sandbox Init Bundle',
    '',
    'Files:',
    `  qemu-wrapper.sh     host-side wrapper used by /sandbox session run`,
    `  guest-bundle.json   current guest transport and workspace settings`,
    '',
    'Suggested setup:',
    `  1. Ensure ${config.qemuBinary || 'qemu-system-x86_64'} is installed and on PATH.`,
    '  2. Prepare a guest image with SSH enabled.',
    '  3. Forward guest port 22 to the configured host port.',
    `  4. Point GoodVibes at ${wrapperPath}`,
    `     /sandbox set-qemu-wrapper ${wrapperPath}`,
    `  5. Point GoodVibes at your image`,
    '     /sandbox set-qemu-image <path-to-image>',
    `  6. Verify transport`,
    '     /sandbox doctor',
    '     /sandbox guest-test eval-js',
  ].join('\n');
  writeFileSync(readmePath, `${readme}\n`, 'utf-8');
  return { directory: targetDir, wrapperPath, guestBundlePath, readmePath };
}

export function scaffoldSandboxQemuSetupBundle(
  manager: ConfigManager,
  pathArg: string,
): SandboxQemuSetupBundle {
  const base = scaffoldSandboxQemuInitBundle(manager, pathArg);
  const targetDir = base.directory;
  const config = getSandboxConfigSnapshot(manager);
  const imageDir = join(targetDir, 'images');
  const bootstrapDir = join(targetDir, 'guest');
  const policyDir = join(targetDir, 'policy');
  mkdirSync(imageDir, { recursive: true });
  mkdirSync(bootstrapDir, { recursive: true });
  mkdirSync(policyDir, { recursive: true });

  const imagePath = join(imageDir, 'goodvibes-sandbox.qcow2');
  const imageCreateScriptPath = join(targetDir, 'create-image.sh');
  const guestBootstrapScriptPath = join(bootstrapDir, 'bootstrap-guest.sh');
  const projectionPolicyPath = join(policyDir, 'workspace-projection.json');
  const sshConfigPath = join(targetDir, 'ssh_config');
  const manifestPath = join(targetDir, 'setup-manifest.json');

  const imageCreateScript = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'IMAGE_PATH="${1:-' + imagePath.replace(/"/g, '\\"') + '}"',
    'SIZE_GB="${2:-20}"',
    'QEMU_IMG_BIN="${QEMU_IMG_BIN:-qemu-img}"',
    '',
    'exec "$QEMU_IMG_BIN" create -f qcow2 "$IMAGE_PATH" "${SIZE_GB}G"',
  ].join('\n');
  writeFileSync(imageCreateScriptPath, `${imageCreateScript}\n`, { encoding: 'utf-8', mode: 0o755 });

  const guestBootstrap = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# GoodVibes guest bootstrap scaffold',
    '# Run this inside a Linux guest image after first boot.',
    '',
    'if command -v apt-get >/dev/null 2>&1; then',
    '  sudo apt-get update',
    '  sudo apt-get install -y openssh-server python3 tar',
    'fi',
    '',
    `sudo mkdir -p ${config.qemuWorkspacePath || '/workspace'}`,
    `id -u ${config.qemuGuestUser || 'goodvibes'} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${config.qemuGuestUser || 'goodvibes'}`,
    `sudo chown -R ${config.qemuGuestUser || 'goodvibes'}:${config.qemuGuestUser || 'goodvibes'} ${config.qemuWorkspacePath || '/workspace'}`,
    'sudo systemctl enable ssh || true',
    'sudo systemctl restart ssh || true',
  ].join('\n');
  writeFileSync(guestBootstrapScriptPath, `${guestBootstrap}\n`, { encoding: 'utf-8', mode: 0o755 });

  const projectionPolicy = {
    version: 1,
    workspaceRoot: process.cwd(),
    guestWorkspace: config.qemuWorkspacePath || '/workspace',
    excludes: ['.git', 'node_modules', '.venv', '.goodvibes/cache', '.env*', '*.pem', '*.key', '*credentials*', '*secret*'],
    notes: [
      'Review and tighten this projection policy before enabling untrusted MCP workloads.',
      'The wrapper syncs the filtered project root into the guest over tar+ssh.',
    ],
  };
  writeFileSync(projectionPolicyPath, `${JSON.stringify(projectionPolicy, null, 2)}\n`, 'utf-8');

  const sshConfig = [
    'Host goodvibes-sandbox',
    `  HostName ${config.qemuGuestHost || '127.0.0.1'}`,
    `  Port ${config.qemuGuestPort}`,
    `  User ${config.qemuGuestUser || 'goodvibes'}`,
    '  StrictHostKeyChecking accept-new',
    '  UserKnownHostsFile ~/.goodvibes/tui/known_hosts',
    '  LogLevel ERROR',
  ].join('\n');
  writeFileSync(sshConfigPath, `${sshConfig}\n`, 'utf-8');

  const manifest: SandboxQemuSetupManifest = {
    version: 1,
    createdAt: Date.now(),
    wrapperPath: base.wrapperPath,
    imagePath,
    imageCreateScriptPath,
    guestBootstrapScriptPath,
    projectionPolicyPath,
    sshConfigPath,
    recommendedSettings: {
      backend: 'qemu',
      wrapperPath: base.wrapperPath,
      imagePath,
      guestHost: config.qemuGuestHost || '127.0.0.1',
      guestPort: config.qemuGuestPort,
      guestUser: config.qemuGuestUser || 'goodvibes',
      guestWorkspacePath: config.qemuWorkspacePath || '/workspace',
      sessionMode: config.qemuSessionMode,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  const readme = [
    'GoodVibes QEMU Sandbox Setup Bundle',
    '',
    'This bundle is the productized first-run QEMU setup path.',
    '',
    'Files:',
    `  qemu-wrapper.sh            host-side wrapper used by GoodVibes`,
    `  create-image.sh            creates ${imagePath} with qemu-img`,
    `  guest/bootstrap-guest.sh   bootstrap script to run inside the guest`,
    `  policy/workspace-projection.json   default workspace projection policy`,
    `  ssh_config                 SSH host stanza for the guest`,
    `  guest-bundle.json          current runtime transport settings`,
    `  setup-manifest.json        paths and recommended GoodVibes settings`,
    '',
    'Suggested flow:',
    `  1. Create an image: ${imageCreateScriptPath} ${imagePath} 20`,
    `  2. Boot a Linux guest using ${imagePath}`,
    `  3. Run ${guestBootstrapScriptPath} inside the guest`,
    `  4. Configure port-forwarding so guest SSH reaches ${config.qemuGuestHost || '127.0.0.1'}:${config.qemuGuestPort}`,
    `  5. Point GoodVibes at the generated paths`,
    `     /sandbox set-backend qemu`,
    `     /sandbox set-qemu-wrapper ${base.wrapperPath}`,
    `     /sandbox set-qemu-image ${imagePath}`,
    `     /sandbox set-qemu-guest-host ${config.qemuGuestHost || '127.0.0.1'}`,
    `     /sandbox set-qemu-guest-port ${config.qemuGuestPort}`,
    `     /sandbox set-qemu-guest-user ${config.qemuGuestUser || 'goodvibes'}`,
    `     /sandbox set-qemu-workspace ${config.qemuWorkspacePath || '/workspace'}`,
    '  6. Validate with /sandbox doctor and /sandbox guest-test eval-js',
  ].join('\n');
  writeFileSync(base.readmePath, `${readme}\n`, 'utf-8');

  return {
    ...base,
    imagePath,
    imageCreateScriptPath,
    guestBootstrapScriptPath,
    projectionPolicyPath,
    sshConfigPath,
    manifestPath,
  };
}

export function createSandboxQemuImage(
  imagePathArg: string,
  sizeGb: number,
  qemuImgBinary = process.env.QEMU_IMG_BIN || 'qemu-img',
): { path: string; sizeGb: number } {
  const targetPath = resolve(process.cwd(), imagePathArg);
  mkdirSync(dirname(targetPath), { recursive: true });
  const result = spawnSync(qemuImgBinary, ['create', '-f', 'qcow2', targetPath, `${sizeGb}G`], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `Failed to run ${qemuImgBinary}`).trim();
    throw new Error(detail);
  }
  return { path: targetPath, sizeGb };
}

export function bootstrapSandboxQemuSetupBundle(
  manager: ConfigManager,
  pathArg: string,
  sizeGb: number,
): SandboxQemuSetupBundle {
  const bundle = scaffoldSandboxQemuSetupBundle(manager, pathArg);
  createSandboxQemuImage(bundle.imagePath, sizeGb);
  applySandboxQemuSetupManifest(manager, loadSandboxQemuSetupManifest(bundle.manifestPath));
  return bundle;
}

export function inspectSandboxQemuSetupManifest(manifest: SandboxQemuSetupManifest): string {
  return [
    'Sandbox QEMU Setup Manifest',
    `  createdAt: ${new Date(manifest.createdAt).toISOString()}`,
    `  wrapper: ${manifest.wrapperPath}`,
    `  image: ${manifest.imagePath}`,
    `  create-image script: ${manifest.imageCreateScriptPath}`,
    `  guest bootstrap: ${manifest.guestBootstrapScriptPath}`,
    `  projection policy: ${manifest.projectionPolicyPath}`,
    `  ssh config: ${manifest.sshConfigPath}`,
    '  recommended settings:',
    `    backend: ${manifest.recommendedSettings.backend}`,
    `    host: ${manifest.recommendedSettings.guestHost}`,
    `    port: ${manifest.recommendedSettings.guestPort}`,
    `    user: ${manifest.recommendedSettings.guestUser}`,
    `    workspace: ${manifest.recommendedSettings.guestWorkspacePath}`,
    `    session mode: ${manifest.recommendedSettings.sessionMode}`,
  ].join('\n');
}

export function loadSandboxQemuSetupManifest(pathArg: string): SandboxQemuSetupManifest {
  const targetPath = resolve(process.cwd(), pathArg);
  return JSON.parse(readFileSync(targetPath, 'utf-8')) as SandboxQemuSetupManifest;
}

export function applySandboxQemuSetupManifest(
  manager: ConfigManager,
  manifest: SandboxQemuSetupManifest,
): void {
  manager.setDynamic('sandbox.vmBackend', manifest.recommendedSettings.backend);
  manager.setDynamic('sandbox.qemuExecWrapper', manifest.recommendedSettings.wrapperPath);
  manager.setDynamic('sandbox.qemuImagePath', manifest.recommendedSettings.imagePath);
  manager.setDynamic('sandbox.qemuGuestHost', manifest.recommendedSettings.guestHost);
  manager.setDynamic('sandbox.qemuGuestPort', manifest.recommendedSettings.guestPort);
  manager.setDynamic('sandbox.qemuGuestUser', manifest.recommendedSettings.guestUser);
  manager.setDynamic('sandbox.qemuWorkspacePath', manifest.recommendedSettings.guestWorkspacePath);
  manager.setDynamic('sandbox.qemuSessionMode', manifest.recommendedSettings.sessionMode as 'attach' | 'launch-per-command');
}
