import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { requirePanelManager, requireShellPaths } from './runtime-services.ts';
import {
  getSandboxPreset,
  inspectSandboxBundle,
  inspectSandboxSessionArtifact,
  inspectSandboxProbe,
  listSandboxProfiles,
  renderSandboxPresets,
  renderSandboxProfiles,
  renderSandboxRecommendation,
  renderSandboxReview,
  renderSandboxSessions,
} from '@/runtime/index.ts';
import { renderQemuWrapperTemplate } from '@/runtime/index.ts';
import { buildSandboxLaunchPlan, executeSandboxManagedCommand, probeSandboxBackends } from '@/runtime/index.ts';
import type { SandboxBundle, SandboxProbe } from '@/runtime/index.ts';
import {
  exportSandboxGuestBundle,
  inspectSandboxGuestBundle,
  renderSandboxDoctor,
  scaffoldSandboxQemuInitBundle,
  type SandboxGuestBundle,
} from '@/runtime/index.ts';
import { handleSandboxQemuCommand } from './platform-sandbox-qemu.ts';
import { handleSandboxSessionCommand } from './platform-sandbox-session.ts';

const SANDBOX_PROFILE_IDS = [
  'eval-js',
  'eval-ts',
  'eval-py',
  'eval-sql',
  'eval-graphql',
  'mcp-shared',
  'mcp-per-server',
] as const;

function findSandboxProfile(configManager: Parameters<typeof listSandboxProfiles>[0], profileId: string) {
  return listSandboxProfiles(configManager).find((entry) => entry.id === profileId);
}

function applySandboxPreset(
  configManager: {
    setDynamic: (key: never, value: unknown) => void;
  },
  presetId: string,
): boolean {
  const preset = getSandboxPreset(presetId);
  if (!preset) return false;
  configManager.setDynamic('sandbox.replIsolation' as never, preset.config.replIsolation);
  configManager.setDynamic('sandbox.mcpIsolation' as never, preset.config.mcpIsolation);
  configManager.setDynamic('sandbox.windowsMode' as never, preset.config.windowsMode);
  configManager.setDynamic('sandbox.vmBackend' as never, preset.config.vmBackend);
  configManager.setDynamic('sandbox.qemuBinary' as never, preset.config.qemuBinary);
  configManager.setDynamic('sandbox.qemuImagePath' as never, preset.config.qemuImagePath);
  configManager.setDynamic('sandbox.qemuExecWrapper' as never, preset.config.qemuExecWrapper);
  configManager.setDynamic('sandbox.qemuGuestHost' as never, preset.config.qemuGuestHost);
  configManager.setDynamic('sandbox.qemuGuestPort' as never, preset.config.qemuGuestPort);
  configManager.setDynamic('sandbox.qemuGuestUser' as never, preset.config.qemuGuestUser);
  configManager.setDynamic('sandbox.qemuWorkspacePath' as never, preset.config.qemuWorkspacePath);
  configManager.setDynamic('sandbox.qemuSessionMode' as never, preset.config.qemuSessionMode);
  return true;
}

function renderSandboxPresetDetail(presetId: string): string | null {
  const preset = getSandboxPreset(presetId);
  if (!preset) return null;
  return [
    `Sandbox Preset ${preset.id}`,
    `  label: ${preset.label}`,
    `  summary: ${preset.summary}`,
    `  repl isolation: ${preset.config.replIsolation}`,
    `  mcp isolation: ${preset.config.mcpIsolation}`,
    `  windows mode: ${preset.config.windowsMode}`,
    `  vm backend: ${preset.config.vmBackend}`,
    `  qemu binary: ${preset.config.qemuBinary}`,
    `  qemu image: ${preset.config.qemuImagePath || '(not configured)'}`,
    `  qemu wrapper: ${preset.config.qemuExecWrapper || '(not configured)'}`,
    `  qemu guest host: ${preset.config.qemuGuestHost || '(not configured)'}`,
    `  qemu guest port: ${preset.config.qemuGuestPort}`,
    `  qemu guest user: ${preset.config.qemuGuestUser || '(not configured)'}`,
    `  qemu workspace: ${preset.config.qemuWorkspacePath || '(not configured)'}`,
    `  qemu session mode: ${preset.config.qemuSessionMode}`,
    ...preset.notes.map((note) => `  note: ${note}`),
  ].join('\n');
}

export function registerPlatformSandboxRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'sandbox',
    description: 'Review and configure VM isolation policy for MCP and evaluation runtimes',
    usage: '[open|review|recommend|profiles|presets|preset <id>|apply-preset <id>|probe|doctor|wrapper-test <profile>|guest-test <profile>|init-qemu <dir>|qemu <setup|bootstrap|create-image|recover|inspect-setup|apply-setup> ...|session ...|bundle ...|guest-bundle <export|inspect> <path>|scaffold-qemu-wrapper <path>|set-mcp <mode>|set-repl <mode>|set-windows <mode>|set-backend <mode>|set-qemu-binary <path>|set-qemu-image <path>|set-qemu-wrapper <path>|set-qemu-guest-host <host>|set-qemu-guest-port <port>|set-qemu-guest-user <user>|set-qemu-workspace <path>|set-qemu-session-mode <attach|launch-per-command>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        if (ctx.showPanel) ctx.showPanel('sandbox');
        else {
          const panelManager = requirePanelManager(ctx);
          panelManager.open('sandbox');
          panelManager.show();
        }
        return;
      }
      if (sub === 'review') {
        ctx.print(renderSandboxReview(ctx.platform.configManager));
        return;
      }
      if (sub === 'recommend') {
        ctx.print(renderSandboxRecommendation(ctx.platform.configManager));
        return;
      }
      if (sub === 'profiles') {
        ctx.print(renderSandboxProfiles(ctx.platform.configManager));
        return;
      }
      if (sub === 'presets') {
        ctx.print(renderSandboxPresets());
        return;
      }
      if (sub === 'preset') {
        const rendered = args[1] ? renderSandboxPresetDetail(args[1]) : null;
        ctx.print(rendered ?? 'Usage: /sandbox preset <secure-balanced|secure-isolated|shared-performance|windows-basic>');
        return;
      }
      if (sub === 'apply-preset') {
        const ok = args[1] ? applySandboxPreset(ctx.platform.configManager, args[1]) : false;
        ctx.print(ok ? `Applied sandbox preset ${args[1]}.` : 'Usage: /sandbox apply-preset <secure-balanced|secure-isolated|shared-performance|windows-basic>');
        return;
      }
      if (sub === 'probe') {
        const backendProbe = probeSandboxBackends(ctx.platform.configManager);
        const probe: SandboxProbe = {
          version: 1,
          checkedAt: Date.now(),
          host: process.platform,
          currentBackend: backendProbe.resolvedBackend,
          replIsolation: `${ctx.platform.configManager.get('sandbox.replIsolation')}`,
          mcpIsolation: `${ctx.platform.configManager.get('sandbox.mcpIsolation')}`,
          windowsMode: `${ctx.platform.configManager.get('sandbox.windowsMode')}`,
          secureSandboxReady: renderSandboxReview(ctx.platform.configManager).includes('available'),
          recommendedCommand: `${ctx.platform.configManager.get('sandbox.vmBackend')}` === 'local'
            ? '/sandbox qemu bootstrap .goodvibes/tui/sandbox 20'
            : '/sandbox doctor',
        };
        ctx.print([inspectSandboxProbe(probe), ...backendProbe.warnings.map((warning: string) => `  warning: ${warning}`)].join('\n'));
        return;
      }
      if (sub === 'doctor') {
        ctx.print(renderSandboxDoctor(ctx.platform.configManager));
        return;
      }
      if (sub === 'wrapper-test') {
        const profile = findSandboxProfile(ctx.platform.configManager, args[1] ?? 'eval-js');
        if (!profile) {
          ctx.print(`Usage: /sandbox wrapper-test <${SANDBOX_PROFILE_IDS.join('|')}>`);
          return;
        }
        const plan = buildSandboxLaunchPlan(profile, `${profile.label} wrapper test`, ctx.platform.configManager, shellPaths.workingDirectory);
        const result = executeSandboxManagedCommand(plan, 'bash', ['-lc', 'printf sandbox-ready'], ctx.platform.configManager, {
          timeoutMs: 3000,
          env: { GV_SANDBOX_WRAPPER_MODE: 'host-exec' },
        });
        ctx.print(result.status === 0 && result.stdout.includes('sandbox-ready')
          ? `Sandbox wrapper bridge test passed for ${profile.id}.`
          : [`Sandbox wrapper bridge test failed for ${profile.id}.`, result.stderr.trim() || result.stdout.trim() || '(no output)'].join('\n'));
        return;
      }
      if (sub === 'guest-test') {
        const profile = findSandboxProfile(ctx.platform.configManager, args[1] ?? 'eval-js');
        if (!profile) {
          ctx.print(`Usage: /sandbox guest-test <${SANDBOX_PROFILE_IDS.join('|')}>`);
          return;
        }
        const guestHost = `${ctx.platform.configManager.get('sandbox.qemuGuestHost') ?? ''}`.trim();
        if (!guestHost) {
          ctx.print('Sandbox guest test requires sandbox.qemuGuestHost. Configure /sandbox set-qemu-guest-host <host> first.');
          return;
        }
        const plan = buildSandboxLaunchPlan(profile, `${profile.label} guest test`, ctx.platform.configManager, shellPaths.workingDirectory);
        const markerName = `.goodvibes-sandbox-guest-test-${Date.now().toString(36)}.txt`;
        const markerPath = shellPaths.resolveWorkspacePath(markerName);
        writeFileSync(markerPath, `guest-test:${Date.now()}\n`, 'utf-8');
        try {
          const result = executeSandboxManagedCommand(plan, 'bash', ['-lc', `test -f ${JSON.stringify(`./${markerName}`)} && printf sandbox-guest-ready`], ctx.platform.configManager, { timeoutMs: 8000 });
          ctx.print(result.status === 0 && result.stdout.includes('sandbox-guest-ready')
            ? `Sandbox guest transport test passed for ${profile.id}.`
            : [`Sandbox guest transport test failed for ${profile.id}.`, result.stderr.trim() || result.stdout.trim() || '(no output)'].join('\n'));
        } finally {
          rmSync(markerPath, { force: true });
        }
        return;
      }
      if (sub === 'init-qemu') {
        const dirArg = args[1];
        if (!dirArg) {
          ctx.print('Usage: /sandbox init-qemu <directory>');
          return;
        }
        const bundle = scaffoldSandboxQemuInitBundle(ctx.platform.configManager, shellPaths.workingDirectory, dirArg, { surfaceRoot: 'tui' });
        ctx.print([
          `Initialized QEMU sandbox bundle in ${bundle.directory}`,
          `  wrapper: ${bundle.wrapperPath}`,
          `  guest bundle: ${bundle.guestBundlePath}`,
          `  readme: ${bundle.readmePath}`,
          '  next: /sandbox qemu setup <dir> for the full first-run setup path',
        ].join('\n'));
        return;
      }
      if (sub === 'qemu') {
        await handleSandboxQemuCommand(args, ctx);
        return;
      }
      if (sub === 'bundle') {
        const mode = args[1];
        const pathArg = args[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /sandbox bundle ${mode} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
        if (mode === 'export') {
          const bundle: SandboxBundle = {
            version: 1,
            exportedAt: Date.now(),
            review: {
              reviewText: renderSandboxReview(ctx.platform.configManager),
              recommendationText: renderSandboxRecommendation(ctx.platform.configManager),
              profilesText: renderSandboxProfiles(ctx.platform.configManager),
            },
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Sandbox bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SandboxBundle;
          ctx.print(inspectSandboxBundle(bundle));
          return;
        }
      }
      if (sub === 'guest-bundle') {
        const mode = args[1]?.toLowerCase();
        const pathArg = args[2];
        if (!mode || !pathArg) {
          ctx.print('Usage: /sandbox guest-bundle <export|inspect> <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        if (mode === 'export') {
          const exported = exportSandboxGuestBundle(ctx.platform.configManager, shellPaths.workingDirectory, targetPath, { surfaceRoot: 'tui' });
          ctx.print(`Sandbox guest bundle exported to ${exported.path}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as SandboxGuestBundle;
          ctx.print(inspectSandboxGuestBundle(bundle));
          return;
        }
        ctx.print('Usage: /sandbox guest-bundle <export|inspect> <path>');
        return;
      }
      if (sub === 'session') {
        await handleSandboxSessionCommand(args, ctx);
        return;
      }
      if (sub === 'set-mcp') {
        const mode = args[1];
        if (!mode || !['disabled', 'shared-vm', 'hybrid', 'per-server-vm'].includes(mode)) {
          ctx.print('Usage: /sandbox set-mcp <disabled|shared-vm|hybrid|per-server-vm>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.mcpIsolation', mode);
        ctx.print(`Sandbox MCP isolation set to ${mode}.`);
        return;
      }
      if (sub === 'set-repl') {
        const mode = args[1];
        if (!mode || !['shared-vm', 'per-runtime-vm'].includes(mode)) {
          ctx.print('Usage: /sandbox set-repl <shared-vm|per-runtime-vm>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.replIsolation', mode);
        ctx.print(`Sandbox REPL isolation set to ${mode}.`);
        return;
      }
      if (sub === 'set-windows') {
        const mode = args[1];
        if (!mode || !['native-basic', 'require-wsl'].includes(mode)) {
          ctx.print('Usage: /sandbox set-windows <native-basic|require-wsl>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.windowsMode', mode);
        ctx.print(`Sandbox Windows mode set to ${mode}.`);
        return;
      }
      if (sub === 'set-backend') {
        const mode = args[1];
        if (!mode || !['local', 'qemu'].includes(mode)) {
          ctx.print('Usage: /sandbox set-backend <local|qemu>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.vmBackend', mode as 'local' | 'qemu');
        ctx.print(`Sandbox VM backend set to ${mode}.`);
        return;
      }
      if (sub === 'set-qemu-binary') {
        const pathArg = args.slice(1).join(' ').trim();
        if (!pathArg) {
          ctx.print('Usage: /sandbox set-qemu-binary <path-or-command>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuBinary', pathArg);
        ctx.print(`Sandbox QEMU binary set to ${pathArg}.`);
        return;
      }
      if (sub === 'set-qemu-image') {
        const pathArg = args.slice(1).join(' ').trim();
        if (!pathArg) {
          ctx.print('Usage: /sandbox set-qemu-image <path>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuImagePath', pathArg);
        ctx.print(`Sandbox QEMU image set to ${pathArg}.`);
        return;
      }
      if (sub === 'set-qemu-wrapper') {
        const pathArg = args.slice(1).join(' ').trim();
        if (!pathArg) {
          ctx.print('Usage: /sandbox set-qemu-wrapper <path>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuExecWrapper', pathArg);
        ctx.print(`Sandbox QEMU wrapper set to ${pathArg}.`);
        return;
      }
      if (sub === 'set-qemu-guest-host') {
        const host = args.slice(1).join(' ').trim();
        if (!host) {
          ctx.print('Usage: /sandbox set-qemu-guest-host <host>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuGuestHost', host);
        ctx.print(`Sandbox QEMU guest host set to ${host}.`);
        return;
      }
      if (sub === 'set-qemu-guest-port') {
        const raw = args[1];
        const port = raw ? Number.parseInt(raw, 10) : Number.NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          ctx.print('Usage: /sandbox set-qemu-guest-port <1-65535>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuGuestPort', port);
        ctx.print(`Sandbox QEMU guest port set to ${port}.`);
        return;
      }
      if (sub === 'set-qemu-guest-user') {
        const user = args.slice(1).join(' ').trim();
        if (!user) {
          ctx.print('Usage: /sandbox set-qemu-guest-user <user>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuGuestUser', user);
        ctx.print(`Sandbox QEMU guest user set to ${user}.`);
        return;
      }
      if (sub === 'set-qemu-workspace') {
        const workspace = args.slice(1).join(' ').trim();
        if (!workspace) {
          ctx.print('Usage: /sandbox set-qemu-workspace <path>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuWorkspacePath', workspace);
        ctx.print(`Sandbox QEMU guest workspace set to ${workspace}.`);
        return;
      }
      if (sub === 'set-qemu-session-mode') {
        const mode = args[1];
        if (!mode || !['attach', 'launch-per-command'].includes(mode)) {
          ctx.print('Usage: /sandbox set-qemu-session-mode <attach|launch-per-command>');
          return;
        }
        ctx.platform.configManager.setDynamic('sandbox.qemuSessionMode', mode as 'attach' | 'launch-per-command');
        ctx.print(`Sandbox QEMU session mode set to ${mode}.`);
        return;
      }
      if (sub === 'scaffold-qemu-wrapper') {
        const pathArg = args.slice(1).join(' ').trim();
        if (!pathArg) {
          ctx.print('Usage: /sandbox scaffold-qemu-wrapper <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, renderQemuWrapperTemplate(), { encoding: 'utf-8', mode: 0o755 });
        ctx.print([`Scaffolded QEMU wrapper to ${targetPath}`, '  bridge test mode: GV_SANDBOX_WRAPPER_MODE=host-exec', '  next: /sandbox set-qemu-wrapper ' + targetPath].join('\n'));
        return;
      }
      ctx.print('Usage: /sandbox [open|review|recommend|profiles|presets|preset <id>|apply-preset <id>|probe|doctor|wrapper-test <profile>|guest-test <profile>|init-qemu <dir>|qemu <setup|bootstrap|create-image|recover|inspect-setup|apply-setup> ...|session ...|bundle export <path>|bundle inspect <path>|guest-bundle <export|inspect> <path>|scaffold-qemu-wrapper <path>|set-mcp <mode>|set-repl <mode>|set-windows <mode>|set-backend <mode>|set-qemu-binary <path>|set-qemu-image <path>|set-qemu-wrapper <path>|set-qemu-guest-host <host>|set-qemu-guest-port <port>|set-qemu-guest-user <user>|set-qemu-workspace <path>|set-qemu-session-mode <attach|launch-per-command>]');
    },
  });
}
