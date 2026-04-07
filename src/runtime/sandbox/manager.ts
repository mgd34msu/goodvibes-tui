import type { ConfigManager } from '../../config/manager.ts';
import type { ConfigKey } from '../../config/schema.ts';
import type {
  SandboxBackendProbe,
  SandboxConfigSnapshot,
  SandboxBundle,
  SandboxEvalIsolationMode,
  SandboxHostStatus,
  SandboxProbe,
  SandboxQemuSessionMode,
  SandboxMcpIsolationMode,
  SandboxPreset,
  SandboxProfile,
  SandboxReview,
  SandboxSession,
  SandboxSessionArtifact,
  SandboxVmBackend,
  SandboxWindowsMode,
} from './types.ts';
import { probeSandboxBackends } from './backend.ts';

function readConfigValue<K extends ConfigKey>(
  manager: ConfigManager | { get: (key: K) => unknown },
  key: K,
): unknown {
  return manager.get(key);
}

export function isRunningInWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function getSandboxConfigSnapshot(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): SandboxConfigSnapshot {
  return Object.freeze({
    replIsolation: readConfigValue(manager, 'sandbox.replIsolation') as SandboxEvalIsolationMode,
    mcpIsolation: readConfigValue(manager, 'sandbox.mcpIsolation') as SandboxMcpIsolationMode,
    windowsMode: readConfigValue(manager, 'sandbox.windowsMode') as SandboxWindowsMode,
    vmBackend: readConfigValue(manager, 'sandbox.vmBackend') as SandboxVmBackend,
    qemuBinary: readConfigValue(manager, 'sandbox.qemuBinary') as string,
    qemuImagePath: readConfigValue(manager, 'sandbox.qemuImagePath') as string,
    qemuExecWrapper: readConfigValue(manager, 'sandbox.qemuExecWrapper') as string,
    qemuGuestHost: readConfigValue(manager, 'sandbox.qemuGuestHost') as string,
    qemuGuestPort: readConfigValue(manager, 'sandbox.qemuGuestPort') as number,
    qemuGuestUser: readConfigValue(manager, 'sandbox.qemuGuestUser') as string,
    qemuWorkspacePath: readConfigValue(manager, 'sandbox.qemuWorkspacePath') as string,
    qemuSessionMode: readConfigValue(manager, 'sandbox.qemuSessionMode') as SandboxQemuSessionMode,
  });
}

export function detectSandboxHostStatus(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): SandboxHostStatus {
  const config = getSandboxConfigSnapshot(manager);
  const runningInWsl = isRunningInWsl();
  const windows = process.platform === 'win32';
  const secureSandboxReady = !windows || runningInWsl;
  const warnings: string[] = [];
  if (windows && !runningInWsl) {
    warnings.push('Virtualized sandboxing on Windows requires running GoodVibes inside WSL.');
  }
  if (config.vmBackend === 'qemu' && windows && !runningInWsl) {
    warnings.push('QEMU backend requested on native Windows without WSL.');
  }
  return Object.freeze({
    platform: process.platform,
    runningInWsl,
    windows,
    secureSandboxReady,
    recommendedBackend: 'qemu',
    warnings,
  });
}

export function listSandboxProfiles(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): SandboxProfile[] {
  const config = getSandboxConfigSnapshot(manager);
  const profiles: SandboxProfile[] = [
    {
      id: 'eval-js',
      label: 'JavaScript Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['bounded expression/runtime eval', 'records history and evidence'],
    },
    {
      id: 'eval-ts',
      label: 'TypeScript Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['shares eval sandbox substrate', 'planned typed transpile/eval path'],
    },
    {
      id: 'eval-py',
      label: 'Python Eval',
      kind: 'eval',
      isolation: 'dedicated',
      requiresVm: true,
      notes: ['ephemeral venv', '.pth scan before launch'],
    },
    {
      id: 'eval-sql',
      label: 'SQL Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['policy-scoped query execution', 'read-only by default'],
    },
    {
      id: 'eval-graphql',
      label: 'GraphQL Eval',
      kind: 'eval',
      isolation: config.replIsolation === 'shared-vm' ? 'shared' : 'dedicated',
      requiresVm: true,
      notes: ['schema-aware request validation', 'endpoint-scoped egress'],
    },
    {
      id: 'mcp-shared',
      label: 'Shared MCP Sandbox',
      kind: 'mcp',
      isolation: 'shared',
      requiresVm: config.mcpIsolation !== 'disabled',
      notes: ['lower overhead', 'weaker cross-server isolation'],
    },
    {
      id: 'mcp-per-server',
      label: 'Per-Server MCP Sandbox',
      kind: 'mcp',
      isolation: 'dedicated',
      requiresVm: config.mcpIsolation === 'per-server-vm' || config.mcpIsolation === 'hybrid',
      notes: ['strongest isolation', 'higher memory and startup cost'],
    },
  ];
  return profiles.map((profile) => Object.freeze(profile));
}

export function listSandboxPresets(): readonly SandboxPreset[] {
  return [
    Object.freeze({
      id: 'secure-balanced',
      label: 'Secure Balanced',
      summary: 'Dedicated REPL VMs with hybrid MCP isolation and WSL-gated Windows secure mode.',
      config: {
        replIsolation: 'per-runtime-vm',
        mcpIsolation: 'hybrid',
        windowsMode: 'require-wsl',
        vmBackend: 'qemu',
        qemuBinary: 'qemu-system-x86_64',
        qemuImagePath: '',
        qemuExecWrapper: '',
        qemuGuestHost: '',
        qemuGuestPort: 2222,
        qemuGuestUser: 'goodvibes',
        qemuWorkspacePath: '/workspace',
        qemuSessionMode: 'attach',
      },
      notes: ['recommended default', 'strong isolation without forcing per-server MCP for every case'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'secure-isolated',
      label: 'Secure Isolated',
      summary: 'Dedicated REPL VMs and per-server MCP VMs with the strongest local isolation posture.',
      config: {
        replIsolation: 'per-runtime-vm',
        mcpIsolation: 'per-server-vm',
        windowsMode: 'require-wsl',
        vmBackend: 'qemu',
        qemuBinary: 'qemu-system-x86_64',
        qemuImagePath: '',
        qemuExecWrapper: '',
        qemuGuestHost: '',
        qemuGuestPort: 2222,
        qemuGuestUser: 'goodvibes',
        qemuWorkspacePath: '/workspace',
        qemuSessionMode: 'attach',
      },
      notes: ['strongest isolation', 'higher startup and memory cost'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'shared-performance',
      label: 'Shared Performance',
      summary: 'Shared REPL VM and shared MCP VM for lower overhead while preserving a sandbox boundary.',
      config: {
        replIsolation: 'shared-vm',
        mcpIsolation: 'shared-vm',
        windowsMode: 'native-basic',
        vmBackend: 'qemu',
        qemuBinary: 'qemu-system-x86_64',
        qemuImagePath: '',
        qemuExecWrapper: '',
        qemuGuestHost: '',
        qemuGuestPort: 2222,
        qemuGuestUser: 'goodvibes',
        qemuWorkspacePath: '/workspace',
        qemuSessionMode: 'attach',
      },
      notes: ['best latency', 'weaker cross-runtime isolation than dedicated profiles'],
    } satisfies SandboxPreset),
    Object.freeze({
      id: 'windows-basic',
      label: 'Windows Basic',
      summary: 'Native Windows Bun/TUI with secure sandbox mode disabled until WSL is available.',
      config: {
        replIsolation: 'shared-vm',
        mcpIsolation: 'disabled',
        windowsMode: 'native-basic',
        vmBackend: 'local',
        qemuBinary: 'qemu-system-x86_64',
        qemuImagePath: '',
        qemuExecWrapper: '',
        qemuGuestHost: '',
        qemuGuestPort: 2222,
        qemuGuestUser: 'goodvibes',
        qemuWorkspacePath: '/workspace',
        qemuSessionMode: 'attach',
      },
      notes: ['intended for native Windows without WSL', 'core runtime only; not secure sandbox mode'],
    } satisfies SandboxPreset),
  ] as const;
}

export function getSandboxPreset(id: string): SandboxPreset | null {
  return listSandboxPresets().find((preset) => preset.id === id) ?? null;
}

export function buildSandboxReview(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): SandboxReview {
  return Object.freeze({
    config: getSandboxConfigSnapshot(manager),
    host: detectSandboxHostStatus(manager),
    profiles: listSandboxProfiles(manager),
    backendProbe: probeSandboxBackends(manager as ConfigManager),
  });
}

export function renderSandboxReview(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): string {
  const review = buildSandboxReview(manager);
  return [
    'Sandbox Review',
    `  repl isolation: ${review.config.replIsolation}`,
    `  mcp isolation: ${review.config.mcpIsolation}`,
    `  windows mode: ${review.config.windowsMode}`,
    `  vm backend: ${review.config.vmBackend}`,
    `  qemu binary: ${review.config.qemuBinary || '(default)'}`,
    `  qemu image: ${review.config.qemuImagePath || '(not configured)'}`,
    `  qemu wrapper: ${review.config.qemuExecWrapper || '(not configured)'}`,
    `  qemu guest host: ${review.config.qemuGuestHost || '(not configured)'}`,
    `  qemu guest port: ${review.config.qemuGuestPort}`,
    `  qemu guest user: ${review.config.qemuGuestUser || '(not configured)'}`,
    `  qemu workspace: ${review.config.qemuWorkspacePath || '(not configured)'}`,
    `  qemu session mode: ${review.config.qemuSessionMode}`,
    `  resolved backend: ${review.backendProbe?.resolvedBackend ?? 'local'}`,
    `  platform: ${review.host.platform}${review.host.runningInWsl ? ' (WSL)' : ''}`,
    `  secure sandbox mode: ${review.host.secureSandboxReady ? 'available' : 'unavailable on this host'}`,
    ...((review.backendProbe?.warnings ?? []).map((warning) => `  backend warning: ${warning}`)),
    ...review.host.warnings.map((warning) => `  warning: ${warning}`),
  ].join('\n');
}

export function renderSandboxRecommendation(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): string {
  const review = buildSandboxReview(manager);
  const lines = [
    'Sandbox Recommendation',
    `  current repl isolation: ${review.config.replIsolation}`,
    `  current mcp isolation: ${review.config.mcpIsolation}`,
  ];
  if (review.host.windows && !review.host.runningInWsl) {
    lines.push('  recommendation: run GoodVibes inside WSL before enabling QEMU sandboxing');
    lines.push('  recommendation: keep backend=local until WSL is available');
  } else {
    lines.push('  recommendation: keep REPLs in per-runtime-vm mode');
    lines.push('  recommendation: use hybrid or per-server-vm for MCP isolation');
  }
  return lines.join('\n');
}

export function renderSandboxProfiles(
  manager: ConfigManager | { get: (key: ConfigKey) => unknown },
): string {
  const profiles = listSandboxProfiles(manager);
  return [
    'Sandbox Profiles',
    ...profiles.map((profile) => (
      `  ${profile.id}  [${profile.kind}/${profile.isolation}]  vm=${profile.requiresVm ? 'yes' : 'no'}  ${profile.label}`
    )),
  ].join('\n');
}

export function renderSandboxPresets(): string {
  return [
    'Sandbox Presets',
    ...listSandboxPresets().map((preset) => (
      `  ${preset.id}  ${preset.label}  repl=${preset.config.replIsolation}  mcp=${preset.config.mcpIsolation}  windows=${preset.config.windowsMode}  backend=${preset.config.vmBackend}`
    )),
  ].join('\n');
}

export function inspectSandboxProbe(probe: SandboxProbe): string {
  return [
    'Sandbox Probe',
    `  checkedAt: ${new Date(probe.checkedAt).toISOString()}`,
    `  host: ${probe.host}`,
    `  backend: ${probe.currentBackend}`,
    `  repl isolation: ${probe.replIsolation}`,
    `  mcp isolation: ${probe.mcpIsolation}`,
    `  windows mode: ${probe.windowsMode}`,
    `  secure sandbox: ${probe.secureSandboxReady ? 'ready' : 'not ready'}`,
    `  next: ${probe.recommendedCommand}`,
  ].join('\n');
}

export function inspectSandboxBundle(bundle: SandboxBundle): string {
  return [
    'Sandbox Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  reviewText: ${bundle.review.reviewText.length} chars`,
    `  recommendationText: ${bundle.review.recommendationText.length} chars`,
    `  profilesText: ${bundle.review.profilesText.length} chars`,
  ].join('\n');
}

export function renderSandboxSessions(sessions: readonly SandboxSession[]): string {
  return [
    'Sandbox Sessions',
    ...(sessions.length > 0
      ? sessions.flatMap((session) => {
        const lines = [
          `  ${session.id}  ${session.profileId}  ${session.state}  ${session.shared ? 'shared' : 'dedicated'}  ${session.backend}  ${session.label}${session.startupStatus ? `  startup=${session.startupStatus}` : ''}`,
        ];
        if (session.managedGuestPid || session.managedGuestHost || session.managedGuestPort) {
          lines.push(
            `    guest: ${session.managedGuestHost ?? '(unset)'}:${session.managedGuestPort ?? 0}  pid=${session.managedGuestPid ?? 'n/a'}`,
          );
        }
        if (session.lastCommandSummary) {
          lines.push(`    last: ${session.lastCommandSummary}`);
        }
        return lines;
      })
      : ['  No active sandbox sessions.']),
  ].join('\n');
}

export function inspectSandboxSessionArtifact(artifact: SandboxSessionArtifact): string {
  return [
    'Sandbox Session Artifact',
    `  exportedAt: ${new Date(artifact.exportedAt).toISOString()}`,
    `  session: ${artifact.session.id}`,
    `  profile: ${artifact.session.profileId}`,
    `  state: ${artifact.session.state}`,
    `  backend: ${artifact.session.backend}`,
    `  startup: ${artifact.session.startupStatus ?? 'n/a'}`,
    `  reviewText: ${artifact.reviewText.length} chars`,
  ].join('\n');
}
