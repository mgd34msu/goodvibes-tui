/**
 * Domain Read Matrix — single source of truth for cross-domain import authorization.
 *
 * This file defines which domain slices are permitted to import (read) from
 * other domain slices within `src/runtime/store/domains/`.
 *
 * Rules:
 *  - A domain may always import from its own file.
 *  - A domain may NOT import from another domain unless listed in DOMAIN_READ_MATRIX.
 *  - Domains should prefer reading through selectors (src/runtime/store/selectors/)
 *    rather than importing sibling domain types directly.
 *  - New cross-domain reads require an explicit entry here + rationale comment.
 *
 * Enforcement:
 *  - src/test/contracts/domain-boundary-contract.test.ts scans real import
 *    statements and fails if any unlisted cross-domain import is found.
 */

/** All known domain slice file names (without extension). */
export const DOMAINS = [
  'acp',
  'agents',
  'automation',
  'communication',
  'control-plane',
  'conversation',
  'daemon',
  'deliveries',
  'discovery',
  'git',
  'integrations',
  'intelligence',
  'mcp',
  'model',
  'orchestration',
  'overlays',
  'panels',
  'permissions',
  'plugins',
  'provider-health',
  'routes',
  'session',
  'surfaces',
  'tasks',
  'telemetry',
  'ui-perf',
  'watchers',
] as const;

export type DomainName = (typeof DOMAINS)[number];

/**
 * Authorized cross-domain reads.
 *
 * Shape: { reader: DomainName; reads: DomainName[] }[]
 *
 * Each entry grants `reader` permission to import from the listed `reads` domains.
 * Omitting a domain from this list means it may only import from itself (and
 * non-domain sources such as ../../../permissions/manager.ts).
 *
 * --- Authorized entries ---
 *
 * acp → daemon
 *   ACP transport state mirrors the DaemonTransportState enum to express
 *   its own lifecycle in terms already defined by the daemon domain.
 *   This avoids duplicating the state enum and keeps the two transport
 *   models structurally consistent.
 */
export const DOMAIN_READ_MATRIX: ReadonlyArray<{
  readonly reader: DomainName;
  readonly reads: readonly DomainName[];
}> = [
  {
    reader: 'acp',
    reads: ['daemon'],
  },
];

/**
 * Returns the set of domains that `reader` is authorized to import from.
 * Always includes the reader itself (self-imports are always permitted).
 */
export function getAllowedReadsFor(reader: DomainName): ReadonlySet<DomainName> {
  const entry = DOMAIN_READ_MATRIX.find((e) => e.reader === reader);
  const allowed = new Set<DomainName>([reader]);
  if (entry) {
    for (const dep of entry.reads) {
      allowed.add(dep);
    }
  }
  return allowed;
}
