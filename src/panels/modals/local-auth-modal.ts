import type { ConfigModalAction, ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { LocalAuthInspectionQuery } from '@/runtime/index.ts';
import type { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { postureLine, kv } from './modal-surface-helpers.ts';

/** Mutation surface the surface needs to gate p/d/b on, a subset of UserAuthManager,
 *  mirroring LocalAuthPanel's own `hasLocalAuthMutations` guard. */
type LocalAuthMutations = Pick<UserAuthManager, 'addUser' | 'deleteUser' | 'rotatePassword' | 'clearBootstrapCredentialFile'>;

function hasLocalAuthMutations(value: LocalAuthInspectionQuery): value is LocalAuthInspectionQuery & LocalAuthMutations {
  const candidate = value as Partial<LocalAuthMutations>;
  return typeof candidate.addUser === 'function'
    && typeof candidate.deleteUser === 'function'
    && typeof candidate.rotatePassword === 'function'
    && typeof candidate.clearBootstrapCredentialFile === 'function';
}

function formatRoles(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(', ') : '(none)';
}

function usernameOf(row: ConfigModalRow | null): string | null {
  return row?.id.startsWith('user:') ? row.id.slice('user:'.length) : null;
}

/**
 * Local-auth config-modal surface. `inspect()` is synchronous, so buildView
 * reads it live every tick. add-user and rotate-password open the masked
 * password prompt (input/masked-entry-modal.ts) on top of this modal, the one
 * path that keeps a plaintext password out of argv, history and the
 * transcript; delete-user and clear-bootstrap-file dispatch through the
 * `/local-auth` command. This surface never renders, accepts, or holds a
 * password.
 */
class LocalAuthModalSurface implements ConfigModalSurface {
  readonly name = 'local-auth-modal';
  readonly title = 'Local Auth';
  /** Cached from the last buildView(), read by the 'b' action's enabledFor,
   *  set fresh every tick (buildView always runs before enabledFor is
   *  consulted; see settings-sync-modal's `hasStaged` for the same idiom). */
  private bootstrapPresent = false;

  constructor(
    private readonly authManager: LocalAuthInspectionQuery,
    private readonly openMaskedEntry: (kind: 'add-user' | 'rotate-password', username?: string) => void,
  ) {}

  readonly actions: ConfigModalAction[] = [
    { key: 'a', id: 'add-user', label: 'add user' },
    { key: 'p', id: 'rotate-pw', label: 'rotate password', enabledFor: (row) => usernameOf(row) !== null },
    { key: 'd', id: 'delete', label: 'delete user', confirm: true, enabledFor: (row) => usernameOf(row) !== null },
    { key: 'b', id: 'clear-bootstrap', label: 'clear bootstrap', enabledFor: () => this.bootstrapPresent },
  ];

  buildView(): ConfigModalView {
    let mutationsUnavailable = false;
    try {
      mutationsUnavailable = !hasLocalAuthMutations(this.authManager);
      const snapshot = this.authManager.inspect();
      this.bootstrapPresent = snapshot.bootstrapCredentialPresent;

      const header = [postureLine([
        kv('users', snapshot.userCount),
        kv('sessions', snapshot.sessionCount),
        kv('bootstrap', snapshot.bootstrapCredentialPresent ? 'present' : 'cleared'),
      ])];

      const rows: ConfigModalRow[] = snapshot.users.map((user) => ({
        id: `user:${user.username}`,
        label: `${user.username}  ${formatRoles(user.roles)}`,
      }));

      return {
        title: 'Local Auth',
        degraded: mutationsUnavailable ? 'Local auth mutations are not available in this session.' : undefined,
        tabs: [{
          id: 'users',
          label: 'Users',
          header,
          rows,
          emptyText: 'No local auth users configured.',
          hints: ['a add user'],
        }],
      };
    } catch (error) {
      this.bootstrapPresent = false;
      return {
        title: 'Local Auth',
        degraded: `Local auth inspection failed: ${summarizeError(error)}`,
        tabs: [{ id: 'users', label: 'Users', rows: [], emptyText: 'Local auth data unavailable.' }],
      };
    }
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    switch (id) {
      // The password prompt opens on top of this modal and never echoes.
      case 'add-user':
        if (!hasLocalAuthMutations(this.authManager)) { ctx.setStatus('Local auth mutations are not available in this session.'); break; }
        this.openMaskedEntry('add-user');
        break;
      case 'rotate-pw': {
        const username = usernameOf(ctx.row);
        if (!username) return;
        if (!hasLocalAuthMutations(this.authManager)) { ctx.setStatus('Local auth mutations are not available in this session.'); break; }
        this.openMaskedEntry('rotate-password', username);
        break;
      }
      case 'delete': {
        const username = usernameOf(ctx.row);
        if (!username) return;
        void ctx.executeCommand?.('local-auth', ['delete-user', username]);
        ctx.setStatus(`Deleting ${username}…`);
        break;
      }
      case 'clear-bootstrap':
        void ctx.executeCommand?.('local-auth', ['clear-bootstrap-file']);
        ctx.setStatus('Clearing bootstrap credential file…');
        break;
      default:
        return;
    }
    ctx.requestRender();
  }
}

export function createLocalAuthModalSurface(
  authManager: LocalAuthInspectionQuery,
  openMaskedEntry: (kind: 'add-user' | 'rotate-password', username?: string) => void = () => {},
): ConfigModalSurface {
  return new LocalAuthModalSurface(authManager, openMaskedEntry);
}
