import type { Line } from '../types/grid.ts';
import { createEmptyLine } from '../types/grid.ts';
import { BasePanel } from './base-panel.ts';
import { getConfigManager, type ConfigManager } from '../config/index.ts';
import { buildSandboxReview, listSandboxPresets, listSandboxProfiles } from '../runtime/sandbox/manager.ts';
import { SandboxSessionRegistry, getSandboxSessionRegistry } from '../runtime/sandbox/session-registry.ts';
import {
  buildBodyText,
  buildEmptyState,
  buildGuidanceLine,
  buildKeyValueLine,
  buildPanelLine,
  buildPanelWorkspace,
  resolveStackedScrollableSections,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#e2e8f0',
  headerBg: '#0f172a',
} as const;

export class SandboxPanel extends BasePanel {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private readonly config: ConfigManager;
  private readonly sessions: SandboxSessionRegistry;

  public constructor(
    config: ConfigManager = getConfigManager(),
    sessions: SandboxSessionRegistry = getSandboxSessionRegistry(),
  ) {
    super('sandbox', 'Sandbox', 'X', 'monitoring');
    this.config = config;
    this.sessions = sessions;
  }

  public handleInput(key: string): boolean {
    const profileCount = listSandboxProfiles(this.config).length;
    const sessionCount = this.sessions.list().length;
    const itemCount = profileCount + sessionCount;
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

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    const review = buildSandboxReview(this.config);
    const profiles = listSandboxProfiles(this.config);
    const presets = listSandboxPresets();
    const sessions = this.sessions.list();
    const selectable = [
      ...profiles.map((profile) => ({ kind: 'profile' as const, id: profile.id })),
      ...sessions.map((session) => ({ kind: 'session' as const, id: session.id })),
    ];
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
      buildGuidanceLine(width, '/sandbox review', 'inspect local vs QEMU posture, host readiness, and isolation defaults', C),
      buildGuidanceLine(width, '/sandbox set-qemu-image <path>', 'set the guest image path before enabling QEMU-backed session execution', C),
      buildGuidanceLine(width, '/sandbox scaffold-qemu-wrapper <path>', 'generate a host-side wrapper scaffold with a bring-up bridge mode and a real guest handoff contract', C),
      buildGuidanceLine(width, '/sandbox set-qemu-wrapper <path>', 'configure the host bridge that actually executes commands inside the QEMU guest', C),
      buildGuidanceLine(width, '/sandbox set-qemu-guest-host <host>', 'switch wrapper-backed execution from host bridge mode to real guest SSH transport', C),
      buildGuidanceLine(width, '/sandbox guest-test <profile>', 'verify SSH guest transport plus workspace projection against the configured QEMU guest host', C),
      buildGuidanceLine(width, '/sandbox wrapper-test <profile>', 'validate the wrapper bridge contract before wiring a real guest transport', C),
      buildGuidanceLine(width, '/sandbox session run <id> <command> [args...]', 'execute through a tracked sandbox session and capture runtime metadata on the session record', C),
      buildGuidanceLine(width, 'GV_SANDBOX_WRAPPER_MODE=host-exec', 'validate the wrapper contract on the host before wiring a real guest transport', C),
      buildPanelLine(width, [[`  Up/Down move  Home/End jump  focus=profiles+sessions`, C.dim]]),
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
        'Start a sandbox session from a profile to make the running VM/session posture visible here.',
        [{ command: '/sandbox session start <profile>', summary: 'start a sandbox session and capture its VM/session record' }],
        C,
      ));
    } else {
      for (const session of sessions) {
        const bg = selectedSession?.id === session.id ? C.headerBg : undefined;
        sessionLines.push(buildPanelLine(width, [
          ['  ', C.label],
          [session.profileId.padEnd(15), C.info, bg],
          [session.state.padEnd(10), session.state === 'running' ? C.good : session.state === 'failed' ? C.bad : C.warn, bg],
          [(session.shared ? 'shared' : 'dedicated').padEnd(12), C.value, bg],
          [String(session.resolvedBackend ?? session.backend).padEnd(8), C.dim, bg],
          [` ${(session.startupStatus ?? 'n/a').slice(0, 8).padEnd(8)}`, session.startupStatus === 'verified' ? C.good : session.startupStatus === 'failed' ? C.bad : C.warn, bg],
          [` ${String(session.executionCount ?? 0).padStart(3)}x`, C.info, bg],
          [` ${session.id.slice(0, Math.max(8, Math.min(14, width - 64)))}`, C.dim, bg],
        ]));
      }
    }

    const presetLines: Line[] = [];
    for (const preset of presets.slice(0, 2)) {
      presetLines.push(buildPanelLine(width, [
        ['  ', C.label],
        [preset.id.padEnd(18), C.info],
        [preset.config.replIsolation.padEnd(16), C.value],
        [preset.config.mcpIsolation.padEnd(16), C.dim],
        [preset.config.windowsMode, C.warn],
      ]));
    }

    const profileLines: Line[] = [];
    for (const profile of profiles) {
      const bg = selectedProfile?.id === profile.id ? C.headerBg : undefined;
      profileLines.push(buildPanelLine(width, [
        ['  ', C.label],
        [profile.id.padEnd(15), C.info, bg],
        [profile.isolation.padEnd(14), C.value, bg],
        [profile.kind.padEnd(12), C.dim, bg],
        [` vm=${profile.requiresVm ? 'yes' : 'no'}`, profile.requiresVm ? C.good : C.warn, bg],
      ]));
    }
    const postureSection: PanelWorkspaceSection = { title: 'Sandbox posture', lines: overviewLines };
    const selectedSection: PanelWorkspaceSection = { title: selectedProfile ? 'Selected Profile' : 'Selected Session', lines: selectionLines };
    const presetsSection: PanelWorkspaceSection = { title: 'Presets', lines: presetLines };
    const [sessionsSection, profilesSection] = resolveStackedScrollableSections(width, height, {
      intro,
      footerLines: [
        buildGuidanceLine(width, '/sandbox presets', 'compare secure, balanced, and shared sandbox operating modes', C),
        buildGuidanceLine(width, '/sandbox apply-preset <id>', 'change local vs QEMU isolation policy without editing config by hand', C),
      ],
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
          scrollOffset: this.scrollOffset,
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
          scrollOffset: this.scrollOffset,
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
    this.scrollOffset = sessionsSection?.scrollOffset ?? this.scrollOffset;

    const sections: PanelWorkspaceSection[] = [
      postureSection,
      ...(selectionLines.length > 0 ? [selectedSection] : []),
      sessionsSection?.section ?? { title: 'Sessions', lines: sessionLines },
      presetsSection,
      profilesSection?.section ?? { title: 'Profiles', lines: profileLines },
    ];

    const lines = buildPanelWorkspace(width, height, {
      title: 'Sandbox Control Room',
      intro,
      sections,
      footerLines: [
        buildGuidanceLine(width, '/sandbox presets', 'compare secure, balanced, and shared sandbox operating modes', C),
        buildGuidanceLine(width, '/sandbox apply-preset <id>', 'change local vs QEMU isolation policy without editing config by hand', C),
      ],
      palette: C,
    });
    while (lines.length < height) lines.push(createEmptyLine(width));
    return lines.slice(0, height);
  }
}
