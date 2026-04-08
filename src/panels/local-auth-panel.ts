import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { buildGuidanceLine, buildPanelLine, buildPanelWorkspace, DEFAULT_PANEL_PALETTE, type PanelWorkspaceSection } from './polish.ts';
import { getLocalUserAuthManager } from '../runtime/local-auth.ts';
import { getTrackedVisibleWindow } from '../renderer/surface-layout.ts';

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

export class LocalAuthPanel extends BasePanel {
  private selectedIndex = 0;
  private scrollOffset = 0;

  public constructor() {
    super('local-auth', 'Local Auth', 'U', 'monitoring');
  }

  public handleInput(key: string): boolean {
    const users = getLocalUserAuthManager().inspect().users;
    if (users.length === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(users.length - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const snapshot = getLocalUserAuthManager().inspect();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, snapshot.users.length - 1));
    const selected = snapshot.users[this.selectedIndex];
    const issueMessages: string[] = [];
    if (snapshot.bootstrapCredentialPresent) issueMessages.push('Bootstrap credential file still exists and should be cleared after password rotation.');
    if (snapshot.userCount <= 1) issueMessages.push('Only one local auth user is configured.');
    if (snapshot.sessionCount === 0) issueMessages.push('No active local auth sessions are currently tracked.');
    const sections: PanelWorkspaceSection[] = [
      {
        title: 'Posture',
        lines: [
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
        ],
      },
    ];

    if (snapshot.users.length > 0) {
      const window = getTrackedVisibleWindow(snapshot.users.length, this.selectedIndex, Math.max(4, height - 14), this.scrollOffset, 1);
      this.scrollOffset = window.start;
      const userLines: Line[] = [];
      for (let absolute = window.start; absolute < window.end; absolute++) {
        const user = snapshot.users[absolute]!;
        const bg = absolute === this.selectedIndex ? C.selectBg : undefined;
        userLines.push(buildPanelLine(width, [
          [' ', C.label, bg],
          [user.username.padEnd(20), C.value, bg],
          [` roles=${formatRoles(user.roles)}`.slice(0, Math.max(0, width - 22)), C.info, bg],
        ]));
      }
      sections.push({ title: 'Users', lines: userLines });
      if (selected) {
        sections.push({
          title: 'Selected User',
          lines: [
            buildPanelLine(width, [[' username ', C.label], [selected.username, C.value], ['  roles ', C.label], [formatRoles(selected.roles).slice(0, Math.max(0, width - 23)), C.info]]),
            buildPanelLine(width, [[` next: /auth local rotate-password ${selected.username} <password>`.slice(0, Math.max(0, width)), C.dim]]),
            buildPanelLine(width, [[` next: /auth local delete-user ${selected.username}`.slice(0, Math.max(0, width)), C.dim]]),
          ],
        });
      }
    }

    if (snapshot.sessions.length > 0) {
      sections.push({
        title: 'Active Sessions',
        lines: snapshot.sessions.slice(0, 8).map((session) => buildPanelLine(width, [
          [' ', C.label],
          [session.username.padEnd(18), C.value],
          [` expires ${new Date(session.expiresAt).toLocaleString()}`.slice(0, Math.max(0, width - 20)), C.dim],
        ])),
      });
    }

    const lines = buildPanelWorkspace(width, height, {
      title: 'Local Auth Control Room',
      intro: 'Manage local daemon and HTTP-listener auth users, bootstrap state, and active sessions.',
      sections,
      footerLines: [buildPanelLine(width, [[' /auth local review  /auth local add-user  /auth local rotate-password  /auth local revoke-session ', C.dim]])],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
