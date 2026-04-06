import type { PermissionsConfig, PolicyRule } from './types.ts';

export type PolicyLintSeverity = 'info' | 'warn' | 'error';

export interface PolicyLintFinding {
  severity: PolicyLintSeverity;
  ruleId?: string;
  message: string;
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function isBroadPathPattern(pattern: string): boolean {
  return pattern === '**' || pattern === '/' || pattern === '/*' || pattern === '/**';
}

function isBroadHostPattern(pattern: string): boolean {
  return pattern === '*' || pattern === '*.*' || pattern === '*.com' || pattern === '*:*';
}

function lintRule(rule: PolicyRule): PolicyLintFinding[] {
  const findings: PolicyLintFinding[] = [];

  if (rule.type === 'path-scope') {
    if (rule.pathPatterns.some(isBroadPathPattern)) {
      findings.push({
        severity: rule.effect === 'allow' ? 'error' : 'warn',
        ruleId: rule.id,
        message: `Path scope rule '${rule.id}' uses an overly broad path pattern.`,
      });
    }
  }

  if (rule.type === 'network-scope') {
    if (rule.hostPatterns.some(isBroadHostPattern)) {
      findings.push({
        severity: rule.effect === 'allow' ? 'error' : 'warn',
        ruleId: rule.id,
        message: `Network scope rule '${rule.id}' uses an overly broad host pattern.`,
      });
    }
  }

  if (rule.type === 'mode-constraint') {
    if (rule.activeModes.includes('allow-all') && rule.effect === 'allow') {
      findings.push({
        severity: 'warn',
        ruleId: rule.id,
        message: `Mode constraint rule '${rule.id}' redundantly allows actions in allow-all mode.`,
      });
    }
  }

  if (rule.type === 'prefix' && rule.effect === 'allow' && toArray(rule.toolPattern).includes('*') && !rule.commandPrefixes?.length) {
    findings.push({
      severity: 'error',
      ruleId: rule.id,
      message: `Prefix rule '${rule.id}' allows every tool without a command prefix constraint.`,
    });
  }

  return findings;
}

export function lintPolicyConfig(config: PermissionsConfig): PolicyLintFinding[] {
  const findings: PolicyLintFinding[] = [];
  const rules = config.rules ?? [];
  const seenIds = new Set<string>();

  for (const rule of rules) {
    if (seenIds.has(rule.id)) {
      findings.push({
        severity: 'error',
        ruleId: rule.id,
        message: `Duplicate policy rule id '${rule.id}'.`,
      });
    } else {
      seenIds.add(rule.id);
    }
    findings.push(...lintRule(rule));
  }

  if (config.mode === 'allow-all' && rules.length > 0) {
    findings.push({
      severity: 'warn',
      message: 'Policy rules are loaded while allow-all mode is active; runtime evaluation will still short-circuit to allow-all.',
    });
  }

  return findings;
}

