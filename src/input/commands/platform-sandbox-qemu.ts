import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandContext } from '../command-registry.ts';
import { getSandboxSessionRegistry } from '../../runtime/sandbox/session-registry.ts';
import {
  applySandboxQemuSetupManifest,
  bootstrapSandboxQemuSetupBundle,
  createSandboxQemuImage,
  inspectSandboxQemuSetupManifest,
  loadSandboxQemuSetupManifest,
  scaffoldSandboxQemuSetupBundle,
} from '../../runtime/sandbox/provisioning.ts';

export async function handleSandboxQemuCommand(args: string[], ctx: CommandContext): Promise<boolean> {
  const sub = (args[1] ?? '').toLowerCase();
  const sessions = getSandboxSessionRegistry();
  if (sub === 'setup') {
    const dirArg = args[2];
    if (!dirArg) {
      ctx.print('Usage: /sandbox qemu setup <directory>');
      return true;
    }
    const bundle = scaffoldSandboxQemuSetupBundle(ctx.configManager, dirArg);
    ctx.configManager.setDynamic('sandbox.vmBackend', 'qemu');
    ctx.configManager.setDynamic('sandbox.qemuExecWrapper', bundle.wrapperPath);
    ctx.configManager.setDynamic('sandbox.qemuImagePath', bundle.imagePath);
    if (!`${ctx.configManager.get('sandbox.qemuGuestHost') ?? ''}`.trim()) {
      ctx.configManager.setDynamic('sandbox.qemuGuestHost', '127.0.0.1');
    }
    if (!`${ctx.configManager.get('sandbox.qemuGuestUser') ?? ''}`.trim()) {
      ctx.configManager.setDynamic('sandbox.qemuGuestUser', 'goodvibes');
    }
    if (!`${ctx.configManager.get('sandbox.qemuWorkspacePath') ?? ''}`.trim()) {
      ctx.configManager.setDynamic('sandbox.qemuWorkspacePath', '/workspace');
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
      const bundle = bootstrapSandboxQemuSetupBundle(ctx.configManager, dirArg, sizeGb);
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
      ctx.print(error instanceof Error ? error.message : String(error));
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
      const created = createSandboxQemuImage(imagePath, sizeGb);
      ctx.configManager.setDynamic('sandbox.qemuImagePath', created.path);
      ctx.configManager.setDynamic('sandbox.vmBackend', 'qemu');
      ctx.print(`Created QEMU image ${created.path} (${created.sizeGb}G).`);
    } catch (error) {
      ctx.print(error instanceof Error ? error.message : String(error));
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
    const restarted = await sessions.start(existing.profileId, existing.label, ctx.configManager);
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
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), pathArg), 'utf-8'));
    ctx.print(inspectSandboxQemuSetupManifest(manifest));
    return true;
  }
  if (sub === 'apply-setup') {
    const pathArg = args[2];
    if (!pathArg) {
      ctx.print('Usage: /sandbox qemu apply-setup <setup-manifest.json>');
      return true;
    }
    const manifest = loadSandboxQemuSetupManifest(pathArg);
    applySandboxQemuSetupManifest(ctx.configManager, manifest);
    ctx.print(`Applied QEMU sandbox setup from ${resolve(process.cwd(), pathArg)}.`);
    return true;
  }
  ctx.print('Usage: /sandbox qemu <setup <directory>|bootstrap <directory> [size-gb]|create-image <path> [size-gb]|recover <session-id>|inspect-setup <setup-manifest.json>|apply-setup <setup-manifest.json>>');
  return true;
}
