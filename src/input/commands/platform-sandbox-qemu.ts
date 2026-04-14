import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandContext } from '../command-registry.ts';
import {
  applySandboxQemuSetupManifest,
  bootstrapSandboxQemuSetupBundle,
  createSandboxQemuImage,
  inspectSandboxQemuSetupManifest,
  loadSandboxQemuSetupManifest,
  scaffoldSandboxQemuSetupBundle,
} from '../../runtime/sandbox/provisioning.ts';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '../../utils/error-display.ts';

export async function handleSandboxQemuCommand(args: string[], ctx: CommandContext): Promise<boolean> {
  const shellPaths = requireShellPaths(ctx);
  const sub = (args[1] ?? '').toLowerCase();
  const sessions = ctx.workspace.sandboxSessionRegistry;
  if (!sessions) {
    ctx.print('Sandbox session registry is not wired into this runtime.');
    return true;
  }
  if (sub === 'setup') {
    const dirArg = args[2];
    if (!dirArg) {
      ctx.print('Usage: /sandbox qemu setup <directory>');
      return true;
    }
    const bundle = scaffoldSandboxQemuSetupBundle(ctx.platform.configManager, shellPaths.workingDirectory, dirArg);
    ctx.platform.configManager.setDynamic('sandbox.vmBackend', 'qemu');
    ctx.platform.configManager.setDynamic('sandbox.qemuExecWrapper', bundle.wrapperPath);
    ctx.platform.configManager.setDynamic('sandbox.qemuImagePath', bundle.imagePath);
    if (!`${ctx.platform.configManager.get('sandbox.qemuGuestHost') ?? ''}`.trim()) {
      ctx.platform.configManager.setDynamic('sandbox.qemuGuestHost', '127.0.0.1');
    }
    if (!`${ctx.platform.configManager.get('sandbox.qemuGuestUser') ?? ''}`.trim()) {
      ctx.platform.configManager.setDynamic('sandbox.qemuGuestUser', 'goodvibes');
    }
    if (!`${ctx.platform.configManager.get('sandbox.qemuWorkspacePath') ?? ''}`.trim()) {
      ctx.platform.configManager.setDynamic('sandbox.qemuWorkspacePath', '/workspace');
    }
    ctx.print([
      `Initialized QEMU sandbox setup bundle in ${bundle.directory}`,
      `  wrapper: ${bundle.wrapperPath}`,
      `  image path: ${bundle.imagePath}`,
      `  image create script: ${bundle.imageCreateScriptPath}`,
      `  guest bootstrap: ${bundle.guestBootstrapScriptPath}`,
      `  projection policy: ${bundle.projectionPolicyPath}`,
      `  ssh config: ${bundle.sshConfigPath}`,
      `  manifest: ${bundle.manifestPath}`,
      '  applied: backend=qemu, wrapper path, image path, and default guest settings',
      `  next: /sandbox qemu create-image ${bundle.imagePath} 20`,
    ].join('\n'));
    return true;
  }
  if (sub === 'bootstrap') {
    const dirArg = args[2];
    const sizeGb = Number.parseInt(args[3] ?? '20', 10);
    if (!dirArg || !Number.isInteger(sizeGb) || sizeGb < 1) {
      ctx.print('Usage: /sandbox qemu bootstrap <directory> [size-gb]');
      return true;
    }
    try {
      const bundle = bootstrapSandboxQemuSetupBundle(ctx.platform.configManager, shellPaths.workingDirectory, dirArg, sizeGb);
      ctx.print([
        `Bootstrapped QEMU sandbox in ${bundle.directory}`,
        `  wrapper: ${bundle.wrapperPath}`,
        `  image path: ${bundle.imagePath}`,
        `  guest bootstrap: ${bundle.guestBootstrapScriptPath}`,
        `  projection policy: ${bundle.projectionPolicyPath}`,
        `  manifest: ${bundle.manifestPath}`,
        '  applied: backend=qemu, wrapper path, image path, and guest settings',
        '  next: boot the image, run the guest bootstrap script, then /sandbox guest-test eval-js',
      ].join('\n'));
    } catch (error) {
      ctx.print(summarizeError(error));
    }
    return true;
  }
  if (sub === 'create-image') {
    const imagePath = args[2];
    const sizeGb = Number.parseInt(args[3] ?? '20', 10);
    if (!imagePath || !Number.isInteger(sizeGb) || sizeGb < 1) {
      ctx.print('Usage: /sandbox qemu create-image <path> [size-gb]');
      return true;
    }
    try {
      const created = createSandboxQemuImage(shellPaths.workingDirectory, imagePath, sizeGb);
      ctx.platform.configManager.setDynamic('sandbox.qemuImagePath', created.path);
      ctx.platform.configManager.setDynamic('sandbox.vmBackend', 'qemu');
      ctx.print(`Created QEMU image ${created.path} (${created.sizeGb}G).`);
    } catch (error) {
      ctx.print(summarizeError(error));
    }
    return true;
  }
  if (sub === 'recover') {
    const sessionId = args[2];
    if (!sessionId) {
      ctx.print('Usage: /sandbox qemu recover <session-id>');
      return true;
    }
    const existing = sessions.get(sessionId);
    if (!existing) {
      ctx.print(`Unknown sandbox session: ${sessionId}`);
      return true;
    }
    sessions.stop(sessionId);
    const restarted = await sessions.start(existing.profileId, existing.label, ctx.platform.configManager);
    ctx.print(`Recovered sandbox session ${sessionId} -> ${restarted.id} (${restarted.state}, startup=${restarted.startupStatus ?? 'n/a'}).`);
    if (restarted.startupDetail) ctx.print(`  ${restarted.startupDetail}`);
    return true;
  }
  if (sub === 'inspect-setup') {
    const pathArg = args[2];
    if (!pathArg) {
      ctx.print('Usage: /sandbox qemu inspect-setup <setup-manifest.json>');
      return true;
    }
    const manifest = JSON.parse(readFileSync(shellPaths.resolveWorkspacePath(pathArg), 'utf-8'));
    ctx.print(inspectSandboxQemuSetupManifest(manifest));
    return true;
  }
  if (sub === 'apply-setup') {
    const pathArg = args[2];
    if (!pathArg) {
      ctx.print('Usage: /sandbox qemu apply-setup <setup-manifest.json>');
      return true;
    }
    const manifest = loadSandboxQemuSetupManifest(shellPaths.workingDirectory, pathArg);
    applySandboxQemuSetupManifest(ctx.platform.configManager, manifest);
    ctx.print(`Applied QEMU sandbox setup from ${shellPaths.resolveWorkspacePath(pathArg)}.`);
    return true;
  }
  ctx.print('Usage: /sandbox qemu <setup <directory>|bootstrap <directory> [size-gb]|create-image <path> [size-gb]|recover <session-id>|inspect-setup <setup-manifest.json>|apply-setup <setup-manifest.json>>');
  return true;
}
