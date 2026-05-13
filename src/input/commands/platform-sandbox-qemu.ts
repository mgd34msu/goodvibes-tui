import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { CommandContext } from '../command-registry.ts';
import {
  applySandboxQemuSetupManifest,
  bootstrapSandboxQemuSetupBundle,
  inspectSandboxQemuSetupManifest,
  loadSandboxQemuSetupManifest,
  scaffoldSandboxQemuSetupBundle,
} from '@/runtime/index.ts';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const DEFAULT_QEMU_SIZE_GB = 20;

interface ParsedQemuSetupArgs {
  readonly directory: string;
}

interface ParsedQemuBootstrapArgs extends ParsedQemuSetupArgs {
  readonly sizeGb: number;
  readonly buildImage: boolean;
  readonly provisionGuest: boolean;
}

function defaultQemuSandboxDirectory(shellPaths: ReturnType<typeof requireShellPaths>): string {
  return shellPaths.resolveUserPath('tui', 'sandbox');
}

function parseSetupArgs(args: string[], shellPaths: ReturnType<typeof requireShellPaths>): ParsedQemuSetupArgs {
  const directory = args[2] ?? defaultQemuSandboxDirectory(shellPaths);
  return {
    directory,
  };
}

function parseBootstrapArgs(args: string[], shellPaths: ReturnType<typeof requireShellPaths>): ParsedQemuBootstrapArgs {
  let directory = defaultQemuSandboxDirectory(shellPaths);
  let sizeGb = DEFAULT_QEMU_SIZE_GB;
  let buildImage = true;
  let provisionGuest = true;
  for (const arg of args.slice(2)) {
    if (arg === '--scaffold-only') {
      buildImage = false;
      provisionGuest = false;
      continue;
    }
    if (arg === '--no-build') {
      buildImage = false;
      continue;
    }
    if (arg === '--no-provision') {
      provisionGuest = false;
      continue;
    }
    if (/^\d+$/.test(arg)) {
      sizeGb = Number.parseInt(arg, 10);
      continue;
    }
    directory = arg;
  }
  return {
    directory,
    sizeGb,
    buildImage,
    provisionGuest,
  };
}

function tailText(value: string, maxLines = 40): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function runQemuBootstrapStep(
  label: string,
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly timeoutMs: number;
  },
): void {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
    timeout: options.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status === 0) return;
  const stderr = tailText(result.stderr || '');
  const stdout = tailText(result.stdout || '');
  const reason = result.error instanceof Error ? result.error.message : `exit ${result.status ?? 'unknown'}`;
  throw new Error([
    `${label} failed (${reason}).`,
    stderr ? `stderr:\n${stderr}` : '',
    stdout ? `stdout:\n${stdout}` : '',
  ].filter(Boolean).join('\n'));
}

export async function handleSandboxQemuCommand(args: string[], ctx: CommandContext): Promise<boolean> {
  const shellPaths = requireShellPaths(ctx);
  const sub = (args[1] ?? '').toLowerCase();
  const sessions = ctx.workspace.sandboxSessionRegistry;
  if (!sessions) {
    ctx.print('Sandbox session registry is not wired into this runtime.');
    return true;
  }
  if (sub === 'setup') {
    const parsed = parseSetupArgs(args, shellPaths);
    const bundle = scaffoldSandboxQemuSetupBundle(ctx.platform.configManager, shellPaths.workingDirectory, parsed.directory, { surfaceRoot: 'tui' });
    const manifest = loadSandboxQemuSetupManifest(shellPaths.workingDirectory, bundle.manifestPath);
    applySandboxQemuSetupManifest(ctx.platform.configManager, manifest);
    ctx.platform.configManager.setDynamic('sandbox.replIsolation', 'shared-vm');
    ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', 'shared-vm');
    ctx.print([
      `Initialized QEMU sandbox setup bundle in ${bundle.directory}`,
      `  wrapper: ${bundle.wrapperPath}`,
      `  image path: ${bundle.imagePath}`,
      `  image create script: ${bundle.imageCreateScriptPath}`,
      `  guest bootstrap: ${bundle.guestBootstrapScriptPath}`,
      `  seed directory: ${bundle.seedDirectory}`,
      `  seed ISO: ${bundle.seedIsoPath}`,
      `  ssh key: ${bundle.sshKeyPath}`,
      `  projection policy: ${bundle.projectionPolicyPath}`,
      `  ssh config: ${bundle.sshConfigPath}`,
      `  manifest: ${bundle.manifestPath}`,
      '  applied: backend=qemu, qemu binary, wrapper path, image path, launch-per-command guest settings, shared VM isolation',
      `  next: ${bundle.imageCreateScriptPath} ${bundle.imagePath} 20G`,
      `  then provision runtimes: GV_SANDBOX_SYNC_WORKSPACE=0 GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh ${bundle.wrapperPath} bash -s < ${bundle.guestBootstrapScriptPath}`,
      '',
      `Default setup location: ${defaultQemuSandboxDirectory(shellPaths)}`,
      'Pass an explicit directory only when you intentionally want a non-default bundle location.',
    ].join('\n'));
    return true;
  }
  if (sub === 'bootstrap') {
    const parsed = parseBootstrapArgs(args, shellPaths);
    if (!Number.isInteger(parsed.sizeGb) || parsed.sizeGb < 1) {
      ctx.print('Usage: /sandbox qemu bootstrap [directory] [size-gb] [--scaffold-only|--no-build|--no-provision]');
      return true;
    }
    try {
      const bundle = bootstrapSandboxQemuSetupBundle(ctx.platform.configManager, shellPaths.workingDirectory, parsed.directory, parsed.sizeGb, { surfaceRoot: 'tui' });
      const lines = [
        `Bootstrapped QEMU sandbox in ${bundle.directory}`,
        `  wrapper: ${bundle.wrapperPath}`,
        `  image path: ${bundle.imagePath}`,
        `  guest bootstrap: ${bundle.guestBootstrapScriptPath}`,
        `  seed ISO: ${bundle.seedIsoPath}`,
        `  ssh key: ${bundle.sshKeyPath}`,
        `  projection policy: ${bundle.projectionPolicyPath}`,
        `  manifest: ${bundle.manifestPath}`,
        '  applied: backend=qemu, qemu binary, wrapper path, image path, launch-per-command guest settings, shared VM isolation',
      ];
      if (parsed.buildImage) {
        ctx.print(`Building QEMU image at ${bundle.imagePath} (${parsed.sizeGb}G). This can download the Debian cloud image on first run.`);
        runQemuBootstrapStep('QEMU image build', bundle.imageCreateScriptPath, [bundle.imagePath, `${parsed.sizeGb}G`], {
          cwd: bundle.directory,
          timeoutMs: 30 * 60 * 1000,
        });
        lines.push('  image build: complete');
      } else {
        lines.push(`  image build: skipped`);
        lines.push(`  next: ${bundle.imageCreateScriptPath} ${bundle.imagePath} ${parsed.sizeGb}G`);
      }
      if (parsed.provisionGuest) {
        if (!existsSync(bundle.imagePath)) {
          lines.push('  guest provisioning: skipped because image does not exist');
          lines.push(`  next: ${bundle.imageCreateScriptPath} ${bundle.imagePath} ${parsed.sizeGb}G`);
        } else {
          ctx.print(`Provisioning guest runtimes through ${bundle.wrapperPath}. First boot can take several minutes.`);
          runQemuBootstrapStep('QEMU guest runtime provisioning', bundle.wrapperPath, ['bash', '-s'], {
            cwd: bundle.directory,
            env: {
              GV_SANDBOX_SYNC_WORKSPACE: '0',
              GV_SANDBOX_WRAPPER_MODE: 'launch-qemu-ssh',
            },
            input: readFileSync(bundle.guestBootstrapScriptPath, 'utf8'),
            timeoutMs: 45 * 60 * 1000,
          });
          lines.push('  guest provisioning: complete');
        }
      } else {
        lines.push(`  guest provisioning: skipped`);
        lines.push(`  next: GV_SANDBOX_SYNC_WORKSPACE=0 GV_SANDBOX_WRAPPER_MODE=launch-qemu-ssh ${bundle.wrapperPath} bash -s < ${bundle.guestBootstrapScriptPath}`);
      }
      lines.push('  verify: /sandbox doctor');
      lines.push('  verify: /sandbox guest-test eval-py');
      lines.push('');
      lines.push(`Default setup location: ${defaultQemuSandboxDirectory(shellPaths)}`);
      lines.push('Pass an explicit directory only when you intentionally want a non-default bundle location.');
      ctx.print(lines.join('\n'));
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
  ctx.print('Usage: /sandbox qemu <setup [directory]|bootstrap [directory] [size-gb] [--scaffold-only|--no-build|--no-provision]|recover <session-id>|inspect-setup <setup-manifest.json>|apply-setup <setup-manifest.json>>');
  return true;
}
