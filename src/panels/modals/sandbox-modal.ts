import type { ConfigModalAction, ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { buildSandboxReview, listSandboxProfiles } from '@/runtime/index.ts';
import type { SandboxProfile, SandboxSession, SandboxSessionRegistry } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { toneStyle, statusGlyph, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

/** SandboxSessionRegistry has no event subscription, poll at the same 3s
 *  cadence the retired panel used (POLL_INTERVAL_MS in sandbox-panel.ts). */
const POLL_INTERVAL_MS = 3_000;

function sessionTone(state: SandboxSession['state']): Tone {
  switch (state) {
    case 'running': return 'good';
    case 'failed': return 'bad';
    case 'planned': return 'warn';
    case 'stopped': return 'dim';
    default: return 'dim';
  }
}

function profileIdOf(row: ConfigModalRow | null): SandboxProfile['id'] | null {
  return row?.id.startsWith('profile:') ? (row.id.slice('profile:'.length) as SandboxProfile['id']) : null;
}

function sessionIdOf(row: ConfigModalRow | null): string | null {
  return row?.id.startsWith('session:') ? row.id.slice('session:'.length) : null;
}

/**
 * Sandbox config-modal surface (migrated from the `sandbox` panel). All reads
 * (buildSandboxReview, listSandboxProfiles, sessions.list) are synchronous, so
 * buildView reads them live each tick. The panel's single profile+session
 * selectable list becomes two real tabs. s/x/e call the SandboxSessionRegistry
 * directly (these were never slash commands), start/execute are wrapped so a
 * rejection surfaces via ctx.setStatus instead of an unhandled rejection,
 * matching the panel's try/catch + setError behaviour.
 */
class SandboxModalSurface implements ConfigModalSurface {
  readonly name = 'sandbox-modal';
  readonly title = 'Sandbox';
  private requestRender: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: ConfigManager,
    private readonly sessions: SandboxSessionRegistry,
    requestRender: () => void = () => {},
  ) {
    this.requestRender = requestRender;
  }

  readonly actions: ConfigModalAction[] = [
    { key: 's', id: 'start', label: 'start', enabledFor: (row, tabId) => tabId === 'profiles' && profileIdOf(row) !== null },
    { key: 'x', id: 'stop', label: 'stop', confirm: true, enabledFor: (row, tabId) => tabId === 'sessions' && sessionIdOf(row) !== null },
    { key: 'e', id: 'execute', label: 'execute probe', enabledFor: (row, tabId) => tabId === 'sessions' && sessionIdOf(row) !== null },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (this.timer === null) this.timer = setInterval(() => this.requestRender(), POLL_INTERVAL_MS);
  }

  onClose(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  buildView(): ConfigModalView {
    try {
      const review = buildSandboxReview(this.config);
      const profiles = listSandboxProfiles(this.config);
      const sessions = this.sessions.list();

      const header = [postureLine([
        kv('platform', review.host.platform),
        kv('backend', review.config.vmBackend),
        kv('sessions', sessions.length),
        kv('ready', review.host.secureSandboxReady ? 'yes' : 'no'),
      ])];

      const profileRows: ConfigModalRow[] = profiles.map((profile) => ({
        id: `profile:${profile.id}`,
        label: `${pad(profile.id, 14)} ${pad(profile.kind, 6)} ${pad(profile.isolation, 10)} vm=${profile.requiresVm ? 'yes' : 'no'}`,
      }));

      const sessionRows: ConfigModalRow[] = sessions.map((session) => ({
        id: `session:${session.id}`,
        label: `${statusGlyph(sessionTone(session.state))} ${pad(session.id, 20)} ${pad(session.state.toUpperCase(), 9)} backend=${pad(session.resolvedBackend ?? session.backend, 6)} runs=${session.executionCount ?? 0}`,
        style: toneStyle(sessionTone(session.state)),
      }));

      return {
        title: 'Sandbox',
        tabs: [
          { id: 'profiles', label: 'Profiles', header, rows: profileRows, emptyText: 'No sandbox profiles available.', hints: ['s start'] },
          { id: 'sessions', label: 'Sessions', header, rows: sessionRows, emptyText: 'No active sandbox sessions.', hints: ['x stop', 'e execute probe'] },
        ],
      };
    } catch (error) {
      return {
        title: 'Sandbox',
        degraded: `Sandbox posture unavailable: ${summarizeError(error)}`,
        tabs: [
          { id: 'profiles', label: 'Profiles', rows: [] },
          { id: 'sessions', label: 'Sessions', rows: [] },
        ],
      };
    }
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    switch (id) {
      case 'start': {
        const profileId = profileIdOf(ctx.row);
        if (!profileId) return;
        void this.sessions.start(profileId, undefined, this.config)
          .catch((error: unknown) => ctx.setStatus(summarizeError(error)))
          .finally(() => this.requestRender());
        return;
      }
      case 'stop': {
        const sessionId = sessionIdOf(ctx.row);
        if (!sessionId) return;
        this.sessions.stop(sessionId);
        break;
      }
      case 'execute': {
        const sessionId = sessionIdOf(ctx.row);
        if (!sessionId) return;
        try {
          this.sessions.execute(sessionId, process.execPath, ['-e', "console.log('sandbox modal probe ok')"], this.config, { timeoutMs: 5_000 });
        } catch (error) {
          ctx.setStatus(summarizeError(error));
        }
        break;
      }
      default:
        return;
    }
    this.requestRender();
  }
}

export function createSandboxModalSurface(
  config: ConfigManager,
  sessions: SandboxSessionRegistry,
  requestRender: () => void = () => {},
): ConfigModalSurface {
  return new SandboxModalSurface(config, sessions, requestRender);
}
