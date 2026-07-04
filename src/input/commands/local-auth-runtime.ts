import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { openCommandPanel, requireLocalUserAuthManager } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function formatRoles(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(', ') : '(none)';
}

export function handleLocalAuthCommand(args: string[], ctx: CommandContext): void {
  const sub = (args[0] ?? 'review').toLowerCase();
  const auth = requireLocalUserAuthManager(ctx);
  if (sub === 'panel' || sub === 'open') {
    // W6.1: browse view moved to local-auth-modal. The LocalAuthPanel itself is
    // kept (masked password-entry host) but is no longer the /local-auth panel
    // destination — masked entry is reached via add-user/rotate-password below.
    ctx.openModal?.('local-auth-modal');
    return;
  }

  if (sub === 'add-user') {
    const username = args[1];
    const password = args[2];
    if (!username) {
      ctx.print('Usage: /auth local add-user <username> <password> [roles]\nTip: invoke without a password to use the masked panel: /auth local add-user <username>');
      return;
    }
    if (!password) {
      // No password supplied — open masked-entry mode on the LocalAuthPanel.
      if (ctx.openLocalAuthMaskedEntry) {
        ctx.openLocalAuthMaskedEntry('add-user', username);
      } else {
        ctx.print('Masked entry unavailable in this context. Use: /auth local add-user <username> <password>');
      }
      return;
    }
    // Password supplied as argv: warn that the history entry has been scrubbed.
    ctx.print('Warning: passwords passed as command arguments are scrubbed from history, but may appear in shell scrollback. The masked entry is preferred: /auth local add-user <username>');
    const roles = args[3]?.split(',').map((value) => value.trim()).filter(Boolean) ?? ['admin'];
    try {
      const added = auth.addUser(username, password, roles);
      ctx.print(`Added local auth user ${added.username} (${formatRoles(added.roles)}).`);
    } catch (error) {
      ctx.print(summarizeError(error));
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
      ctx.print(summarizeError(error));
    }
    return;
  }

  if (sub === 'rotate-password') {
    const username = args[1];
    const password = args[2];
    if (!username) {
      ctx.print('Usage: /auth local rotate-password <username> <password>\nTip: invoke without a password to use the masked panel: /auth local rotate-password <username>');
      return;
    }
    if (!password) {
      // No password supplied — open masked-entry mode on the LocalAuthPanel.
      if (ctx.openLocalAuthMaskedEntry) {
        ctx.openLocalAuthMaskedEntry('rotate-password', username);
      } else {
        ctx.print('Masked entry unavailable in this context. Use: /auth local rotate-password <username> <password>');
      }
      return;
    }
    // Password supplied as argv: warn that the history entry has been scrubbed.
    ctx.print('Warning: passwords passed as command arguments are scrubbed from history, but may appear in shell scrollback. The masked entry is preferred: /auth local rotate-password <username>');
    try {
      auth.rotatePassword(username, password);
      ctx.print(`Rotated password for ${username}. Existing sessions were revoked.`);
    } catch (error) {
      ctx.print(summarizeError(error));
    }
    return;
  }

  if (sub === 'revoke-session') {
    const token = args[1];
    if (!token) {
      ctx.print('Usage: /auth local revoke-session <token-or-fingerprint>');
      return;
    }
    ctx.print(auth.revokeSession(token) ? `Revoked session ${token.slice(0, 12)}…` : `Unknown session token or fingerprint: ${token}`);
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
    ...snapshot.sessions.map((session) => `  session: ${session.username}  expires=${new Date(session.expiresAt).toISOString()}  fingerprint=${session.tokenFingerprint}`),
  ].join('\n'));
}

export function registerLocalAuthRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'local-auth',
    aliases: ['auth-local'],
    description: 'Inspect and manage local daemon/listener auth users, sessions, and bootstrap credentials',
    usage: '[review|panel|add-user <username> <password> [roles]|delete-user <username>|rotate-password <username> <password>|revoke-session <token-or-fingerprint>|clear-bootstrap-file]',
    handler(args, ctx) {
      handleLocalAuthCommand(args, ctx);
    },
  });
}
