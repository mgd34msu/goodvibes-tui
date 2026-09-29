/**
 * status-report.ts, what /status prints.
 *
 * The main screen keeps only the composer and one status line; the rows that
 * used to sit under the composer (token totals, context use, working
 * directory, model and provider, tool count, notification mode, the session
 * spine and the web surface address) are reported here in full, next to the
 * safety states that also stay visible on the composer.
 */

import { abbreviateCount } from '../utils/format-number.ts';
import { permissionModeLabel } from '../core/permission-mode.ts';

export interface StatusReportSource {
  readonly workingDirectory: string;
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly model: string;
  readonly provider?: string;
  /** Failover marker while serving differs from the configured model. */
  readonly modelNote?: string;
  readonly permissionMode?: string;
  readonly toolCount: number;
  readonly notifyMode?: string;
  readonly usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  /** Formatted cost ("$0.246", "you $0.25 · fleet $0.47"), null when unpriced. */
  readonly cost: string | null;
  readonly contextTokens: number;
  readonly contextWindow: number;
  /** Compaction threshold as a fraction. */
  readonly compactFraction: number;
  readonly sessionSpine?: 'online' | 'offline';
  readonly webSurfaceUrl?: string;
  readonly autoApprove: boolean;
  readonly keepAwake: boolean;
  /** Short microphone state, null when no microphone is open. */
  readonly microphone: string | null;
  readonly runningAgents: number;
  readonly runningProcesses: number;
}

function n(value: number): string {
  return abbreviateCount(value, { bSuffix: true });
}

export function formatStatusReport(s: StatusReportSource): string {
  const lines: string[] = [];
  const row = (label: string, value: string): void => { lines.push(`  ${label.padEnd(12)} ${value}`); };
  lines.push('Session');
  row('directory', `${s.workingDirectory}${s.branch ? ` (${s.branch}${s.dirty ? ', uncommitted changes' : ''})` : ''}`);
  row('model', `${s.model}${s.provider ? ` (${s.provider})` : ''}${s.modelNote ? ` · ${s.modelNote}` : ''}`);
  row('mode', permissionModeLabel(s.permissionMode));
  row('tools', String(s.toolCount));
  if (s.notifyMode) row('notify', s.notifyMode);
  lines.push('Tokens');
  const total = s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite;
  row('input', s.usage.input > 0 ? n(s.usage.input) : '—');
  row('output', n(s.usage.output));
  row('cache read', n(s.usage.cacheRead));
  row('cache write', n(s.usage.cacheWrite));
  row('total', n(total));
  row('cost', s.cost ?? 'n/a (model not priced)');
  lines.push('Context');
  if (s.contextWindow > 0) {
    const pct = Math.round(Math.min(1, s.contextTokens / s.contextWindow) * 100);
    row('used', `${s.contextTokens > 0 ? n(s.contextTokens) : '—'} / ${n(s.contextWindow)} (${pct}%)`);
    row('compacts at', `${Math.round(s.compactFraction * 100)}%`);
  } else {
    row('used', `${s.contextTokens > 0 ? n(s.contextTokens) : '—'} / unknown (nothing states this model's context window)`);
  }
  lines.push('Surfaces');
  row('spine', s.sessionSpine ?? 'local only');
  row('web', s.webSurfaceUrl ?? 'off');
  lines.push('Safety');
  row('auto-approve', s.autoApprove ? 'ON: every change is approved automatically' : 'off');
  row('sleep', s.keepAwake ? 'disabled (keep-awake is on)' : 'allowed');
  row('microphone', s.microphone ?? 'closed');
  lines.push('Background');
  row('agents', String(s.runningAgents));
  row('processes', String(s.runningProcesses));
  return lines.join('\n');
}
