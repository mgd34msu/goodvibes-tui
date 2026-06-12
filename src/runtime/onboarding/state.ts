import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '@/config/atomic-write.ts';

import type {
  OnboardingAcknowledgementRuntimeState,
  OnboardingAcknowledgementTarget,
  OnboardingMode,
  OnboardingShellPaths,
  OnboardingStateScope,
} from './types.ts';

const ONBOARDING_RUNTIME_STATE_FILE = 'onboarding-state.json';

export interface OnboardingRuntimeStateRecord {
  readonly scope: OnboardingStateScope;
  readonly path: string;
  readonly exists: boolean;
  readonly payload: OnboardingAcknowledgementRuntimeState | null;
  readonly parseError?: string;
}

interface WriteOnboardingAcknowledgementStateOptions {
  readonly scope?: OnboardingStateScope;
  readonly target: OnboardingAcknowledgementTarget;
  readonly acknowledged: boolean;
  readonly updatedAt?: number;
  readonly source: string;
  readonly mode?: OnboardingMode;
  readonly workspaceRoot?: string;
}

function resolveStatePath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope,
): string {
  return scope === 'project'
    ? shellPaths.resolveProjectPath('tui', ONBOARDING_RUNTIME_STATE_FILE)
    : shellPaths.resolveUserPath('tui', ONBOARDING_RUNTIME_STATE_FILE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOnboardingMode(value: unknown): value is OnboardingAcknowledgementRuntimeState['mode'] {
  return value === 'new' || value === 'edit' || value === 'reopen';
}

function isAcknowledgementTarget(value: string): value is OnboardingAcknowledgementTarget {
  return value === 'providers' || value === 'subscriptions' || value === 'auth';
}

function isRuntimeStatePayload(value: unknown): value is OnboardingAcknowledgementRuntimeState {
  if (!isObject(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return false;
  if (typeof value.source !== 'string') return false;
  if (value.mode !== undefined && !isOnboardingMode(value.mode)) return false;
  if (value.workspaceRoot !== undefined && typeof value.workspaceRoot !== 'string') return false;
  if (!isObject(value.acknowledgements)) return false;

  return Object.entries(value.acknowledgements).every(([key, entry]) => isAcknowledgementTarget(key) && typeof entry === 'boolean');
}

export function getOnboardingRuntimeStatePath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope = 'project',
): string {
  return resolveStatePath(shellPaths, scope);
}

export function readOnboardingRuntimeState(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope = 'project',
): OnboardingRuntimeStateRecord {
  const path = resolveStatePath(shellPaths, scope);
  if (!existsSync(path)) {
    return {
      scope,
      path,
      exists: false,
      payload: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isRuntimeStatePayload(parsed)) {
      return {
        scope,
        path,
        exists: true,
        payload: null,
        parseError: 'Invalid onboarding runtime state payload.',
      };
    }

    return {
      scope,
      path,
      exists: true,
      payload: parsed,
    };
  } catch (error) {
    return {
      scope,
      path,
      exists: true,
      payload: null,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeOnboardingAcknowledgementState(
  shellPaths: OnboardingShellPaths,
  options: WriteOnboardingAcknowledgementStateOptions,
): OnboardingRuntimeStateRecord {
  const scope = options.scope ?? 'project';
  const path = resolveStatePath(shellPaths, scope);
  const existing = readOnboardingRuntimeState(shellPaths, scope);
  const updatedAt = options.updatedAt ?? Date.now();
  const payload: OnboardingAcknowledgementRuntimeState = {
    version: 1,
    updatedAt,
    source: options.source,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.workspaceRoot ?? shellPaths.workingDirectory
      ? { workspaceRoot: options.workspaceRoot ?? shellPaths.workingDirectory }
      : {}),
    acknowledgements: {
      ...(existing.payload?.acknowledgements ?? {}),
      [options.target]: options.acknowledged,
    },
  };

  atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });

  return readOnboardingRuntimeState(shellPaths, scope);
}
