import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn, type SpawnOptions } from 'node:child_process';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';

export type ManagedServicePlatform = 'systemd' | 'launchd' | 'windows' | 'manual';

export interface ManagedServiceDefinition {
  readonly name: string;
  readonly description: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly restartOnFailure: boolean;
}

export interface ManagedServiceStatus {
  readonly platform: ManagedServicePlatform;
  readonly path: string;
  readonly installed: boolean;
  readonly autostart: boolean;
  readonly running: boolean;
  readonly pid?: number;
  readonly logPath?: string;
  readonly commandPreview: string;
  readonly contents?: string;
  readonly suggestedCommands: readonly string[];
  readonly lastAction?: 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status';
  readonly actionError?: string;
}

export interface ManagedServiceActionResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface ManagedServicePaths {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface ManagedServiceManagerOptions extends ManagedServicePaths {
  readonly definitionOverride?: ManagedServiceDefinition;
  readonly actionRunner?: (command: string, args: readonly string[]) => ManagedServiceActionResult;
}

function detectPlatform(platform: string): ManagedServicePlatform {
  switch (platform) {
    case 'systemd':
    case 'launchd':
    case 'windows':
    case 'manual':
      return platform;
    case 'auto':
    default:
      if (process.platform === 'darwin') return 'launchd';
      if (process.platform === 'win32') return 'windows';
      if (process.platform === 'linux') return 'systemd';
      return 'manual';
  }
}

function buildDefaultDefinition(configManager: ConfigManager, workingDirectory: string): ManagedServiceDefinition {
  const compiledBinary = resolve(workingDirectory, 'dist', process.platform === 'win32' ? 'goodvibes-windows.exe' : 'goodvibes');
  const useCompiledBinary = existsSync(compiledBinary);
  const serviceName = String(configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
  return {
    name: serviceName,
    description: 'goodvibes omnichannel daemon host',
    workingDirectory,
    command: useCompiledBinary ? compiledBinary : process.execPath,
    args: useCompiledBinary ? [] : ['run', resolve(workingDirectory, 'src', 'daemon', 'cli.ts')],
    env: {
      GOODVIBES_DAEMON_TOKEN: process.env.GOODVIBES_DAEMON_TOKEN ?? '',
      GOODVIBES_HTTP_TOKEN: process.env.GOODVIBES_HTTP_TOKEN ?? '',
      NODE_ENV: process.env.NODE_ENV ?? 'production',
    },
    restartOnFailure: Boolean(configManager.get('service.restartOnFailure')),
  };
}

function resolveServiceName(configManager: ConfigManager): string {
  return String(configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
}

function resolveLogPath(configManager: ConfigManager, platform: ManagedServicePlatform, workingDirectory: string): string {
  const configured = String(configManager.get('service.logPath') ?? '').trim();
  if (configured) return resolve(workingDirectory, configured);
  return join(workingDirectory, '.goodvibes', 'tui', 'service', `${platform}.log`);
}

function renderSystemdUnit(definition: ManagedServiceDefinition): string {
  const envLines = Object.entries(definition.env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `Environment=${key}=${value.replace(/"/g, '\\"')}`);
  return [
    '[Unit]',
    `Description=${definition.description}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${definition.workingDirectory}`,
    `ExecStart=${[definition.command, ...definition.args].join(' ')}`,
    ...envLines,
    `Restart=${definition.restartOnFailure ? 'on-failure' : 'no'}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function renderLaunchdPlist(definition: ManagedServiceDefinition): string {
  const envLines = Object.entries(definition.env)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${value}</string>`)
    .join('\n');
  const args = [definition.command, ...definition.args]
    .map((value) => `    <string>${value}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${definition.name}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${definition.workingDirectory}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    definition.restartOnFailure ? '  <true/>' : '  <false/>',
    ...(envLines ? ['  <key>EnvironmentVariables</key>', '  <dict>', envLines, '  </dict>'] : []),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function renderWindowsCommand(definition: ManagedServiceDefinition): string {
  const taskName = definition.name;
  const commandLine = [definition.command, ...definition.args].join(' ');
  return `schtasks /Create /SC ONLOGON /TN "${taskName}" /TR "${commandLine}" /F`;
}

function definitionPath(platform: ManagedServicePlatform, serviceName: string, paths: ManagedServicePaths): string {
  switch (platform) {
    case 'systemd':
      return join(paths.homeDirectory, '.config', 'systemd', 'user', `${serviceName}.service`);
    case 'launchd':
      return join(paths.homeDirectory, 'Library', 'LaunchAgents', `${serviceName}.plist`);
    case 'windows':
      return join(paths.workingDirectory, '.goodvibes', 'tui', 'service', 'windows-task.txt');
    case 'manual':
    default:
      return join(paths.workingDirectory, '.goodvibes', 'tui', 'service', 'manual-service.txt');
  }
}

function pidFilePath(platform: ManagedServicePlatform, workingDirectory: string): string {
  switch (platform) {
    case 'systemd':
    case 'launchd':
    case 'windows':
    case 'manual':
    default:
      return join(workingDirectory, '.goodvibes', 'tui', 'service', `${platform}.pid`);
  }
}

function suggestedCommands(platform: ManagedServicePlatform, path: string, serviceName: string): string[] {
  switch (platform) {
    case 'systemd':
      return [
        `systemctl --user daemon-reload`,
        `systemctl --user enable --now ${serviceName}.service`,
        `systemctl --user status ${serviceName}.service`,
      ];
    case 'launchd':
      return [
        `launchctl unload ${path} || true`,
        `launchctl load ${path}`,
        `launchctl list | grep goodvibes`,
      ];
    case 'windows':
      return [
        `schtasks /Run /TN "${serviceName}"`,
        `schtasks /Query /TN "${serviceName}"`,
        `schtasks /Delete /TN "${serviceName}" /F`,
      ];
    case 'manual':
    default:
      return [
        `bun run src/daemon/cli.ts`,
      ];
  }
}

export class PlatformServiceManager {
  private readonly configManager: ConfigManager;
  private readonly workingDirectory: string;
  private readonly homeDirectory: string;
  private readonly definitionOverride?: ManagedServiceDefinition;
  private readonly actionRunner?: (command: string, args: readonly string[]) => ManagedServiceActionResult;

  constructor(configManager: ConfigManager, options: ManagedServiceManagerOptions) {
    this.configManager = configManager;
    this.workingDirectory = resolve(options.workingDirectory);
    this.homeDirectory = resolve(options.homeDirectory);
    this.definitionOverride = options.definitionOverride;
    this.actionRunner = options.actionRunner;
  }

  private getPaths(): ManagedServicePaths {
    return {
      workingDirectory: this.workingDirectory,
      homeDirectory: this.homeDirectory,
    };
  }

  status(): ManagedServiceStatus {
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager);
    const path = definitionPath(platform, serviceName, this.getPaths());
    const installed = existsSync(path);
    const pidPath = pidFilePath(platform, this.workingDirectory);
    const pid = existsSync(pidPath) ? this.readPid(pidPath) : undefined;
    const running = pid !== undefined ? this.isPidRunning(pid) : false;
    if (!running && existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    const definition = this.resolveDefinition();
    return {
      platform,
      path,
      installed,
      autostart: Boolean(this.configManager.get('service.autostart')),
      running,
      ...(pid !== undefined && running ? { pid } : {}),
      logPath: resolveLogPath(this.configManager, platform, this.workingDirectory),
      commandPreview: installed ? path : [definition.command, ...definition.args].join(' '),
      contents: installed ? readFileSync(path, 'utf-8') : undefined,
      suggestedCommands: suggestedCommands(platform, path, serviceName),
      lastAction: 'status',
    };
  }

  install(): ManagedServiceStatus {
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    const serviceName = resolveServiceName(this.configManager);
    const definition = this.resolveDefinition();
    const path = definitionPath(platform, serviceName, this.getPaths());
    const contents = platform === 'systemd'
      ? renderSystemdUnit(definition)
      : platform === 'launchd'
        ? renderLaunchdPlist(definition)
        : platform === 'windows'
          ? renderWindowsCommand(definition)
          : [definition.command, ...definition.args].join(' ');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${contents}\n`, 'utf-8');
    return {
      ...this.status(),
      lastAction: 'install',
    };
  }

  uninstall(): ManagedServiceStatus {
    const status = this.status();
    if (existsSync(status.path)) {
      rmSync(status.path, { force: true });
    }
    const pidPath = pidFilePath(status.platform, this.workingDirectory);
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    return {
      ...this.status(),
      lastAction: 'uninstall',
    };
  }

  start(): ManagedServiceStatus {
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      return this.startManual(platform);
    }
    return this.runPlatformAction(platform, 'start');
  }

  stop(): ManagedServiceStatus {
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      return this.stopManual(platform);
    }
    return this.runPlatformAction(platform, 'stop');
  }

  restart(): ManagedServiceStatus {
    const platform = detectPlatform(String(this.configManager.get('service.platform')));
    if (platform === 'manual') {
      this.stopManual(platform);
      return this.startManual(platform, 'restart');
    }
    return this.runPlatformAction(platform, 'restart');
  }

  private resolveDefinition(): ManagedServiceDefinition {
    return this.definitionOverride ?? buildDefaultDefinition(this.configManager, this.workingDirectory);
  }

  private startManual(platform: ManagedServicePlatform, action: ManagedServiceStatus['lastAction'] = 'start'): ManagedServiceStatus {
    const current = this.status();
    if (current.running) {
      return {
        ...current,
        lastAction: action,
      };
    }
    const definition = this.resolveDefinition();
    const logPath = resolveLogPath(this.configManager, platform, this.workingDirectory);
    const pidPath = pidFilePath(platform, this.workingDirectory);
    mkdirSync(dirname(pidPath), { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true });
    const stdoutFd = openSync(logPath, 'a');
    const stderrFd = openSync(logPath, 'a');
    const spawnOptions: SpawnOptions = {
      cwd: definition.workingDirectory,
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: {
        ...process.env,
        ...definition.env,
      },
    };
    const child = spawn(definition.command, [...definition.args], spawnOptions);
    child.unref();
    writeFileSync(pidPath, `${child.pid}\n`, 'utf-8');
    return {
      ...this.status(),
      lastAction: action,
    };
  }

  private stopManual(platform: ManagedServicePlatform): ManagedServiceStatus {
    const pidPath = pidFilePath(platform, this.workingDirectory);
    const pid = existsSync(pidPath) ? this.readPid(pidPath) : undefined;
    if (pid !== undefined && this.isPidRunning(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore stale processes
      }
    }
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
    return {
      ...this.status(),
      lastAction: 'stop',
    };
  }

  private runPlatformAction(platform: ManagedServicePlatform, action: 'start' | 'stop' | 'restart'): ManagedServiceStatus {
    const serviceName = resolveServiceName(this.configManager);
    const path = definitionPath(platform, serviceName, this.getPaths());
    const command = platform === 'systemd'
      ? ['systemctl', '--user', action === 'start' ? 'enable' : action, ...(action === 'start' ? ['--now'] : []), `${serviceName}.service`]
      : platform === 'launchd'
        ? ['launchctl', action === 'stop' ? 'unload' : 'load', path]
        : platform === 'windows'
          ? ['schtasks', action === 'start' ? '/Run' : action === 'stop' ? '/End' : '/Run', '/TN', serviceName]
          : [];
    if (command.length === 0) {
      return {
        ...this.status(),
        lastAction: action,
        actionError: `Unsupported platform action: ${platform}`,
      };
    }
    const result = this.actionRunner
      ? this.actionRunner(command[0]!, command.slice(1))
      : spawnSync(command[0]!, command.slice(1), { stdio: 'pipe', encoding: 'utf-8' });
    return {
      ...this.status(),
      lastAction: action,
      ...((result.status ?? 1) === 0 ? {} : { actionError: ((result.stderr ?? '') || (result.stdout ?? '') || `command exited with ${result.status}`).trim() }),
    };
  }

  private readPid(path: string): number | undefined {
    const raw = readFileSync(path, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  private isPidRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
