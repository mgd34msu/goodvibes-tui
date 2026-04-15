export const DOMAINS = [
  'conversation',
  'panels',
  'permissions',
  'ui-perf',
] as const;

export type DomainName = (typeof DOMAINS)[number];

export const DOMAIN_READ_MATRIX: ReadonlyArray<{
  readonly reader: DomainName;
  readonly reads: readonly DomainName[];
}> = [];

export function getAllowedReadsFor(reader: DomainName): ReadonlySet<DomainName> {
  return new Set<DomainName>([reader]);
}
