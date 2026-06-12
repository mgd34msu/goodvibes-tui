import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { ScrollableListPanel } from './scrollable-list-panel.ts';
import {
  buildDetailBlock,
  buildGuidanceLine,
  buildPanelListRow,
  buildPanelLine,
  buildSummaryBlock,
  buildPanelWorkspace,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
} from './polish.ts';
import type { LocalAuthSnapshot, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import type { LocalAuthInspectionQuery } from '../runtime/ui-service-queries.ts';
import type { KeyName } from './types.ts';
import { isTextBackspace } from '../input/delete-key-policy.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  info: '#38bdf8',
  warn: '#eab308',
  error: '#ef4444',
  selectBg: '#1e293b',
} as const;

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

export class LocalAuthPanel extends ScrollableListPanel<LocalAuthUser> {
  private readonly authManager: LocalAuthInspectionQuery;
  private maskedState: MaskedEntryState | null = null;

  public constructor(authManager: LocalAuthInspectionQuery) {
    super('local-auth', 'Local Auth', 'U', 'monitoring');
    this.showSelectionGutter = true; // I5: non-color selection affordance
    this.authManager = authManager;
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

  public override handleInput(key: KeyName): boolean {
    if (this.maskedState === null) {
      // Delegate scroll/selection to ScrollableListPanel when not in masked mode.
      return super.handleInput?.(key) ?? false;
    }

    // Masked entry is active — capture all keystrokes.
    const state = this.maskedState;

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
    return this.authManager.inspect().users;
  }

  protected renderItem(user: LocalAuthUser, _index: number, selected: boolean, width: number): Line {
    return buildPanelListRow(width, [
      { text: user.username.padEnd(20), fg: C.value },
      { text: ` roles=${formatRoles(user.roles)}`.slice(0, Math.max(0, width - 24)), fg: C.info },
    ], C, { selected });
  }

  protected override getEmptyStateMessage(): string {
    return ' No local auth users configured.';
  }

  public render(width: number, height: number): Line[] {
    // When masked entry is active, render a dedicated prompt instead of the
    // normal panel content. No plaintext password appears anywhere in output.
    if (this.maskedState !== null) {
      return this.renderMaskedPrompt(width, height);
    }

    const intro = 'Manage local daemon and HTTP-listener auth users, bootstrap state, and active sessions.';
    const snapshot = this.authManager.inspect();
    const users = this.getItems();

    const issueMessages: string[] = [];
    if (snapshot.bootstrapCredentialPresent) issueMessages.push('Bootstrap credential file still exists and should be cleared after password rotation.');
    if (snapshot.userCount <= 1) issueMessages.push('Only one local auth user is configured.');
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
        buildPanelLine(width, [[' user store ', C.label], [snapshot.userStorePath.slice(0, Math.max(0, width - 13)), C.dim]]),
        buildPanelLine(width, [[' bootstrap file ', C.label], [snapshot.bootstrapCredentialPath.slice(0, Math.max(0, width - 18)), C.dim]]),
        ...(issueMessages.length > 0
          ? issueMessages.map((issue) => buildPanelLine(width, [[` issue: ${issue}`.slice(0, Math.max(0, width)), C.warn]]))
          : [buildPanelLine(width, [[' local auth posture looks healthy.', C.good]])]),
        buildGuidanceLine(width, '/auth local rotate-password <user>', 'open masked password entry for the selected user (no plaintext in history)', C),
      ], C),
    ];

    if (users.length === 0) {
      const workspace = buildPanelWorkspace(width, height, {
        title: 'Local Auth Control Room',
        intro,
        sections: [{ lines: headerLines }],
        palette: C,
      });
      while (workspace.length < height) workspace.push(createEmptyLine(width));
      return workspace;
    }

    this.clampSelection();
    const selected = users[this.selectedIndex];

    const footerLines: Line[] = [];
    if (selected) {
      footerLines.push(
        ...buildDetailBlock(width, 'Selected user', [
          buildPanelLine(width, [[' username ', C.label], [selected.username, C.value], ['  roles ', C.label], [formatRoles(selected.roles).slice(0, Math.max(0, width - 23)), C.info]]),
          buildPanelLine(width, [[` next: /auth local rotate-password ${selected.username}`.slice(0, Math.max(0, width)), C.dim]]),
          buildPanelLine(width, [[` next: /auth local delete-user ${selected.username}`.slice(0, Math.max(0, width)), C.dim]]),
        ], C),
      );
    }

    if (snapshot.sessions.length > 0) {
      footerLines.push(
        ...snapshot.sessions.slice(0, 8).map((session) => buildPanelLine(width, [
          [' ', C.label],
          [session.username.padEnd(18), C.value],
          [` expires ${new Date(session.expiresAt).toLocaleString()}`.slice(0, Math.max(0, width - 20)), C.dim],
        ])),
      );
    }
    footerLines.push(buildPanelLine(width, [[' /auth local review  /auth local add-user <user>  /auth local rotate-password <user>  (omit password for masked entry) ', C.dim]]));

    return this.renderList(width, height, {
      title: 'Local Auth Control Room',
      header: headerLines,
      footer: footerLines,
    });
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
      buildPanelLine(width, [[' Password  ', C.label], [maskedDisplay.slice(0, Math.max(0, width - 12)), C.info]]),
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
