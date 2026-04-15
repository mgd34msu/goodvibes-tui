import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';
import { BasePanel } from './base-panel.ts';
import { buildGuidanceLine, buildPanelLine, buildPanelWorkspace, DEFAULT_PANEL_PALETTE } from './polish.ts';

const C = {
  ...DEFAULT_PANEL_PALETTE,
  header: '#f8fafc',
  headerBg: '#1e293b',
  label: '#93c5fd',
  good: '#22c55e',
  empty: '#475569',
} as const;

export class WelcomePanel extends BasePanel {
  public constructor() {
    super('welcome', 'Welcome', 'W', 'monitoring');
  }

  public render(width: number, height: number): Line[] {
    this.needsRender = false;
    return buildPanelWorkspace(width, height, {
      title: 'Welcome To GoodVibes',
      intro: 'Local-first operator shell for setup, trust, orchestration, ecosystem, and self-hosted remote work.',
      palette: C,
      sections: [
        {
          lines: [buildGuidanceLine(width, '/cockpit', 'open the unified control room first if you want a complete runtime overview', C)],
        },
        {
          title: 'Quick Start',
          lines: [
            buildGuidanceLine(width, '/setup onboarding', 'first-run checklist, doctor, and environment posture', C),
            buildGuidanceLine(width, '/login provider <name> start', 'begin a supported provider auth flow from the product front door', C),
            buildGuidanceLine(width, '/subscription', 'review stored provider sessions and active subscription-backed routes', C),
            buildGuidanceLine(width, '/sandbox review', 'inspect VM isolation posture, presets, and Windows/WSL mode', C),
          ],
        },
        {
          title: 'Operate',
          lines: [
            buildGuidanceLine(width, '/marketplace open', 'browse curated plugins, skills, hook packs, and policy packs', C),
            buildGuidanceLine(width, '/remote-setup', 'review bridge, tunnel, env, bootstrap, and runner-pool flows', C),
            buildGuidanceLine(width, '/runner-pool list', 'inspect remote runner pools and dispatch posture', C),
            buildGuidanceLine(width, '/teleport export <path>', 'package a portable remote-session handoff bundle', C),
            buildGuidanceLine(width, '/security', 'review trust posture, approval pressure, and incidents', C),
            buildGuidanceLine(width, '/cockpit', 'open the unified operator control room', C),
          ],
        },
        {
          title: 'Advanced',
          lines: [
            buildGuidanceLine(width, '/hooks', 'author, simulate, and import hook workflows', C),
            buildGuidanceLine(width, '/memory-review queue', 'review project and team memory, handoffs, and evidence', C),
            buildGuidanceLine(width, '/team-memory export <path>', 'package a team handoff bundle for shared-memory transfer', C),
            buildGuidanceLine(width, '/release checklist', 'run certification checks and export evidence bundles', C),
          ],
        },
      ],
      footerLines: [
        buildPanelLine(width, [['  This surface stays intentionally short so the real control rooms stay authoritative.', C.good]]),
      ],
    });
  }
}
