// ---------------------------------------------------------------------------
// provider-health-views.ts
//
// Pure Line[] builders for the provider console (WO-112). The panel owns
// state, subscriptions, and section composition; this module owns turning
// console data into rows: posture summary, fallback chain, provider metrics
// table (absorbed from the retired providers/stats panel), per-route auth
// detail (absorbed from the retired accounts panel), repair domains, and
// session maintenance. No hardcoded hex — tones arrive from the panel's
// extendPalette result.
// ---------------------------------------------------------------------------

import type { Line } from '../types/grid.ts';
import { formatLatencyMs } from '../utils/format-duration.ts';
import type { ProviderStatus, ProviderHealth } from './provider-health-tracker.ts';
import type {
  ProviderAccountPosture,
  ProviderPanelAuthFreshness,
  ProviderPanelAuthRoute,
} from './provider-health-routes.ts';
import type { FallbackChainData, ProviderHealthEntry } from '../runtime/ui/provider-health/index.ts';
import type { HealthDomainSummary } from './provider-health-domains.ts';
import {
  buildAlignedRow,
  buildBodyText,
  buildDetailBlock,
  buildKeyValueLine,
  DEFAULT_PANEL_PALETTE,
  type PanelWorkspaceSection,
} from './polish.ts';

/** Extended palette produced by the panel's extendPalette call. */
export type ProviderConsoleTones = typeof DEFAULT_PANEL_PALETTE & {
  readonly title: string;
  readonly unknown: string;
  readonly rowSelectBg: string;
};

type Palette = typeof DEFAULT_PANEL_PALETTE;

const LATENCY_WARN_MS = 2_000;
const LATENCY_BAD_MS  = 5_000;
const SPARKLINE_CHARS = '._-:=+*#';
const SPARKLINE_WIDTH = 12;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function statusDot(tones: ProviderConsoleTones, status: ProviderStatus): { char: string; color: string } {
  switch (status) {
    case 'healthy':      return { char: '●', color: tones.good };
    case 'degraded':     return { char: '◑', color: tones.warn };
    case 'rate_limited': return { char: '◐', color: tones.warn };
    case 'auth_error':   return { char: '✕', color: tones.bad };
    case 'unavailable':  return { char: '✕', color: tones.bad };
    default:             return { char: '○', color: tones.unknown };
  }
}

export function statusLabel(status: ProviderStatus): string {
  switch (status) {
    case 'healthy':      return 'online';
    case 'degraded':     return 'degraded';
    case 'rate_limited': return 'rate-limited';
    case 'auth_error':   return 'auth error';
    case 'unavailable':  return 'unavailable';
    default:             return 'unknown';
  }
}

export function latencyColor(tones: ProviderConsoleTones, ms: number): string {
  if (ms >= LATENCY_BAD_MS)  return tones.bad;
  if (ms >= LATENCY_WARN_MS) return tones.warn;
  return tones.good;
}

export function fmtMs(ms: number): string {
  return formatLatencyMs(ms);
}

export function fmtAgo(ts: number | undefined): string {
  if (!ts) return 'n/a';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)  return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export function fmtCooldown(expiresAt: number): string {
  const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
  if (remaining <= 0) return 'expiring';
  return `${remaining}s cooldown`;
}

export function fmtTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function fmtUsd(value: number): string {
  if (value <= 0) return '$0';
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(3)}`;
}

export function buildSparkline(points: readonly { readonly avgLatencyMs: number }[]): string {
  if (points.length === 0) return ' '.repeat(SPARKLINE_WIDTH);
  const values = points.slice(-SPARKLINE_WIDTH).map((point) => point.avgLatencyMs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const chars = values.map((value) => {
    const idx = Math.min(
      SPARKLINE_CHARS.length - 1,
      Math.floor(((value - min) / range) * (SPARKLINE_CHARS.length - 1)),
    );
    return SPARKLINE_CHARS[idx] ?? '.';
  });
  while (chars.length < SPARKLINE_WIDTH) chars.unshift(' ');
  return chars.join('');
}

export function domainColor(tones: ProviderConsoleTones, level: HealthDomainSummary['level']): string {
  switch (level) {
    case 'good':
      return tones.good;
    case 'warn':
      return tones.warn;
    case 'bad':
      return tones.bad;
    default:
      return tones.value;
  }
}

export function routeColor(tones: ProviderConsoleTones, route: ProviderPanelAuthRoute): string {
  switch (route) {
    case 'subscription-oauth':
      return tones.title;
    case 'service-oauth':
      return tones.good;
    case 'api-key':
      return tones.warn;
    case 'secret-ref':
      return tones.value;
    case 'anonymous':
    case 'none':
      return tones.dim;
    default:
      return tones.value;
  }
}

export function freshnessColor(tones: ProviderConsoleTones, freshness: ProviderPanelAuthFreshness): string {
  switch (freshness) {
    case 'expired':
      return tones.bad;
    case 'expiring':
    case 'pending':
      return tones.warn;
    case 'healthy':
      return tones.good;
    default:
      return tones.dim;
  }
}

// ---------------------------------------------------------------------------
// Posture summary
// ---------------------------------------------------------------------------

export interface ConsolePostureInput {
  readonly providers: readonly string[];
  readonly entriesById: ReadonlyMap<string, ProviderHealthEntry>;
  readonly accounts: ReadonlyMap<string, ProviderAccountPosture>;
  readonly trackerRecords: readonly ProviderHealth[];
  readonly compositeStatus: string;
  readonly falloverCount: number;
  readonly activeProvider: string | undefined;
  /** Present when domains/maintenance render collapsed (non-domains views). */
  readonly collapsedDomains?: {
    readonly attention: number;
    readonly maintenanceLevel: string;
  };
  readonly unattributedError: string | null;
}

export function buildPostureLines(
  width: number,
  tones: ProviderConsoleTones,
  palette: Palette,
  input: ConsolePostureInput,
): Line[] {
  let online = 0;
  let rateLimited = 0;
  let errored = 0;
  let accountIssues = 0;
  let expiringAuth = 0;
  for (const name of input.providers) {
    const status = input.entriesById.get(name)?.status ?? 'unknown';
    if (status === 'healthy') online++;
    else if (status === 'rate_limited') rateLimited++;
    else if (status === 'degraded' || status === 'auth_error' || status === 'unavailable') errored++;
    const account = input.accounts.get(name);
    if (account) {
      accountIssues += account.issues.length;
      if (account.expiringSoon) expiringAuth++;
    }
  }

  let totalRequests = 0;
  let totalErrors = 0;
  let totalTokens = 0;
  let totalCost = 0;
  for (const health of input.trackerRecords) {
    totalRequests += health.requests;
    totalErrors += health.errors;
    totalTokens += health.totalTokens;
    totalCost += health.totalCostUsd;
  }

  const lines: Line[] = [
    buildKeyValueLine(width, [
      { label: 'providers', value: String(input.providers.length), valueColor: tones.value },
      { label: 'online', value: String(online), valueColor: tones.good },
      { label: 'rate-limited', value: String(rateLimited), valueColor: rateLimited > 0 ? tones.warn : tones.dim },
      { label: 'error', value: String(errored), valueColor: errored > 0 ? tones.bad : tones.dim },
      { label: 'composite', value: input.compositeStatus, valueColor: input.compositeStatus === 'healthy' ? tones.good : input.compositeStatus === 'degraded' ? tones.warn : input.compositeStatus === 'critical' ? tones.bad : tones.dim },
    ], palette),
    buildKeyValueLine(width, [
      { label: 'requests', value: String(totalRequests), valueColor: tones.value },
      { label: 'errors', value: String(totalErrors), valueColor: totalErrors > 0 ? tones.bad : tones.good },
      { label: 'tokens', value: fmtTokens(totalTokens), valueColor: tones.value },
      { label: 'cost', value: fmtUsd(totalCost), valueColor: tones.value },
      { label: 'fallovers', value: String(input.falloverCount), valueColor: input.falloverCount > 0 ? tones.warn : tones.dim },
    ], palette),
    buildKeyValueLine(width, [
      { label: 'active', value: input.activeProvider ?? 'n/a', valueColor: tones.title },
      { label: 'auth alerts', value: String(expiringAuth), valueColor: expiringAuth > 0 ? tones.warn : tones.dim },
      { label: 'account issues', value: String(accountIssues), valueColor: accountIssues > 0 ? tones.bad : tones.dim },
    ], palette),
  ];

  if (input.collapsedDomains) {
    const { attention, maintenanceLevel } = input.collapsedDomains;
    lines.push(buildKeyValueLine(width, [
      { label: 'repair domains', value: attention > 0 ? `${attention} need attention` : 'all clear', valueColor: attention > 0 ? tones.warn : tones.good },
      { label: 'maintenance', value: maintenanceLevel, valueColor: maintenanceLevel === 'needs-repair' ? tones.bad : maintenanceLevel === 'suggest-compact' || maintenanceLevel === 'watch' ? tones.warn : tones.good },
      { label: 'detail', value: 'press t for domains view', valueColor: tones.dim },
    ], palette));
  }

  if (input.unattributedError) {
    lines.push(...buildBodyText(width, `Last turn error (no provider registered): ${input.unattributedError}`, palette, tones.bad));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

export function buildChainLines(
  width: number,
  tones: ProviderConsoleTones,
  palette: Palette,
  chain: FallbackChainData,
): Line[] {
  if (!chain.nodes.some((node) => node.providerId && node.providerId !== 'unknown')) return [];
  const lines: Line[] = [];
  for (const node of chain.nodes) {
    const dot = statusDot(tones, node.providerStatus);
    lines.push(buildAlignedRow(
      width,
      [
        { text: node.isCurrent ? '▸' : ' ', fg: tones.title },
        { text: `#${node.position}`, fg: tones.dim },
        { text: node.displayName, fg: node.isCurrent ? tones.title : tones.value, bold: node.isCurrent },
        { text: statusLabel(node.providerStatus), fg: dot.color },
        { text: node.reason ?? (node.position === 0 ? 'primary' : 'fallback'), fg: tones.dim },
      ],
      [
        { width: 2 },
        { width: 3 },
        { width: Math.max(18, width - 52) },
        { width: 13 },
        { width: 16 },
      ],
    ));
  }
  if (chain.hasUnhealthyNode) {
    lines.push(...buildBodyText(width, 'At least one chain node is unhealthy — fallback may engage on the next turn.', palette, tones.warn));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Provider metrics table
// ---------------------------------------------------------------------------

export const PROVIDER_TABLE_COLUMNS = [
  { width: 16 },
  { width: 12 },
  { width: 7, align: 'right' as const },
  { width: 7, align: 'right' as const },
  { width: 5, align: 'right' as const },
  { width: SPARKLINE_WIDTH + 1 },
  { width: 8, align: 'right' as const },
  { width: 9, align: 'right' as const },
  { width: 10 },
];

export function buildProviderColumnHeader(width: number, tones: ProviderConsoleTones): Line {
  return buildAlignedRow(
    width,
    [
      { text: 'provider', fg: tones.label, bold: true },
      { text: 'status', fg: tones.label, bold: true },
      { text: 'avg', fg: tones.label, bold: true },
      { text: 'p95', fg: tones.label, bold: true },
      { text: 'err', fg: tones.label, bold: true },
      { text: 'latency trend', fg: tones.label, bold: true },
      { text: 'tokens', fg: tones.label, bold: true },
      { text: 'cost', fg: tones.label, bold: true },
      { text: 'auth', fg: tones.label, bold: true },
    ],
    PROVIDER_TABLE_COLUMNS,
    { marker: '▸' },
  );
}

export interface ProviderRowInput {
  readonly name: string;
  readonly entry: ProviderHealthEntry | undefined;
  readonly health: ProviderHealth | undefined;
  readonly account: ProviderAccountPosture | undefined;
  readonly selected: boolean;
}

export function buildProviderRow(width: number, tones: ProviderConsoleTones, input: ProviderRowInput): Line {
  const { name, entry, health, account, selected } = input;
  const status = entry?.status ?? 'unknown';
  const dot = statusDot(tones, status);
  const hasCalls = (entry?.totalCalls ?? 0) > 0;
  const avgMs = entry?.avgLatencyMs ?? 0;
  const p95Ms = entry?.p95LatencyMs ?? 0;
  const errPct = hasCalls ? `${Math.round((entry?.errorRate ?? 0) * 100)}%` : '-';
  return buildAlignedRow(
    width,
    [
      { text: `${dot.char} ${name}`, fg: tones.value, bold: selected },
      { text: statusLabel(status), fg: dot.color },
      { text: hasCalls && avgMs > 0 ? fmtMs(avgMs) : 'n/a', fg: hasCalls && avgMs > 0 ? latencyColor(tones, avgMs) : tones.dim },
      { text: hasCalls && p95Ms > 0 ? fmtMs(p95Ms) : '-', fg: tones.accent },
      { text: errPct, fg: hasCalls && (entry?.errorRate ?? 0) > 0 ? tones.bad : tones.dim },
      { text: buildSparkline(entry?.timeline.points ?? []), fg: hasCalls ? latencyColor(tones, avgMs) : tones.dim },
      { text: health && health.totalTokens > 0 ? fmtTokens(health.totalTokens) : '-', fg: tones.dim },
      {
        // Tokens flowed but the model never resolved to a real price — say so
        // instead of collapsing into the same '-' shown for "no calls yet".
        text: health && health.totalTokens > 0
          ? (health.hasUnpricedModel ? 'unpriced' : fmtUsd(health.totalCostUsd))
          : '-',
        fg: health?.hasUnpricedModel ? tones.dim : tones.value,
      },
      { text: account ? account.authFreshness : '-', fg: account ? freshnessColor(tones, account.authFreshness) : tones.dim },
    ],
    PROVIDER_TABLE_COLUMNS,
    { selected, selectedBg: tones.rowSelectBg, marker: '▸' },
  );
}

// ---------------------------------------------------------------------------
// Selected provider detail
// ---------------------------------------------------------------------------

export interface SelectedDetailInput {
  readonly selectedName: string;
  readonly entry: ProviderHealthEntry | undefined;
  readonly health: ProviderHealth | undefined;
  readonly account: ProviderAccountPosture | undefined;
}

export function buildSelectedDetailSection(
  width: number,
  tones: ProviderConsoleTones,
  palette: Palette,
  input: SelectedDetailInput,
): PanelWorkspaceSection {
  const { selectedName, entry, health, account } = input;
  const status = entry?.status ?? 'unknown';
  const lines: Line[] = [
    buildKeyValueLine(width, [
      { label: 'provider', value: selectedName, valueColor: tones.value },
      { label: 'status', value: statusLabel(status), valueColor: statusDot(tones, status).color },
      { label: 'last ok', value: fmtAgo(entry?.lastSuccessAt), valueColor: tones.value },
      { label: 'model', value: health?.lastModelId ?? 'n/a', valueColor: tones.dim },
    ], palette),
  ];
  if (entry?.rateLimitResetAt && entry.rateLimitResetAt > Date.now()) {
    lines.push(...buildBodyText(width, `Cooldown: ${fmtCooldown(entry.rateLimitResetAt)}`, palette, tones.warn));
  }
  if (entry?.lastErrorMessage) {
    lines.push(...buildBodyText(width, `Last error: ${entry.lastErrorMessage}`, palette, tones.bad));
  }
  if (entry && (entry.cacheReadTokens ?? 0) + (entry.cacheWriteTokens ?? 0) > 0) {
    lines.push(buildKeyValueLine(width, [
      { label: 'cache hit', value: entry.cacheHitRate !== undefined ? `${Math.round(entry.cacheHitRate * 100)}%` : 'n/a', valueColor: tones.good },
      { label: 'cache read', value: fmtTokens(entry.cacheReadTokens ?? 0), valueColor: tones.value },
      { label: 'cache write', value: fmtTokens(entry.cacheWriteTokens ?? 0), valueColor: tones.value },
    ], palette));
  }
  if (account) {
    lines.push(buildKeyValueLine(width, [
      { label: 'route', value: account.activeRoute, valueColor: routeColor(tones, account.activeRoute) },
      { label: 'preferred', value: account.preferredRoute, valueColor: tones.dim },
      { label: 'freshness', value: account.authFreshness, valueColor: freshnessColor(tones, account.authFreshness) },
      { label: 'models', value: String(account.modelCount), valueColor: tones.value },
    ], palette));
    lines.push(...buildBodyText(width, `Auth route: ${account.activeRouteReason}`, palette, tones.dim));
    if (account.issues.length > 0) {
      lines.push(...buildBodyText(width, `Issue: ${account.issues[0]!}`, palette, tones.bad));
    }
    if (account.repairHints.length > 0) {
      lines.push(...buildBodyText(width, `Fix: ${account.repairHints[0]!} (enter runs repair)`, palette, tones.title));
    }
  }
  return { lines: buildDetailBlock(width, 'Selected provider', lines, palette) };
}

// ---------------------------------------------------------------------------
// Auth routes view
// ---------------------------------------------------------------------------

export const ROUTE_COLUMNS = [
  { width: 20 },
  { width: 8 },
  { width: 12 },
  { width: 28 },
];

export function buildRouteColumnHeader(width: number, tones: ProviderConsoleTones): Line {
  return buildAlignedRow(
    width,
    [
      { text: 'route', fg: tones.label, bold: true },
      { text: 'usable', fg: tones.label, bold: true },
      { text: 'freshness', fg: tones.label, bold: true },
      { text: 'label', fg: tones.label, bold: true },
    ],
    ROUTE_COLUMNS,
    { marker: '▸' },
  );
}

export function buildRouteViewLines(
  width: number,
  tones: ProviderConsoleTones,
  palette: Palette,
  account: ProviderAccountPosture | undefined,
): Line[] {
  const lines: Line[] = [];
  if (!account) {
    lines.push(...buildBodyText(width, 'No route inspection data yet for this provider. Press r to refresh posture.', palette, tones.dim));
    return lines;
  }
  for (const route of account.routes) {
    const freshness = route.freshness ?? 'unconfigured';
    const usable = route.usable ?? route.configured;
    lines.push(buildAlignedRow(
      width,
      [
        { text: route.route, fg: routeColor(tones, route.route), bold: route.route === account.activeRoute },
        { text: usable ? 'usable' : 'blocked', fg: usable ? tones.good : tones.bad },
        { text: freshness, fg: freshnessColor(tones, freshness) },
        { text: route.label, fg: tones.value },
      ],
      ROUTE_COLUMNS,
      { marker: '▸' },
    ));
    if (route.detail) {
      lines.push(...buildBodyText(width, `    ${route.detail}`, palette, tones.dim));
    }
    if (route.envVars?.length) {
      lines.push(...buildBodyText(width, `    env: ${route.envVars.join(', ')}`, palette, tones.dim));
    }
    for (const hint of route.repairHints ?? []) {
      lines.push(...buildBodyText(width, `    fix: ${hint}`, palette, tones.title));
    }
  }
  for (const issue of account.issues) {
    lines.push(...buildBodyText(width, `issue: ${issue}`, palette, tones.bad));
  }
  if (account.repairHints.length > 0) {
    lines.push(...buildBodyText(width, `Enter dispatches /accounts repair ${account.providerId}.`, palette, tones.dim));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Repair domains + session maintenance view
// ---------------------------------------------------------------------------

export function buildDomainLines(
  width: number,
  tones: ProviderConsoleTones,
  palette: Palette,
  summaries: readonly HealthDomainSummary[],
): Line[] {
  const lines: Line[] = [];
  for (const domain of summaries) {
    lines.push(buildAlignedRow(
      width,
      [
        { text: domain.name, fg: tones.value, bold: true },
        { text: domain.summary, fg: domainColor(tones, domain.level) },
        { text: domain.next, fg: tones.dim },
      ],
      [
        { width: 14 },
        { width: Math.max(10, width - 38) },
        { width: 20 },
      ],
    ));
    for (const detail of domain.details.slice(0, 2)) {
      lines.push(...buildBodyText(width, `    ${detail}`, palette, tones.dim));
    }
    if (domain.nextSteps.length > 1) {
      lines.push(...buildBodyText(width, `    next: ${domain.nextSteps.join('  |  ')}`, palette, tones.title));
    }
  }
  return lines;
}

export interface MaintenanceSummaryInput {
  readonly level: string;
  readonly guidanceMode: string;
  readonly usagePct: number;
  readonly remainingTokens: number;
  readonly reasons: readonly string[];
  readonly nextSteps: readonly string[];
}

export function buildMaintenanceLines(
  width: number,
  tones: ProviderConsoleTones,
  palette: Palette,
  maintenance: MaintenanceSummaryInput,
): Line[] {
  const lines: Line[] = [
    buildKeyValueLine(width, [
      { label: 'level', value: maintenance.level, valueColor: maintenance.level === 'needs-repair' ? tones.bad : maintenance.level === 'suggest-compact' || maintenance.level === 'watch' ? tones.warn : tones.good },
      { label: 'guidance', value: maintenance.guidanceMode, valueColor: tones.value },
      { label: 'usage', value: `${maintenance.usagePct}%`, valueColor: maintenance.usagePct >= 80 ? tones.bad : maintenance.usagePct >= 70 ? tones.warn : tones.value },
      { label: 'remaining', value: maintenance.remainingTokens.toLocaleString(), valueColor: tones.value },
    ], palette),
  ];
  for (const reason of maintenance.reasons.slice(0, 3)) {
    lines.push(...buildBodyText(width, reason, palette, tones.dim));
  }
  if (maintenance.nextSteps.length > 0) {
    lines.push(...buildBodyText(width, `Next: ${maintenance.nextSteps.join('  |  ')}`, palette, tones.title));
  }
  return lines;
}
