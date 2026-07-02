import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { buildSandboxReview, listSandboxPresets, listSandboxProfiles } from '@/runtime/index.ts';
import type { SandboxProfile, SandboxReview, SandboxSession, SandboxSessionRegistry } from '@/runtime/index.ts';
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import {
  buildAlignedRow,
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyboardHints,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveStackedScrollableSections,
  DEFAULT_PANEL_PALETTE,
  type PanelPalette,
  type PanelWorkspaceSection,
} from './polish.ts';

// Base chrome only — title band comes straight from DEFAULT_PANEL_PALETTE
// (WO-002).
const C = DEFAULT_PANEL_PALETTE;

/** Poll cadence for live session-state refresh; SandboxSessionRegistry has no event subscription. */
const POLL_INTERVAL_MS = 3_000;

type Selectable =
  | { readonly kind: 'profile'; readonly id: SandboxProfile['id'] }
  | { readonly kind: 'session'; readonly id: string };

/**
 * One contextual next-step line, derived from the current review/session
 * state instead of the previous nine-line guidance wall. Picks the single
 * most relevant action given host warnings, QEMU config gaps, and whether
 * any session is running yet.
 */
function buildContextualGuidance(width: number, review: SandboxReview, sessionCount: number, palette: PanelPalette): Line {
  if (review.host.warnings.length > 0) {
    return buildGuidanceLine(width, '/sandbox review', `resolve ${review.host.warnings.length} host warning(s) before enabling QEMU-backed execution`, palette);
  }
  if (review.config.vmBackend === 'qemu' && !review.config.qemuImagePath) {
    return buildGuidanceLine(width, '/sandbox set-qemu-image <path>', 'set the guest image path before enabling QEMU-backed session execution', palette);
  }
  if (review.config.vmBackend === 'qemu' && !review.config.qemuExecWrapper) {
    return buildGuidanceLine(width, '/sandbox set-qemu-wrapper <path>', 'configure the host bridge that actually executes commands inside the QEMU guest', palette);
  }
  if (sessionCount === 0) {
    return buildGuidanceLine(width, 's', 'select a profile below and press s to start a sandbox session', palette);
  }
  return buildGuidanceLine(width, '/sandbox session run <id> <command> [args...]', 'run a custom command against a running session from the command line', palette);
}

const SANDBOX_HINTS = [
  { keys: '↑/↓', label: 'select' },
  { keys: 'Home/End', label: 'first profile/session' },
  { keys: 's', label: 'start' },
  { keys: 'x', label: 'stop' },
  { keys: 'e', label: 'execute probe' },
] as const;

export class SandboxPanel extends BasePanel {
  private selectedIndex = 0;
  private sessionsScrollOffset = 0;
  private profilesScrollOffset = 0;
  private confirm: ConfirmState<string> | null = null;
  private readonly config: ConfigManager;
  private readonly sessions: SandboxSessionRegistry;
  private readonly requestRender: () => void;

  public constructor(
    config: ConfigManager,
    sessions: SandboxSessionRegistry,
    requestRender: () => void = () => {},
  ) {
    super('sandbox', 'Sandbox', 'X', 'monitoring');
    this.config = config;
    this.sessions = sessions;
    this.requestRender = requestRender;
    // Live state: SandboxSessionRegistry has no event subscription, so poll
    // for session state changes (start/stop/execute results) while the
    // panel is registered.
    this.registerTimer(setInterval(() => {
      this.markDirty();
      this.requestRender();
    }, POLL_INTERVAL_MS));
  }

  private _selectable(): Selectable[] {
    const profiles = listSandboxProfiles(this.config);
    const sessions = this.sessions.list();
    return [
      ...profiles.map((profile): Selectable => ({ kind: 'profile', id: profile.id })),
      ...sessions.map((session): Selectable => ({ kind: 'session', id: session.id })),
    ];
  }

  public handleInput(key: string): boolean {
    if (this.lastError !== null) this.clearError();

    const confirmResult = handleConfirmInput(this.confirm, key);
    if (confirmResult === 'confirmed') {
      const sessionId = this.confirm!.subject;
      this.confirm = null;
      this.sessions.stop(sessionId);
      this.markDirty();
      return true;
    }
    if (confirmResult === 'cancelled') {
      this.confirm = null;
      this.markDirty();
      return true;
    }
    if (confirmResult === 'absorbed') return true;

    const selectable = this._selectable();
    const profileCount = selectable.filter((entry) => entry.kind === 'profile').length;
    const sessionCount = selectable.length - profileCount;
    const selected = selectable[this.selectedIndex];

    if (key === 's' && selected?.kind === 'profile') {
      void this._startSession(selected.id);
      return true;
    }
    if (key === 'x' && selected?.kind === 'session') {
      this.confirm = { subject: selected.id, label: `sandbox session ${selected.id}`, verb: 'Stop' };
      this.markDirty();
      return true;
    }
    if (key === 'e' && selected?.kind === 'session') {
      void this._executeProbe(selected.id);
      return true;
    }

    const itemCount = selectable.length;
    if (itemCount === 0) return false;
    if (key === 'up' || key === 'k') {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.markDirty();
      return true;
    }
    if (key === 'down' || key === 'j') {
      this.selectedIndex = Math.min(itemCount - 1, this.selectedIndex + 1);
      this.markDirty();
      return true;
    }
    if (key === 'home') {
      this.selectedIndex = 0;
      this.markDirty();
      return true;
    }
    if (key === 'end') {
      this.selectedIndex = sessionCount > 0 ? profileCount : Math.max(0, itemCount - 1);
      this.markDirty();
      return true;
    }
    return false;
  }

  /** Start a sandbox session for `profileId` via the shared registry, then repaint. */
  private async _startSession(profileId: SandboxProfile['id']): Promise<void> {
    try {
      await this.sessions.start(profileId, undefined, this.config);
    } catch (err) {
      this.setError(summarizeError(err));
    } finally {
      this.markDirty();
      this.requestRender();
    }
  }

  /**
   * Execute a lightweight liveness probe against the selected session so its
   * live state (last run, exit status, stdout/stderr preview) is genuinely
   * populated from `SandboxSessionRegistry.execute()`. Panels have no
   * free-text input widget today, so this proves the execute verb is wired
   * without inventing one; `/sandbox session run <id> <command> [args...]`
   * remains available for arbitrary commands.
   */
  private async _executeProbe(sessionId: string): Promise<void> {
    try {
      this.sessions.execute(sessionId, process.execPath, ['-e', "console.log('sandbox panel probe ok')"], this.config, { timeoutMs: 5_000 });
    } catch (err) {
      this.setError(summarizeError(err));
    } finally {
      this.markDirty();
      this.requestRender();
    }
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;

    if (this.confirm) {
      const lines = buildPanelWorkspace(width, height, {
        title: 'Sandbox Control Room',
        sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
        palette: C,
      });
      while (lines.length < height) lines.push(createEmptyLine(width));
      return lines.slice(0, height);
    }

    const review = buildSandboxReview(this.config);
    const profiles = listSandboxProfiles(this.config);
    const presets = listSandboxPresets();
    const sessions = this.sessions.list();
    const selectable = this._selectable();
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, selectable.length - 1));
    const selected = selectable[this.selectedIndex] ?? null;
    const selectedProfile = selected?.kind === 'profile'
      ? profiles.find((profile) => profile.id === selected.id) ?? null
      : null;
    const selectedSession = selected?.kind === 'session'
      ? sessions.find((session) => session.id === selected.id) ?? null
      : null;

    const intro = 'Sandbox posture for local execution, optional QEMU isolation, profiles, sessions, and Windows host requirements.';
    const overviewLines: Line[] = [
      buildKeyValueLine(width, [
        { label: 'host', value: review.host.platform, valueColor: C.value },
        { label: 'backend', value: review.config.vmBackend, valueColor: C.info },
        { label: 'windows mode', value: review.config.windowsMode, valueColor: review.host.secureSandboxReady || !review.host.windows ? C.good : C.warn },
      ], C),
      buildKeyValueLine(width, [
        { label: 'repl isolation', value: review.config.replIsolation, valueColor: C.value },
        { label: 'mcp isolation', value: review.config.mcpIsolation, valueColor: review.config.mcpIsolation === 'disabled' ? C.warn : C.good },
      ], C),
      buildKeyValueLine(width, [
        { label: 'virtualization', value: review.config.vmBackend === 'local' ? 'disabled' : (review.host.secureSandboxReady ? 'ready' : 'host blocked'), valueColor: review.config.vmBackend === 'local' ? C.dim : (review.host.secureSandboxReady ? C.good : C.warn) },
        { label: 'warnings', value: String(review.host.warnings.length), valueColor: review.host.warnings.length > 0 ? C.warn : C.dim },
        { label: 'sessions', value: String(sessions.length), valueColor: sessions.length > 0 ? C.info : C.dim },
      ], C),
      buildKeyValueLine(width, [
        { label: 'qemu binary', value: review.config.qemuBinary || '(default)', valueColor: C.value },
        { label: 'qemu image', value: review.config.qemuImagePath || '(not configured)', valueColor: review.config.qemuImagePath ? C.info : C.warn },
      ], C),
      buildKeyValueLine(width, [
        { label: 'qemu wrapper', value: review.config.qemuExecWrapper || '(not configured)', valueColor: review.config.qemuExecWrapper ? C.info : C.warn },
        { label: 'guest host', value: review.config.qemuGuestHost || '(not configured)', valueColor: review.config.qemuGuestHost ? C.info : C.warn },
      ], C),
      buildKeyValueLine(width, [
        { label: 'guest port', value: String(review.config.qemuGuestPort), valueColor: C.value },
        { label: 'guest user', value: review.config.qemuGuestUser || '(not configured)', valueColor: review.config.qemuGuestUser ? C.info : C.warn },
        { label: 'session mode', value: review.config.qemuSessionMode, valueColor: review.config.qemuSessionMode === 'attach' ? C.dim : C.info },
      ], C),
      buildKeyValueLine(width, [
        { label: 'guest workspace', value: review.config.qemuWorkspacePath || '(not configured)', valueColor: review.config.qemuWorkspacePath ? C.value : C.warn },
      ], C),
      // Single contextual next-step line (replaces the former nine-line
      // guidance wall) — the only buildGuidanceLine call in this panel.
      buildContextualGuidance(width, review, sessions.length, C),
    ];

    const selectionLines: Line[] = [];
    if (selectedProfile) {
      selectionLines.push(buildKeyValueLine(width, [
        { label: 'id', value: selectedProfile.id, valueColor: C.info },
        { label: 'kind', value: selectedProfile.kind, valueColor: C.value },
        { label: 'isolation', value: selectedProfile.isolation, valueColor: C.value },
        { label: 'vm', value: selectedProfile.requiresVm ? 'required' : 'optional', valueColor: selectedProfile.requiresVm ? C.good : C.warn },
      ], C));
      selectionLines.push(...buildBodyText(width, selectedProfile.notes.join(' | '), C, C.dim));
    } else if (selectedSession) {
      selectionLines.push(buildKeyValueLine(width, [
        { label: 'profile', value: selectedSession.profileId, valueColor: C.info },
        { label: 'state', value: selectedSession.state, valueColor: selectedSession.state === 'running' ? C.good : selectedSession.state === 'failed' ? C.bad : C.warn },
        { label: 'backend', value: selectedSession.resolvedBackend ?? selectedSession.backend, valueColor: C.value },
        { label: 'sharing', value: selectedSession.shared ? 'shared' : 'dedicated', valueColor: C.value },
      ], C));
      if (selectedSession.startupStatus) {
        selectionLines.push(buildKeyValueLine(width, [
          { label: 'startup', value: selectedSession.startupStatus, valueColor: selectedSession.startupStatus === 'verified' ? C.good : selectedSession.startupStatus === 'failed' ? C.bad : C.warn },
        ], C));
      }
      if (selectedSession.launchPlan) {
        selectionLines.push(...buildBodyText(width, `Launch plan: ${selectedSession.launchPlan.summary}`, C, C.dim));
      }
      if (selectedSession.startupDetail) {
        selectionLines.push(...buildBodyText(width, `Startup: ${selectedSession.startupDetail}`, C, selectedSession.startupStatus === 'failed' ? C.bad : C.dim));
      }
      if (selectedSession.lastCommandSummary) {
        selectionLines.push(...buildBodyText(width, `Last command: ${selectedSession.lastCommandSummary}`, C, C.dim));
      }
      if (selectedSession.lastRunAt !== undefined) {
        selectionLines.push(buildKeyValueLine(width, [
          { label: 'runs', value: String(selectedSession.executionCount ?? 0), valueColor: C.info },
          { label: 'last exit', value: String(selectedSession.lastExitStatus ?? 'n/a'), valueColor: selectedSession.lastExitStatus === 0 ? C.good : C.warn },
          { label: 'last run', value: new Date(selectedSession.lastRunAt).toISOString(), valueColor: C.dim },
        ], C));
      }
      if (selectedSession.lastStdoutPreview) {
        selectionLines.push(...buildBodyText(width, `stdout: ${selectedSession.lastStdoutPreview}`, C, C.dim));
      }
      if (selectedSession.lastStderrPreview) {
        selectionLines.push(...buildBodyText(width, `stderr: ${selectedSession.lastStderrPreview}`, C, C.bad));
      }
      selectionLines.push(...buildBodyText(width, selectedSession.notes.join(' | '), C, C.dim));
    }

    const sessionLines: Line[] = [];
    if (sessions.length === 0) {
      sessionLines.push(...buildEmptyState(
        width,
        ' No active sandbox sessions.',
        'Select a profile above and press s to start a sandbox session.',
        [],
        C,
      ));
    } else {
      for (const session of sessions) {
        const selectedRow = selectedSession?.id === session.id;
        sessionLines.push(buildAlignedRow(
          width,
          [
            { text: session.profileId, fg: C.info },
            { text: session.state, fg: session.state === 'running' ? C.good : session.state === 'failed' ? C.bad : C.warn },
            { text: session.shared ? 'shared' : 'dedicated', fg: C.value },
            { text: String(session.resolvedBackend ?? session.backend), fg: C.dim },
            { text: session.startupStatus ?? 'n/a', fg: session.startupStatus === 'verified' ? C.good : session.startupStatus === 'failed' ? C.bad : C.warn },
            { text: `${session.executionCount ?? 0}x`, fg: C.info },
            { text: session.id, fg: C.dim },
          ],
          [
            { width: 15 },
            { width: 10 },
            { width: 12 },
            { width: 8 },
            { width: 9 },
            { width: 5, align: 'right' },
            { width: Math.max(8, width - 72) },
          ],
          { selected: selectedRow, selectedBg: C.headerBg },
        ));
      }
    }

    const presetLines: Line[] = [];
    for (const preset of presets.slice(0, 2)) {
      presetLines.push(buildAlignedRow(
        width,
        [
          { text: preset.id, fg: C.info },
          { text: preset.config.replIsolation, fg: C.value },
          { text: preset.config.mcpIsolation, fg: C.dim },
          { text: preset.config.windowsMode, fg: C.warn },
        ],
        [
          { width: 18 },
          { width: 16 },
          { width: 16 },
          { width: Math.max(8, width - 62) },
        ],
        {},
      ));
    }

    const profileLines: Line[] = [];
    for (const profile of profiles) {
      const selectedRow = selectedProfile?.id === profile.id;
      profileLines.push(buildAlignedRow(
        width,
        [
          { text: profile.id, fg: C.info },
          { text: profile.isolation, fg: C.value },
          { text: profile.kind, fg: C.dim },
          { text: `vm=${profile.requiresVm ? 'yes' : 'no'}`, fg: profile.requiresVm ? C.good : C.warn },
        ],
        [
          { width: 15 },
          { width: 14 },
          { width: 12 },
          { width: Math.max(6, width - 53) },
        ],
        { selected: selectedRow, selectedBg: C.headerBg },
      ));
    }
    const postureSection: PanelWorkspaceSection = { title: 'Sandbox posture', lines: overviewLines };
    const selectedSection: PanelWorkspaceSection = { title: selectedProfile ? 'Selected Profile' : 'Selected Session', lines: selectionLines };
    const presetsSection: PanelWorkspaceSection = { title: 'Presets', lines: presetLines };
    const [sessionsSection, profilesSection] = resolveStackedScrollableSections(width, height, {
      intro,
      footerLines: [buildKeyboardHints(width, SANDBOX_HINTS, C)],
      palette: C,
      beforeSections: [
        postureSection,
        ...(selectionLines.length > 0 ? [selectedSection] : []),
      ],
      sections: [
        {
          title: 'Sessions',
          scrollableLines: sessionLines,
          selectedIndex: selectedSession ? Math.max(0, sessions.findIndex((session) => session.id === selectedSession.id)) : undefined,
          scrollOffset: this.sessionsScrollOffset,
          minRows: 2,
          weight: 1,
          appendWindowSummary: sessions.length > 0 ? {
            dimColor: C.dim,
            formatter: (window) => buildPanelLine(width, [[`  [${window.start + 1}-${window.end} of ${sessions.length}]`, C.dim]]),
          } : undefined,
        },
        {
          title: 'Profiles',
          scrollableLines: profileLines,
          selectedIndex: selectedProfile ? Math.max(0, profiles.findIndex((profile) => profile.id === selectedProfile.id)) : undefined,
          scrollOffset: this.profilesScrollOffset,
          minRows: 2,
          weight: 1,
          appendWindowSummary: profiles.length > 0 ? {
            dimColor: C.dim,
            formatter: (window) => buildPanelLine(width, [[`  [${window.start + 1}-${window.end} of ${profiles.length}]`, C.dim]]),
          } : undefined,
        },
      ],
      afterSections: [presetsSection],
    });
    this.sessionsScrollOffset = sessionsSection?.scrollOffset ?? this.sessionsScrollOffset;
    this.profilesScrollOffset = profilesSection?.scrollOffset ?? this.profilesScrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      ...(selectionLines.length > 0 ? [selectedSection] : []),
      sessionsSection?.section ?? { title: 'Sessions', lines: sessionLines },
      presetsSection,
      profilesSection?.section ?? { title: 'Profiles', lines: profileLines },
    ];

    const errorLine = this.renderErrorLine(width);
    if (errorLine) sections.push({ title: 'Error', lines: [errorLine] });

    const lines = buildPanelWorkspace(width, height, {
      title: 'Sandbox Control Room',
      intro,
      sections,
      footerLines: [buildKeyboardHints(width, SANDBOX_HINTS, C)],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
