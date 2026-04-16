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
import type { LocalAuthSnapshot } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import type { LocalAuthInspectionQuery } from '../runtime/ui-service-queries.ts';

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

export class LocalAuthPanel extends ScrollableListPanel<LocalAuthUser> {
  private readonly authManager: LocalAuthInspectionQuery;

  public constructor(authManager: LocalAuthInspectionQuery) {
    super('local-auth', 'Local Auth', 'U', 'monitoring');
    this.authManager = authManager;
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
        buildGuidanceLine(width, '/auth local rotate-password <user> <password>', 'rotate bootstrap/default credentials and revoke older sessions as needed', C),
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
          buildPanelLine(width, [[` next: /auth local rotate-password ${selected.username} <password>`.slice(0, Math.max(0, width)), C.dim]]),
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
    footerLines.push(buildPanelLine(width, [[' /auth local review  /auth local add-user  /auth local rotate-password  /auth local revoke-session ', C.dim]]));

    return this.renderList(width, height, {
      title: 'Local Auth Control Room',
      header: headerLines,
      footer: footerLines,
    });
  }
}
