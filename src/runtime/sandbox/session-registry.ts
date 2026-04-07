import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import net from 'node:net';
import type { ConfigManager } from '../../config/manager.ts';
import { buildSandboxLaunchPlan, executeSandboxCommand, executeSandboxManagedCommand, resolveSandboxCommandPlan } from './backend.ts';
import { getSandboxConfigSnapshot, listSandboxProfiles, renderSandboxReview } from './manager.ts';
import type {
  SandboxProfile,
  SandboxSession,
  SandboxSessionArtifact,
  SandboxSessionKind,
} from './types.ts';
import type { SandboxCommandResult } from './backend.ts';

function createSandboxSessionId(): string {
  return `sandbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function inferShared(profile: SandboxProfile): boolean {
  return profile.isolation === 'shared';
}

function inferKind(profile: SandboxProfile): SandboxSessionKind {
  return profile.kind;
}

function readManagerString(manager: ConfigManager, key: string): string {
  return `${manager.get(key as never) ?? ''}`.trim();
}

function readManagerPort(manager: ConfigManager, key: string, fallback: number): number {
  const raw = manager.get(key as never);
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(`${raw ?? ''}`, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function waitForTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 250);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function launchManagedQemuGuest(
  launchPlan: SandboxSession['launchPlan'],
  configManager: ConfigManager,
): Promise<{ pid: number; host: string; port: number } | null> {
  if (!launchPlan || launchPlan.backend !== 'qemu') return null;
  const host = readManagerString(configManager, 'sandbox.qemuGuestHost');
  const sessionMode = readManagerString(configManager, 'sandbox.qemuSessionMode');
  if (!host || sessionMode !== 'attach') return null;
  const port = readManagerPort(configManager, 'sandbox.qemuGuestPort', 2222);
  const proc = spawn(launchPlan.command, [...launchPlan.args], {
    cwd: launchPlan.workspaceRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  proc.unref();
  if (!proc.pid) {
    return null;
  }
  const ready = await waitForTcp(host, port, 15000);
  if (!ready) {
    try {
      process.kill(proc.pid, 'SIGTERM');
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`Timed out waiting for QEMU guest SSH on ${host}:${port}.`);
  }
  return { pid: proc.pid, host, port };
}

export class SandboxSessionRegistry {
  private readonly sessions = new Map<string, SandboxSession>();

  private updateSession(sessionId: string, updater: (session: SandboxSession) => SandboxSession): SandboxSession {
    const existing = this.sessions.get(sessionId);
    if (!existing) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    const next = Object.freeze(updater(existing));
    this.sessions.set(sessionId, next);
    return next;
  }

  public list(): SandboxSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  public async start(profileId: SandboxProfile['id'], label: string | undefined, configManager: ConfigManager): Promise<SandboxSession> {
    const profile = listSandboxProfiles(configManager).find((entry) => entry.id === profileId);
    if (!profile) {
      throw new Error(`Unknown sandbox profile: ${profileId}`);
    }
    if (inferShared(profile)) {
      const existing = [...this.sessions.values()].find((session) => session.profileId === profileId && session.state === 'running');
      if (existing) return existing;
    }
    const config = getSandboxConfigSnapshot(configManager);
    const launchPlan = buildSandboxLaunchPlan(profile, label?.trim() || profile.label, configManager);
    let state: SandboxSession['state'] = 'running';
    let startupStatus: SandboxSession['startupStatus'] = 'verified';
    let startupDetail = launchPlan.summary;
    let managedGuestPid: number | undefined;
    let managedGuestHost: string | undefined;
    let managedGuestPort: number | undefined;
    if (launchPlan.backend === 'qemu') {
      if (launchPlan.imagePath && config.qemuExecWrapper) {
        try {
          const managedGuest = await launchManagedQemuGuest(launchPlan, configManager);
          managedGuestPid = managedGuest?.pid;
          managedGuestHost = managedGuest?.host;
          managedGuestPort = managedGuest?.port;
          const startupProbe = executeSandboxManagedCommand(launchPlan, 'bash', ['-lc', 'printf sandbox-ready'], configManager, {
            timeoutMs: 4000,
          });
          if (startupProbe.status !== 0 || !startupProbe.stdout.includes('sandbox-ready')) {
            state = 'failed';
            startupStatus = 'failed';
            startupDetail = (startupProbe.stderr || startupProbe.stdout || 'QEMU sandbox wrapper startup probe failed.').trim();
          } else {
            state = 'running';
            startupStatus = 'verified';
            startupDetail = managedGuestPid
              ? `QEMU guest launched and verified via ${config.qemuExecWrapper} on ${managedGuestHost}:${managedGuestPort} using image ${launchPlan.imagePath}.`
              : `QEMU backend verified via ${config.qemuExecWrapper} using image ${launchPlan.imagePath}.`;
          }
        } catch (error) {
          state = 'failed';
          startupStatus = 'failed';
          startupDetail = error instanceof Error ? error.message : String(error);
        }
      } else {
        state = 'planned';
        startupStatus = 'planned';
        startupDetail = launchPlan.imagePath
          ? `QEMU backend resolved with image ${launchPlan.imagePath}. Guest launch planning is wired, but command execution still requires sandbox.qemuExecWrapper.`
          : 'QEMU backend resolved. Guest launch planning is available, but full guest execution still requires sandbox.qemuImagePath and sandbox.qemuExecWrapper.';
      }
    } else {
      const startupProbe = executeSandboxCommand(launchPlan, 'bash', ['-lc', 'printf sandbox-ready'], {
        timeoutMs: 2000,
      });
      if (startupProbe.status !== 0 || !startupProbe.stdout.includes('sandbox-ready')) {
        state = 'failed';
        startupStatus = 'failed';
        startupDetail = (startupProbe.stderr || startupProbe.stdout || 'Sandbox backend startup probe failed.').trim();
      }
    }
    const session: SandboxSession = Object.freeze({
      id: createSandboxSessionId(),
      profileId: profile.id,
      kind: inferKind(profile),
      label: label?.trim() || profile.label,
      shared: inferShared(profile),
      startedAt: Date.now(),
      state,
      backend: config.vmBackend,
      resolvedBackend: launchPlan.backend,
      launchPlan,
      startupStatus,
      startupDetail,
      managedGuestPid,
      managedGuestHost,
      managedGuestPort,
      notes: profile.notes,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  public stop(sessionId: string): SandboxSession | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;
    if (existing.managedGuestPid) {
      try {
        process.kill(existing.managedGuestPid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    return this.updateSession(sessionId, (session) => ({
      ...session,
      state: 'stopped',
    }));
  }

  public get(sessionId: string): SandboxSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public execute(
    sessionId: string,
    command: string,
    args: readonly string[],
    configManager: ConfigManager,
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeoutMs?: number;
      readonly input?: string;
    } = {},
  ): SandboxCommandResult {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    if (!session.launchPlan) {
      throw new Error(`Sandbox session ${sessionId} does not have a launch plan.`);
    }

    const resolvedPlan = resolveSandboxCommandPlan(session.launchPlan, command, args, configManager);
    const result = session.launchPlan.backend === 'qemu'
      ? executeSandboxManagedCommand(session.launchPlan, command, args, configManager, options)
      : executeSandboxCommand(session.launchPlan, command, args, options);
    const stdoutPreview = (result.stdout || '').trim().slice(0, 200);
    const stderrPreview = (result.stderr || '').trim().slice(0, 200);
    const nextState: SandboxSession['state'] = result.status === 0
      ? (session.state === 'stopped' ? 'stopped' : 'running')
      : 'failed';

    this.updateSession(sessionId, (current) => ({
      ...current,
      state: nextState,
      lastRunAt: Date.now(),
      lastCommandSummary: resolvedPlan.summary,
      lastExitStatus: result.status,
      lastStdoutPreview: stdoutPreview || undefined,
      lastStderrPreview: stderrPreview || undefined,
      executionCount: (current.executionCount ?? 0) + 1,
    }));

    return result;
  }

  public exportArtifact(sessionId: string, targetPath: string, configManager: ConfigManager): SandboxSessionArtifact {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown sandbox session: ${sessionId}`);
    }
    const artifact: SandboxSessionArtifact = {
      version: 1,
      exportedAt: Date.now(),
      session,
      reviewText: renderSandboxReview(configManager),
    };
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf-8');
    return artifact;
  }

  public inspectArtifact(targetPath: string): SandboxSessionArtifact {
    return JSON.parse(readFileSync(targetPath, 'utf-8')) as SandboxSessionArtifact;
  }

  public resetForTesting(): void {
    this.sessions.clear();
  }
}

let singleton: SandboxSessionRegistry | null = null;

export function getSandboxSessionRegistry(): SandboxSessionRegistry {
  if (!singleton) singleton = new SandboxSessionRegistry();
  return singleton;
}

export function resetSandboxSessionRegistryForTesting(): void {
  singleton?.resetForTesting();
  singleton = null;
}
