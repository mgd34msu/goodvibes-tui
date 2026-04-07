import { resolve } from 'node:path';
import type { CommandContext } from '../command-registry.ts';
import { inspectSandboxSessionArtifact, listSandboxProfiles, renderSandboxSessions } from '../../runtime/sandbox/manager.ts';
import { getSandboxSessionRegistry } from '../../runtime/sandbox/session-registry.ts';

const SANDBOX_PROFILE_IDS = [
  'eval-js',
  'eval-ts',
  'eval-py',
  'eval-sql',
  'eval-graphql',
  'mcp-shared',
  'mcp-per-server',
] as const;

function findSandboxProfile(configManager: CommandContext['configManager'], profileId: string) {
  return listSandboxProfiles(configManager).find((entry) => entry.id === profileId);
}

export async function handleSandboxSessionCommand(args: string[], ctx: CommandContext): Promise<boolean> {
  const sessions = getSandboxSessionRegistry();
  const mode = (args[1] ?? 'list').toLowerCase();
  if (mode === 'list') {
    ctx.print(renderSandboxSessions(sessions.list()));
    return true;
  }
  if (mode === 'start') {
    const profileId = args[2];
    if (!profileId || !findSandboxProfile(ctx.configManager, profileId)) {
      ctx.print(`Usage: /sandbox session start <${SANDBOX_PROFILE_IDS.join('|')}> [label...]`);
      return true;
    }
    const session = await sessions.start(profileId as (typeof SANDBOX_PROFILE_IDS)[number], args.slice(3).join(' '), ctx.configManager);
    ctx.print(`Started sandbox session ${session.id} for ${session.profileId} (${session.shared ? 'shared' : 'dedicated'}, backend=${session.resolvedBackend ?? session.backend}, state=${session.state}, startup=${session.startupStatus ?? 'n/a'}).`);
    if (session.startupDetail) ctx.print(`  ${session.startupDetail}`);
    return true;
  }
  if (mode === 'inspect') {
    const sessionId = args[2];
    if (!sessionId) {
      ctx.print('Usage: /sandbox session inspect <session-id>');
      return true;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      ctx.print(`Unknown sandbox session: ${sessionId}`);
      return true;
    }
    ctx.print([
      `Sandbox session ${session.id}`,
      `  profile: ${session.profileId}`,
      `  kind: ${session.kind}`,
      `  state: ${session.state}`,
      `  shared: ${session.shared ? 'yes' : 'no'}`,
      `  backend: ${session.backend}`,
      `  resolved: ${session.resolvedBackend ?? session.backend}`,
      `  startup: ${session.startupStatus ?? 'n/a'}`,
      ...(session.startupDetail ? [`  detail: ${session.startupDetail}`] : []),
      ...(session.managedGuestHost || session.managedGuestPort || session.managedGuestPid ? [`  guest: ${session.managedGuestHost ?? '(unset)'}:${session.managedGuestPort ?? 0}  pid=${session.managedGuestPid ?? 'n/a'}`] : []),
      ...(session.lastCommandSummary ? [`  last: ${session.lastCommandSummary}`] : []),
    ].join('\n'));
    return true;
  }
  if (mode === 'stop') {
    const sessionId = args[2];
    if (!sessionId) {
      ctx.print('Usage: /sandbox session stop <session-id>');
      return true;
    }
    const session = sessions.stop(sessionId);
    ctx.print(session ? `Stopped sandbox session ${session.id}.` : `Unknown sandbox session: ${sessionId}`);
    return true;
  }
  if (mode === 'run') {
    const sessionId = args[2];
    const command = args[3];
    const commandArgs = args.slice(4);
    if (!sessionId || !command) {
      ctx.print('Usage: /sandbox session run <session-id> <command> [args...]');
      return true;
    }
    try {
      const result = sessions.execute(sessionId, command, commandArgs, ctx.configManager, { timeoutMs: 10000 });
      const lines = [`Sandbox session run ${sessionId}`, `  status: ${result.status ?? 'n/a'}`];
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (stdout) lines.push(`  stdout: ${stdout}`);
      if (stderr) lines.push(`  stderr: ${stderr}`);
      ctx.print(lines.join('\n'));
    } catch (error) {
      ctx.print(error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (mode === 'artifact') {
    const artifactMode = (args[2] ?? '').toLowerCase();
    if (artifactMode === 'export') {
      const sessionId = args[3];
      const pathArg = args[4];
      if (!sessionId || !pathArg) {
        ctx.print('Usage: /sandbox session artifact export <session-id> <path>');
        return true;
      }
      const targetPath = resolve(process.cwd(), pathArg);
      sessions.exportArtifact(sessionId, targetPath, ctx.configManager);
      ctx.print(`Sandbox session artifact exported to ${targetPath}`);
      return true;
    }
    if (artifactMode === 'inspect') {
      const pathArg = args[3];
      if (!pathArg) {
        ctx.print('Usage: /sandbox session artifact inspect <path>');
        return true;
      }
      const targetPath = resolve(process.cwd(), pathArg);
      ctx.print(inspectSandboxSessionArtifact(sessions.inspectArtifact(targetPath)));
      return true;
    }
  }
  ctx.print('Usage: /sandbox session [list|start <profile> [label...]|inspect <session-id>|stop <session-id>|run <session-id> <command> [args...]|artifact export <session-id> <path>|artifact inspect <path>]');
  return true;
}
