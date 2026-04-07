import { resolve } from 'node:path';
import type { MemoryClass, MemoryReviewState, MemoryScope } from '../../state/memory-store.ts';

export const VALID_CLASSES: MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
export const VALID_SCOPES: MemoryScope[] = ['session', 'project', 'team'];
export const VALID_REVIEW_STATES: MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

export function isValidClass(s: string): s is MemoryClass {
  return VALID_CLASSES.includes(s as MemoryClass);
}

export function isValidScope(s: string): s is MemoryScope {
  return VALID_SCOPES.includes(s as MemoryScope);
}

export function isValidReviewState(s: string): s is MemoryReviewState {
  return VALID_REVIEW_STATES.includes(s as MemoryReviewState);
}

export function resolveBundlePath(pathArg: string): string {
  return resolve(process.cwd(), pathArg);
}
