/**
 * Pure formatters for the `/health metrics` surface (daemon runtime.metrics.get
 * and quota.snapshot.get). Kept separate from the command wiring so the honesty
 * bars are unit-testable without a live daemon: scope refusals are named, empty
 * maps say "none reported" rather than showing zeros, and an unobserved quota
 * renders as an explicit "no signal yet" instead of a fabricated full quota.
 */
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';

/** Cap on how many entries of a single metric map we list before summarizing the rest. */
export const METRIC_MAP_LIST_CAP = 40;

/** Render one runtime-metric map as an indented `key: value` block, honestly capped. */
export function renderMetricMap(label: string, map: Record<string, unknown> | undefined): string[] {
  const entries = Object.entries(map ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [`  ${label}: none reported`];
  const lines = [`  ${label}: ${entries.length}`];
  for (const [key, value] of entries.slice(0, METRIC_MAP_LIST_CAP)) {
    const rendered = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    const trimmed = rendered.length > 120 ? `${rendered.slice(0, 117)}...` : rendered;
    lines.push(`    ${key}: ${trimmed}`);
  }
  if (entries.length > METRIC_MAP_LIST_CAP) {
    lines.push(`    (+${entries.length - METRIC_MAP_LIST_CAP} more)`);
  }
  return lines;
}

/**
 * When a telemetry verb fails because the companion token lacks the required
 * scope, say exactly that, never render zeros in place of missing authority.
 * Returns the honest line, or null when the error is not a scope refusal.
 */
export function telemetryScopeRefusalLine(error: unknown, what: string): string | null {
  if (error instanceof GoodVibesSdkError && (error.status === 401 || error.status === 403)) {
    return `  ${what}: unavailable; the companion token lacks the read:telemetry scope this data requires (daemon returned ${error.status}).`;
  }
  return null;
}

/** The shape of quota.snapshot.get we render (a superset-safe subset of the SDK type). */
export interface QuotaSnapshotView {
  readonly hasSignal: boolean;
  readonly remaining?: number | undefined;
  readonly limit?: number | undefined;
  readonly resetAt?: number | undefined;
  readonly activeCooldownMs?: number | undefined;
  readonly recentRateLimitCount: number;
}

/**
 * Render the remaining-quota line for a provider. `hasSignal:false` becomes an
 * explicit "no rate-limit signal observed yet", never zeros or a full quota.
 */
export function formatQuotaSnapshotLine(provider: string, quota: QuotaSnapshotView): string {
  if (!quota.hasSignal) {
    return `  quota (${provider}): no rate-limit signal observed yet (${quota.recentRateLimitCount} recent rate-limit event(s)).`;
  }
  const parts: string[] = [];
  if (quota.remaining !== undefined) {
    parts.push(`remaining ${quota.remaining}${quota.limit !== undefined ? `/${quota.limit}` : ''}`);
  }
  if (quota.resetAt !== undefined) parts.push(`resets ${new Date(quota.resetAt).toISOString()}`);
  if (quota.activeCooldownMs !== undefined && quota.activeCooldownMs > 0) parts.push(`cooldown ${quota.activeCooldownMs}ms`);
  parts.push(`${quota.recentRateLimitCount} recent rate-limit event(s)`);
  return `  quota (${provider}): ${parts.join(', ')}.`;
}
