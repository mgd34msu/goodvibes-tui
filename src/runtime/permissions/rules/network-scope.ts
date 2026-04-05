/**
 * Network scope (host/URL) policy rule evaluator with host trust tier classification.
 *
 * NetworkScopeRule matches tool calls that make network requests, restricting
 * or allowing access based on whether the target hostname matches any of the
 * specified host patterns. Supports glob wildcards. Independently testable.
 */

import type {
  NetworkScopeRule,
  EvaluationStep,
} from '../types.ts';
import {
  classifyHostTrustTier,
  extractHostname,
  type HostTrustTier,
  type TrustTierConfig,
} from '../../../tools/fetch/trust-tiers.ts';

/**
 * Re-export host trust tier types from the network scope module for
 * consumers that access trust classification via the permissions layer.
 *
 * The policy panel uses these exports to show host trust classification
 * alongside permission decisions.
 */
export type { HostTrustTier, TrustTierConfig };
export { classifyHostTrustTier, extractHostname };

/** Result returned by evaluateNetworkScopeRule. */
export interface NetworkScopeRuleResult {
  matched: boolean;
  step: EvaluationStep;
}

/**
 * toolMatchesNetworkPattern — Returns true if `toolName` matches the rule's toolPattern.
 */
function toolMatchesNetworkPattern(
  toolName: string,
  toolPattern: string | string[],
): boolean {
  if (Array.isArray(toolPattern)) {
    return toolPattern.some((p) => p === '*' || p === toolName);
  }
  return toolPattern === '*' || toolPattern === toolName;
}

/**
 * extractHostAndPort — Extracts the hostname and port from args.
 *
 * Checks `url`, `host`, `hostname`, `endpoint` fields.
 * Parses full URLs to extract hostname + port.
 *
 * Returns `null` if no network-related argument is found.
 */
function extractHostAndPort(
  args: Record<string, unknown>,
): { host: string; port: number | null } | null {
  // Try URL-shaped fields first
  const urlCandidates = ['url', 'endpoint', 'uri', 'href'];
  for (const key of urlCandidates) {
    if (typeof args[key] === 'string') {
      const raw = args[key] as string;
      try {
        const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
        const port = parsed.port ? parseInt(parsed.port, 10) : null;
        return { host: parsed.hostname, port };
      } catch {
        // Not a valid URL — validate it looks like a hostname before using it
        // Reject strings with spaces or exceeding max hostname length (RFC 1035: 253 chars)
        if (raw.includes(' ') || raw.length > 253 || raw.length === 0) {
          return null;
        }
        return { host: raw, port: null };
      }
    }
  }
  // Try plain host/hostname fields
  if (typeof args['host'] === 'string') return { host: args['host'], port: null };
  if (typeof args['hostname'] === 'string') return { host: args['hostname'], port: null };
  return null;
}

/**
 * hostGlobToRegex — Converts a host glob pattern to a RegExp.
 *
 * Supports:
 *   - `*`  — matches any sequence of non-dot characters (one segment)
 *   - `**` — matches any sequence including dots (crosses subdomain boundaries)
 */
function hostGlobToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001DS\u0001')
    .replace(/\*/g, '[^.]*')
    .replace(/\u0001DS\u0001/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * hostMatchesPattern — Returns true if `host` matches the glob `pattern`.
 */
function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern === '*') return true;
  return hostGlobToRegex(pattern).test(host);
}

/**
 * evaluateNetworkScopeRule — Evaluates a single NetworkScopeRule against a tool call.
 *
 * Returns `matched: true` when:
 *   1. The tool name matches the rule's `toolPattern`, AND
 *   2. A network host is found in the args, AND
 *   3. The hostname matches at least one of the rule's `hostPatterns`, AND
 *   4. If `ports` is specified, the request port is in the allowed set.
 *
 * @param rule     - The NetworkScopeRule to evaluate.
 * @param toolName - Name of the tool being called.
 * @param args     - Arguments passed to the tool.
 */
export function evaluateNetworkScopeRule(
  rule: NetworkScopeRule,
  toolName: string,
  args: Record<string, unknown>,
): NetworkScopeRuleResult {
  const toolMatches = toolMatchesNetworkPattern(toolName, rule.toolPattern);

  if (!toolMatches) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `network-scope-rule:${rule.id}`,
        matched: false,
        detail: `tool "${toolName}" does not match pattern "${rule.toolPattern}"`,
      },
    };
  }

  const hostInfo = extractHostAndPort(args);
  if (hostInfo === null) {
    return {
      matched: false,
      step: {
        layer: 'policy',
        check: `network-scope-rule:${rule.id}`,
        matched: false,
        detail: 'no network host/URL argument found in args',
      },
    };
  }

  const { host, port } = hostInfo;

  // Check port constraint
  if (rule.ports !== undefined && rule.ports.length > 0 && port !== null) {
    const portAllowed = rule.ports.includes(0) || rule.ports.includes(port);
    if (!portAllowed) {
      return {
        matched: false,
        step: {
          layer: 'policy',
          check: `network-scope-rule:${rule.id}`,
          matched: false,
          detail: `port ${port} not in allowed ports [${rule.ports.join(', ')}]`,
        },
      };
    }
  }

  const matchedPattern = rule.hostPatterns.find((p) => hostMatchesPattern(host, p));
  if (matchedPattern !== undefined) {
    return {
      matched: true,
      step: {
        layer: 'policy',
        check: `network-scope-rule:${rule.id}`,
        matched: true,
        detail: `host "${host}" matched pattern "${matchedPattern}"`,
      },
    };
  }

  return {
    matched: false,
    step: {
      layer: 'policy',
      check: `network-scope-rule:${rule.id}`,
      matched: false,
      detail: `host "${host}" did not match any of [${rule.hostPatterns.join(', ')}]`,
    },
  };
}
