import type { ConfigModalAction, ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import { getSettingsControlPlaneSnapshot } from '@/runtime/index.ts';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { toneStyle, pad, postureLine, kv, type Tone } from './modal-surface-helpers.ts';

type Snapshot = ReturnType<typeof getSettingsControlPlaneSnapshot>;

function sourceTone(source: string, conflict: boolean, locked: boolean): Tone {
  if (conflict) return 'bad';
  if (locked || source === 'managed') return 'warn';
  if (source === 'synced') return 'good';
  if (source === 'local') return 'info';
  return 'dim';
}

/**
 * Settings-sync config-modal surface (migrated from the `settings-sync` panel).
 * All reads are synchronous (getSettingsControlPlaneSnapshot). The panel's six
 * Tab-cycled browse modes become six real tabs. Conflict resolution keeps the
 * panel's two-step shape: Enter on a conflicted key arms a resolve prompt, then
 * l/s dispatch the existing `/settings-sync resolve <key> <local|synced>`
 * command (the command owns the mutation + live-session refresh). `m` dispatches
 * `/managed review`. push/pull remain CLI-only (they were never panel actions).
 */
class SettingsSyncModalSurface implements ConfigModalSurface {
  readonly name = 'settings-sync-modal';
  readonly title = 'Settings Sync';
  private requestRender: () => void = () => {};
  /** Conflicted key awaiting an l/s choice (surface-managed sub-flow). */
  private resolvePrompt: string | null = null;
  private conflictedKeys = new Set<string>();
  private hasStaged = false;

  constructor(private readonly configManager: ConfigManager) {}

  readonly actions: ConfigModalAction[] = [
    { key: 'enter', id: 'resolve-open', label: 'resolve conflict', enabledFor: (row, tab) => tab === 'keys' && this.isConflicted(row) && this.resolvePrompt === null },
    { key: 'l', id: 'resolve-local', label: 'keep local', enabledFor: () => this.resolvePrompt !== null },
    { key: 's', id: 'resolve-synced', label: 'use synced', enabledFor: () => this.resolvePrompt !== null },
    { key: 'n', id: 'resolve-cancel', label: 'cancel', enabledFor: () => this.resolvePrompt !== null },
    { key: 'm', id: 'managed-review', label: 'managed review', enabledFor: () => this.hasStaged },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    this.resolvePrompt = null;
  }

  onClose(): void {
    this.resolvePrompt = null;
  }

  private isConflicted(row: ConfigModalRow | null): boolean {
    return !!row && row.id.startsWith('key:') && this.conflictedKeys.has(row.id.slice('key:'.length));
  }

  buildView(): ConfigModalView {
    const s = this.configManager ? this.trySnapshot() : null;
    if (!s) {
      return { title: 'Settings Sync', degraded: 'settings control plane unavailable', tabs: [{ id: 'keys', label: 'Keys', rows: [] }] };
    }
    this.conflictedKeys = new Set(s.conflicts.map((c) => c.key));
    this.hasStaged = Boolean(s.stagedManagedBundle);

    const header = [
      postureLine([kv('resolved', s.resolvedEntries.length), kv('conflicts', s.conflicts.length), kv('failures', s.recentFailures.length), kv('locks', s.managedLockCount)]),
      postureLine([kv('local', s.resolvedCounts.local), kv('synced', s.resolvedCounts.synced), kv('managed', s.resolvedCounts.managed), kv('last-sync', s.lastSync ? `${s.lastSync.surface}/${s.lastSync.direction}` : 'none'), kv('staged', s.stagedManagedBundle ? s.stagedManagedBundle.profileName : 'none')]),
    ];

    const keysRows: ConfigModalRow[] = s.resolvedEntries.map((e) => ({
      id: `key:${e.key}`,
      label: `${pad(e.key, 32)} ${pad(String(e.effectiveSource), 10)} ${String(e.effectiveValue)}`,
      style: toneStyle(sourceTone(String(e.effectiveSource), Boolean(e.conflict), Boolean(e.locked))),
    }));

    const eventRows: ConfigModalRow[] = s.recentEvents.map((ev, i) => ({ id: `event:${i}`, label: `${pad(`${ev.surface}/${ev.direction}`, 18)} ${ev.detail}`, style: toneStyle('info') }));
    const lockRows: ConfigModalRow[] = s.managedLocks.map((l) => ({ id: `lock:${l.key}`, label: `${pad(l.key, 30)} source=${pad(l.source, 12)} ${l.reason}`, style: toneStyle('warn') }));
    const failureRows: ConfigModalRow[] = s.recentFailures.map((f, i) => ({ id: `failure:${i}`, label: `${pad(f.surface, 10)} ${f.message}`, style: toneStyle('bad') }));
    const conflictRows: ConfigModalRow[] = s.conflicts.map((c) => ({ id: `conflict:${c.key}`, label: `${pad(c.key, 30)} ${pad(c.source, 10)} local=${String(c.localValue)} incoming=${String(c.incomingValue)}`, style: toneStyle('warn') }));
    const rollbackRows: ConfigModalRow[] = s.rollbackHistory.map((r) => ({ id: `rollback:${r.token}`, label: `${pad(r.token, 18)} ${pad(r.profileName, 18)} restored=${r.restoredKeys.length}  ${new Date(r.appliedAt).toLocaleString()}`, style: toneStyle('dim') }));

    const keyHints = this.resolvePrompt
      ? [`resolving "${this.resolvePrompt}"`, 'l keep local', 's use synced', 'n cancel']
      : ['Enter resolve conflict', 'm managed review'];

    return {
      title: 'Settings Sync',
      hints: ['←/→ tab'],
      tabs: [
        { id: 'keys', label: 'Keys', header, rows: keysRows, emptyText: 'No resolved settings entries.', hints: keyHints },
        { id: 'events', label: 'Events', header, rows: eventRows, emptyText: 'No sync or managed-setting events recorded yet.' },
        { id: 'locks', label: 'Locks', header, rows: lockRows, emptyText: 'No managed locks are currently active.' },
        { id: 'failures', label: 'Failures', header, rows: failureRows, emptyText: 'No recent sync or managed-setting failures.' },
        { id: 'conflicts', label: 'Conflicts', header, rows: conflictRows, emptyText: 'No settings conflicts detected.' },
        { id: 'rollback', label: 'Rollback', header, rows: rollbackRows, emptyText: 'No managed rollback records yet.' },
      ],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    switch (id) {
      case 'resolve-open': {
        const key = ctx.row?.id.startsWith('key:') ? ctx.row.id.slice('key:'.length) : null;
        if (key && this.conflictedKeys.has(key)) {
          this.resolvePrompt = key;
          ctx.setStatus(`Resolve "${key}": l keep local · s use synced · n cancel`);
        }
        break;
      }
      case 'resolve-local':
      case 'resolve-synced': {
        if (!this.resolvePrompt) break;
        const choice = id === 'resolve-local' ? 'local' : 'synced';
        void ctx.executeCommand?.('settings-sync', ['resolve', this.resolvePrompt, choice]);
        ctx.setStatus(`Resolving ${this.resolvePrompt} → ${choice}…`);
        this.resolvePrompt = null;
        break;
      }
      case 'resolve-cancel':
        this.resolvePrompt = null;
        ctx.setStatus('');
        break;
      case 'managed-review':
        void ctx.executeCommand?.('managed', ['review']);
        ctx.setStatus('Opening managed review…');
        break;
    }
    this.requestRender();
  }

  private trySnapshot(): Snapshot | null {
    try {
      return getSettingsControlPlaneSnapshot(this.configManager);
    } catch {
      return null;
    }
  }
}

export function createSettingsSyncModalSurface(configManager: ConfigManager): ConfigModalSurface {
  return new SettingsSyncModalSurface(configManager);
}
