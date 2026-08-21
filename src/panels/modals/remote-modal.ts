import type { ConfigModalActionContext, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { UiReadModel, UiRemoteSnapshot } from '../../runtime/ui-read-models.ts';
import { toneStyle, statusGlyph, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

function stateTone(state: string): Tone {
  switch (state) {
    case 'connected':
    case 'syncing':
      return 'good';
    case 'degraded':
    case 'reconnecting':
    case 'authenticating':
    case 'initializing':
      return 'warn';
    case 'terminal_failure':
      return 'bad';
    default:
      return 'dim';
  }
}

/**
 * Remote config-modal surface (migrated from the `remote` panel). The read-model
 * snapshot is synchronous; a subscribe() keeps live transport/heartbeat values
 * refreshing between key presses. The panel's `Tab` connections/contracts browse
 * toggle becomes two real tabs. `r`/Enter dispatch `/remote recover` for the
 * selected runner, the panel's only corrective keybinding; the richer
 * `/remote` command set (show/supervisor/cancel/dispatch/artifact/…) stays on
 * the command front-door.
 */
class RemoteModalSurface implements ConfigModalSurface {
  readonly name = 'remote-modal';
  readonly title = 'Remote';
  private requestRender: () => void = () => {};
  private unsub: (() => void) | null = null;

  constructor(private readonly readModel?: UiReadModel<UiRemoteSnapshot>) {}

  readonly actions = [
    { key: 'r', id: 'recover', label: 'recover' },
    { key: 'enter', id: 'recover', label: 'recover' },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    if (this.readModel && !this.unsub) this.unsub = this.readModel.subscribe(() => this.requestRender());
  }

  onClose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  buildView(): ConfigModalView {
    const snapshot = this.readModel?.getSnapshot();
    if (!snapshot) {
      return {
        title: 'Remote',
        degraded: 'Runtime store not wired into this runtime.',
        tabs: [{ id: 'connections', label: 'Connections', rows: [], emptyText: 'Try /remote setup.' }],
      };
    }
    const { daemon, acp, contracts, artifacts, supervisor, distributed } = snapshot;
    const peersConnected = distributed.peers.filter((p) => p.status === 'connected').length;
    const header = [
      postureLine([
        `daemon ${daemon.transportState.toUpperCase()}`,
        kv('running', daemon.isRunning ? 'yes' : 'no'),
        kv('reconnects', daemon.reconnectAttempts),
        kv('jobs', daemon.runningJobCount),
      ]),
      postureLine([
        `acp ${acp.transportState.toUpperCase()}`,
        kv('conns', acp.activeConnections.length),
        kv('contracts', contracts.length),
        kv('artifacts', artifacts.length),
        kv('sessions', supervisor.sessions.length),
        kv('peers', `${peersConnected}/${distributed.peers.length}`),
      ]),
    ];

    const connectionRows = acp.activeConnections.map((c) => ({
      id: `conn:${c.agentId}`,
      label: `${statusGlyph(stateTone(c.transportState))} ${pad(c.agentId, 20)} ${pad(c.transportState.toUpperCase(), 14)} msgs=${c.messageCount} errs=${c.errorCount}  ${c.label ?? ''}`,
      style: toneStyle(stateTone(c.transportState)),
    }));

    const contractRows = contracts.map((ct) => ({
      id: `contract:${ct.runnerId}`,
      label: `${statusGlyph(stateTone(ct.transport.state))} ${pad(ct.runnerId, 20)} ${pad(ct.transport.state.toUpperCase(), 14)} ${ct.template ?? ''}`,
      style: toneStyle(stateTone(ct.transport.state)),
    }));

    return {
      title: 'Remote',
      tabs: [
        { id: 'connections', label: 'Connections', header, rows: connectionRows, emptyText: 'No active ACP or remote subagent connections.', hints: ['r recover'] },
        { id: 'contracts', label: 'Contracts', header, rows: contractRows, emptyText: 'No registered remote runner contracts.', hints: ['r recover'] },
      ],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id !== 'recover') return;
    const rowId = ctx.row?.id ?? '';
    const runner = rowId.includes(':') ? rowId.slice(rowId.indexOf(':') + 1) : '';
    void ctx.executeCommand?.('remote', runner ? ['recover', runner] : ['recover']);
    ctx.setStatus(runner ? `Recovering ${runner}…` : 'Recovering…');
    this.requestRender();
  }
}

export function createRemoteModalSurface(readModel?: UiReadModel<UiRemoteSnapshot>): ConfigModalSurface {
  return new RemoteModalSurface(readModel);
}
