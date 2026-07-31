import type { Line } from '@pellux/goodvibes-sdk/platform/types';
import { createEmptyLine } from '@pellux/goodvibes-sdk/platform/types';
import { fitDisplay, truncateDisplay } from '../utils/terminal-width.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildGuidanceLine,
  buildKeyboardHints,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import type { LocalAuthSnapshot, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { LocalAuthInspectionQuery } from '@/runtime/index.ts';
import type { KeyName } from './types.ts';
import { isTextBackspace } from '../input/delete-key-policy.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { type ConfirmState, handleConfirmInput } from './confirm-state.ts';

// Base chrome only — state colors and text tokens come straight from
// DEFAULT_PANEL_PALETTE.
const C = DEFAULT_PANEL_PALETTE;

function formatRoles(roles: readonly string[]): string {
  return roles.length > 0 ? roles.join(', ') : '(none)';
}

type LocalAuthUser = LocalAuthSnapshot['users'][number];

/** Action kind for the masked password entry mode. */
export type MaskedEntryKind = 'add-user' | 'rotate-password';

interface MaskedEntryState {
  readonly kind: MaskedEntryKind;
  readonly username: string;
  readonly auth: UserAuthManager;
  buffer: string;
}

/** Mutation surface the panel needs for p/a/d/b — a subset of UserAuthManager. */
type LocalAuthMutations = Pick<UserAuthManager, 'addUser' | 'deleteUser' | 'rotatePassword' | 'clearBootstrapCredentialFile'>;

function hasLocalAuthMutations(value: LocalAuthInspectionQuery): value is LocalAuthInspectionQuery & LocalAuthMutations {
  const candidate = value as Partial<LocalAuthMutations>;
  return typeof candidate.addUser === 'function'
    && typeof candidate.deleteUser === 'function'
    && typeof candidate.rotatePassword === 'function'
    && typeof candidate.clearBootstrapCredentialFile === 'function';
}

export class LocalAuthPanel extends ScrollableListPanel<LocalAuthUser> {
  private readonly authManager: LocalAuthInspectionQuery;
  private maskedState: MaskedEntryState | null = null;
  /** Pending delete-user confirmation — project-standard ConfirmState contract. */
  private deleteConfirm: ConfirmState<string> | null = null;
  /** Draft username buffer for the 'a' add-user flow's first step (username,
   * then openMaskedEntry for the password). Not masked — usernames aren't secret. */
  private usernameEntry: string | null = null;
  /** Cached inspect() snapshot for the current render pass — see render(). */
  private cachedSnapshot: LocalAuthSnapshot | null = null;

  public constructor(authManager: LocalAuthInspectionQuery) {
    super('local-auth', 'Local Auth', 'U', 'security-policy');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.authManager = authManager;
  }

  /**
   * The full mutation surface (addUser/deleteUser/rotatePassword/
   * clearBootstrapCredentialFile), when the constructor's authManager
   * happens to be the real UserAuthManager rather than the narrower
   * read-only LocalAuthInspectionQuery some callers (and tests) supply.
   * Real production wiring (builtin/operations.ts) always passes the full
   * manager; test doubles that implement only inspect() correctly get null
   * here, and the p/a/d/b keys surface a clear error instead of throwing.
   */
  private get mutations(): LocalAuthMutations | null {
    return hasLocalAuthMutations(this.authManager) ? this.authManager : null;
  }

  /**
   * Activate masked password-entry mode for the given operation.
   * The panel's handleInput will capture keystrokes into a private buffer;
   * no plaintext is ever recorded in input history, transcript, or logs.
   */
  public openMaskedEntry(kind: MaskedEntryKind, username: string, auth: UserAuthManager): void {
    this.maskedState = { kind, username, auth, buffer: '' };
    this.invalidate();
  }

  /** Returns true when the panel is in masked-entry mode. */
  public get isMaskedEntryActive(): boolean {
    return this.maskedState !== null;
  }

  /**
   * Masked password/username entry wants every character of a burst (paste,
   * or fast typing landing in one input.feed() call) delivered one at a
   * time, same as it always has — see the interface doc on
   * `Panel.isCapturingTextBurst`.
   */
  public override isCapturingTextBurst(): boolean {
    return this.isMaskedEntryActive || this.usernameEntry !== null || super.isCapturingTextBurst();
  }

  public override handleInput(key: KeyName): boolean {
    // Masked entry takes priority when active — it must capture every
    // keystroke (including letters that would otherwise be p/a/d/b actions)
    // as part of the password being typed.
    if (this.maskedState !== null) {
      return this.handleMaskedEntryInput(key);
    }

    if (this.usernameEntry !== null) {
      return this.handleUsernameEntryInput(key);
    }

    if (this.deleteConfirm !== null) {
      return this.handleDeleteConfirmInput(key);
    }

    const selected = this.getSelectedItem();

    if (key === 'p') {
      if (!selected) return false;
      const mutations = this.mutations;
      if (!mutations) {
        this.setError('Local auth mutations are not available in this session.');
        return true;
      }
      this.openMaskedEntry('rotate-password', selected.username, mutations as unknown as UserAuthManager);
      return true;
    }

    if (key === 'a') {
      const mutations = this.mutations;
      if (!mutations) {
        this.setError('Local auth mutations are not available in this session.');
        return true;
      }
      this.usernameEntry = '';
      this.invalidate();
      return true;
    }

    if (key === 'd') {
      if (!selected) return false;
      this.deleteConfirm = { subject: selected.username, label: selected.username };
      this.invalidate();
      return true;
    }

    if (key === 'b') {
      const snapshot = this.cachedSnapshot ?? this.authManager.inspect();
      if (!snapshot.bootstrapCredentialPresent) return false;
      const mutations = this.mutations;
      if (!mutations) {
        this.setError('Local auth mutations are not available in this session.');
        return true;
      }
      const cleared = mutations.clearBootstrapCredentialFile();
      if (cleared) {
        this.cachedSnapshot = null; // force a fresh inspect() on the next render
      } else {
        this.setError('No bootstrap credential file was present.');
      }
      this.invalidate();
      return true;
    }

    // Delegate scroll/selection to ScrollableListPanel for everything else.
    return super.handleInput?.(key) ?? false;
  }

  private handleDeleteConfirmInput(key: KeyName): boolean {
    const result = handleConfirmInput(this.deleteConfirm, key);
    if (result === 'confirmed') {
      const username = this.deleteConfirm!.subject;
      this.deleteConfirm = null;
      const mutations = this.mutations;
      if (mutations) {
        try {
          const deleted = mutations.deleteUser(username);
          if (deleted) this.cachedSnapshot = null; // force a fresh inspect() on the next render
          else this.setError(`Unknown local auth user: ${username}`);
        } catch (error) {
          this.setError(summarizeError(error));
        }
      } else {
        this.setError('Local auth mutations are not available in this session.');
      }
      this.invalidate();
      return true;
    }
    if (result === 'cancelled') {
      this.deleteConfirm = null;
      this.invalidate();
      return true;
    }
    // 'absorbed' (or defensively, 'inactive' — deleteConfirm is non-null here so this never fires)
    return true;
  }

  private handleUsernameEntryInput(key: KeyName): boolean {
    if (key === 'escape') {
      this.usernameEntry = null;
      this.invalidate();
      return true;
    }
    if (key === 'enter' || key === 'return') {
      const username = (this.usernameEntry ?? '').trim();
      this.usernameEntry = null;
      if (username.length === 0) {
        this.invalidate();
        return true; // no-op on empty username, mirroring the masked-entry empty-buffer no-op
      }
      const mutations = this.mutations;
      if (mutations) {
        this.openMaskedEntry('add-user', username, mutations as unknown as UserAuthManager);
      } else {
        this.setError('Local auth mutations are not available in this session.');
        this.invalidate();
      }
      return true;
    }
    if (isTextBackspace(key)) {
      if (this.usernameEntry && this.usernameEntry.length > 0) {
        this.usernameEntry = this.usernameEntry.slice(0, -1);
        this.invalidate();
      }
      return true;
    }
    if (key.length === 1) {
      this.usernameEntry = (this.usernameEntry ?? '') + key;
      this.invalidate();
      return true;
    }
    return true; // absorb everything else while username entry is active
  }

  private handleMaskedEntryInput(key: KeyName): boolean {
    // Masked entry is active — capture all keystrokes.
    const state = this.maskedState!;

    if (key === 'escape') {
      // Cancel: discard buffer, exit masked mode without persisting.
      this.maskedState = null;
      this.invalidate();
      return true;
    }

    if (key === 'enter' || key === 'return') {
      // Submit: call the auth API if a non-empty password was entered.
      if (state.buffer.length === 0) {
        return true; // no-op — require at least one character
      }
      const password = state.buffer;
      const { kind, username, auth } = state;
      // Clear the mutable state *before* the auth call so the secret
      // never lingers in the buffer after an exception.
      this.maskedState = null;
      try {
        if (kind === 'add-user') {
          auth.addUser(username, password, ['admin']);
        } else {
          auth.rotatePassword(username, password);
        }
      } catch (_error) {
        // Surface errors via the panel's error facility rather than logging.
        this.setError(summarizeError(_error));
      }
      this.invalidate();
      return true;
    }

    if (isTextBackspace(key)) {
      // Remove last character (Ink 6.8.0: raw-stdin raw 'backspace' only).
      if (state.buffer.length > 0) {
        state.buffer = state.buffer.slice(0, -1);
        this.invalidate();
      }
      return true;
    }

    // Single printable character: append to buffer.
    if (key.length === 1) {
      state.buffer += key;
      this.invalidate();
      return true;
    }

    // All other named keys are consumed (ignored) while masked mode is active.
    return true;
  }

  protected override getPalette(): PanelPalette {
    return C;
  }

  protected getItems(): readonly LocalAuthUser[] {
    // Reads the render-pass cache populated by render() below (single
    // inspect() per render). Falls back to a fresh inspect() only when
    // called before the first render (e.g. directly from a test).
    return (this.cachedSnapshot ?? this.authManager.inspect()).users;
  }

  protected renderItem(user: LocalAuthUser, _index: number, selected: boolean, width: number): Line {
    return buildPanelListRow(width, [
      { text: fitDisplay(user.username, 20), fg: C.value },
      { text: truncateDisplay(` roles=${formatRoles(user.roles)}`, Math.max(0, width - 24)), fg: C.info },
    ], C, { selected });
  }

  protected override getEmptyStateMessage(): string {
    return ' No local auth users configured.';
  }

  public render(width: number, height: number): Line[] {
    // When masked entry or username entry is active, render a dedicated
    // prompt instead of the normal panel content. No plaintext password
    // appears anywhere in output.
    if (this.maskedState !== null) {
      return this.renderMaskedPrompt(width, height);
    }
    if (this.usernameEntry !== null) {
      return this.renderUsernameEntryPrompt(width, height);
    }

    const intro = 'Manage local daemon and HTTP-listener auth users, bootstrap state, and active sessions.';
    // Single inspect() call for this whole render pass — getItems() (called
    // both directly below and again inside renderList()'s internal
    // getVisibleItems()) reads from this cache instead of re-inspecting.
    this.cachedSnapshot = this.authManager.inspect();
    const snapshot = this.cachedSnapshot;
    const users = this.getItems();

    const issueMessages: string[] = [];
    if (snapshot.bootstrapCredentialPresent) issueMessages.push('Bootstrap credential file still exists — press b to clear it after password rotation.');
    if (snapshot.sessionCount === 0) issueMessages.push('No active local auth sessions are currently tracked.');

    const headerLines: Line[] = [
      ...buildSummaryBlock(width, 'Local auth posture', [
        buildPanelLine(width, [
          [' users ', C.label],
          [String(snapshot.userCount), C.value],
          ['  sessions ', C.label],
          [String(snapshot.sessionCount), snapshot.sessionCount > 0 ? C.info : C.dim],
          ['  bootstrap ', C.label],
          [snapshot.bootstrapCredentialPresent ? 'present' : 'cleared', snapshot.bootstrapCredentialPresent ? C.warn : C.good],
        ]),
        buildPanelLine(width, [[' user store ', C.label], [truncateDisplay(snapshot.userStorePath, Math.max(0, width - 13)), C.dim]]),
        buildPanelLine(width, [[' bootstrap file ', C.label], [truncateDisplay(snapshot.bootstrapCredentialPath, Math.max(0, width - 18)), C.dim]]),
        ...(issueMessages.length > 0
          ? issueMessages.map((issue) => buildPanelLine(width, [[truncateDisplay(` issue: ${issue}`, width), C.warn]]))
          : [buildPanelLine(width, [[' local auth posture looks healthy.', C.good]])]),
        buildGuidanceLine(width, 'p / a / d', 'rotate password, add user, or delete the selected user via masked in-panel entry', C),
      ], C),
    ];

    if (users.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Local Auth Control Room',
        intro,
        sections: [{ lines: headerLines }],
        footerLines: [this.buildHintsLine(width, null)],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace.slice(0, height);
    }

    this.clampSelection();
    const selected = this.getSelectedItem();

    const footerLines: Line[] = [];
    if (selected) {
      const deleteActive = this.deleteConfirm?.subject === selected.username;
      footerLines.push(
        ...buildDetailBlock(width, 'Selected user', [
          buildPanelLine(width, [[' username ', C.label], [selected.username, C.value], ['  roles ', C.label], [truncateDisplay(formatRoles(selected.roles), Math.max(0, width - 23)), C.info]]),
          deleteActive
            ? buildPanelLine(width, [[` Delete ${selected.username}? Press y or Enter to confirm, n or Esc to cancel.`, C.warn]])
            : buildPanelLine(width, [[' p: rotate password   a: add user   d: delete user', C.dim]]),
        ], C),
      );
    }

    if (snapshot.sessions.length > 0) {
      footerLines.push(buildPanelLine(width, [[` Active sessions (${snapshot.sessions.length})`, C.label]]));
      footerLines.push(
        ...snapshot.sessions.slice(0, 8).map((session) => buildPanelLine(width, [
          [' ', C.label],
          [fitDisplay(session.username, 18), C.value],
          [truncateDisplay(` expires ${new Date(session.expiresAt).toLocaleString()}`, Math.max(0, width - 20)), C.dim],
        ])),
      );
    }

    return this.renderList(width, height, {
      title: 'Local Auth Control Room',
      header: headerLines,
      footer: footerLines,
      hints: this.buildHints(selected ?? null, snapshot.bootstrapCredentialPresent),
    });
  }

  /** Footer keyboard hints, adapted to the current state — confirm-pending
   * vs. normal browsing, and whether there's a bootstrap credential to clear. */
  private buildHints(
    selected: LocalAuthUser | null,
    bootstrapCredentialPresent: boolean,
  ): ReadonlyArray<{ keys: string; label: string }> {
    if (this.deleteConfirm) {
      return [
        { keys: 'y/Enter', label: 'confirm delete' },
        { keys: 'n/Esc', label: 'cancel' },
      ];
    }
    const hints: Array<{ keys: string; label: string }> = [{ keys: '↑/↓', label: 'select user' }];
    if (selected) {
      hints.push({ keys: 'p', label: 'rotate password' }, { keys: 'd', label: 'delete user' });
    }
    hints.push({ keys: 'a', label: 'add user' });
    if (bootstrapCredentialPresent) hints.push({ keys: 'b', label: 'clear bootstrap credential' });
    return hints;
  }

  private buildHintsLine(width: number, selected: LocalAuthUser | null): Line {
    return buildKeyboardHints(width, this.buildHints(selected, false), C);
  }

  private renderUsernameEntryPrompt(width: number, height: number): Line[] {
    const draft = this.usernameEntry ?? '';
    const promptLines: Line[] = [
      buildPanelLine(width, [[' Add local auth user — enter a username, then set a masked password.', C.value]]),
      buildPanelLine(width, [['', C.label]]),
      buildPanelLine(width, [[' Username  ', C.label], [`${draft}█`, C.info]]),
      buildPanelLine(width, [['', C.label]]),
      buildPanelLine(width, [[' [Enter] Continue to password entry   [Esc] Cancel   [Backspace] Delete char', C.dim]]),
    ];
    const workspace = buildPanelWorkspace(width, height, {
      title: 'Local Auth — Add User',
      intro: 'Type the new username and press Enter to continue to masked password entry.',
      sections: [{ lines: promptLines }],
      palette: C,
    });
    while (workspace.length < height) workspace.push(createEmptyLine(width));
    return workspace.slice(0, height);
  }

  private renderMaskedPrompt(width: number, height: number): Line[] {
    const state = this.maskedState!;
    const actionLabel = state.kind === 'add-user' ? 'Add user' : 'Rotate password';
    const dots = '•'.repeat(Math.min(32, state.buffer.length));
    const cursor = '█'; // block cursor
    const maskedDisplay = state.buffer.length > 0 ? `${dots}${cursor}` : cursor;

    const promptLines: Line[] = [
      buildPanelLine(width, [[` ${actionLabel}: ${state.username}`, C.value]]),
      buildPanelLine(width, [['', C.label]]),
      buildPanelLine(width, [[' Password  ', C.label], [truncateDisplay(maskedDisplay, Math.max(0, width - 12)), C.info]]),
      buildPanelLine(width, [['', C.label]]),
      buildPanelLine(width, [[' [Enter] Confirm   [Esc] Cancel   [Backspace] Delete char', C.dim]]),
    ];

    const workspace = buildPanelWorkspace(width, height, {
      title: 'Local Auth — Password Entry',
      intro: `Type a password for ${state.username}. The value is never echoed in plaintext or stored in history.`,
      sections: [{ lines: promptLines }],
      palette: C,
    });
    while (workspace.length < height) workspace.push(createEmptyLine(width));
    return workspace;
  }
}
