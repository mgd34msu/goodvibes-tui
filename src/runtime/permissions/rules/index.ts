/**
 * Runtime permissions policy rules barrel export.
 *
 * Re-exports all rule evaluator functions and result types.
 */

export { evaluatePrefixRule } from './prefix.ts';
export type { PrefixRuleResult } from './prefix.ts';

export { evaluateArgShapeRule } from './arg-shape.ts';
export type { ArgShapeRuleResult } from './arg-shape.ts';

export { evaluatePathScopeRule } from './path-scope.ts';
export type { PathScopeRuleResult } from './path-scope.ts';

export { evaluateNetworkScopeRule } from './network-scope.ts';
export type { NetworkScopeRuleResult } from './network-scope.ts';

export { evaluateModeConstraintRule } from './mode-constraint.ts';
export type { ModeConstraintRuleResult } from './mode-constraint.ts';
