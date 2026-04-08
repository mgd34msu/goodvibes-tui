import { getPanelManager } from '../../panels/panel-manager.ts';
import { getLocalUserAuthManager } from '../../runtime/local-auth.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

function formatRoles(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(', ') : '(none)';
}

export function handleLocalAuthCommand(args: string[], ctx: CommandContext): void {
  const sub = (args[0] ?? 'review').toLowerCase();
  const auth = getLocalUserAuthManager();
  if (sub === 'panel' || sub === 'open') {
    const panelManager = getPanelManager();
    panelManager.open('local-auth');
    panelManager.show();
    ctx.renderRequest();
    return;
  }

  if (sub === 'add-user') {
    const username = args[1];
    const password = args[2];
    const roles = args[3]?.split(',').map((value) => value.trim()).filter(Boolean) ?? ['admin'];
    if (!username || !password) {
      ctx.print('Usage: /auth local add-user <username> <password> [roles]');
      return;
    }
    try {
      const added = auth.addUser(username, password, roles);
      ctx.print(`Added local auth user ${added.username} (${formatRoles(added.roles)}).`);
    } catch (error) {
      ctx.print((error as Error).message);
    }
    return;
  }

  if (sub === 'delete-user') {
    const username = args[1];
    if (!username) {
      ctx.print('Usage: /auth local delete-user <username>');
      return;
    }
    try {
      const deleted = auth.deleteUser(username);
      ctx.print(deleted ? `Deleted local auth user ${username}.` : `Unknown local auth user: ${username}`);
    } catch (error) {
      ctx.print((error as Error).message);
    }
    return;
  }

  if (sub === 'rotate-password') {
    const username = args[1];
    const password = args[2];
    if (!username || !password) {
      ctx.print('Usage: /auth local rotate-password <username> <password>');
      return;
    }
    try {
      auth.rotatePassword(username, password);
      ctx.print(`Rotated password for ${username}. Existing sessions were revoked.`);
    } catch (error) {
      ctx.print((error as Error).message);
    }
    return;
  }

  if (sub === 'revoke-session') {
    const token = args[1];
    if (!token) {
      ctx.print('Usage: /auth local revoke-session <token>');
      return;
    }
    ctx.print(auth.revokeSession(token) ? `Revoked session ${token.slice(0, 12)}…` : `Unknown session token: ${token}`);
    return;
  }

  if (sub === 'clear-bootstrap-file') {
    ctx.print(auth.clearBootstrapCredentialFile()
      ? 'Removed bootstrap credential file.'
      : 'No bootstrap credential file was present.');
    return;
  }

  const snapshot = auth.inspect();
  ctx.print([
    'Local Auth Review',
    `  user store: ${snapshot.userStorePath}`,
    `  bootstrap file: ${snapshot.bootstrapCredentialPath}`,
    `  bootstrap credentials: ${snapshot.bootstrapCredentialPresent ? 'present' : 'cleared'}`,
    `  users: ${snapshot.userCount}`,
    `  sessions: ${snapshot.sessionCount}`,
    ...snapshot.users.map((user) => `  user: ${user.username}  roles=${formatRoles(user.roles)}`),
    ...snapshot.sessions.map((session) => `  session: ${session.username}  expires=${new Date(session.expiresAt).toISOString()}  token=${session.token.slice(0, 12)}…`),
  ].join('\n'));
}

export function registerLocalAuthRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'local-auth',
    aliases: ['auth-local'],
    description: 'Inspect and manage local daemon/listener auth users, sessions, and bootstrap credentials',
    usage: '[review|panel|add-user <username> <password> [roles]|delete-user <username>|rotate-password <username> <password>|revoke-session <token>|clear-bootstrap-file]',
    handler(args, ctx) {
      handleLocalAuthCommand(args, ctx);
    },
  });
}
