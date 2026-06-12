import { existsSync } from 'node:fs';
import { atomicWriteFileSync } from '@/config/atomic-write.ts';
import { readVersioned } from '@/config/read-versioned.ts';

import type { ShellPathService } from '@/runtime/index.ts';
import type {
  OnboardingCheckMarkerPayload,
  OnboardingCheckMarkerState,
  OnboardingCheckMarkersState,
  OnboardingStateScope,
  WriteOnboardingCheckMarkerOptions,
} from './types.ts';

const ONBOARDING_CHECK_MARKER_FILE = 'onboarding-checked.json';

type OnboardingShellPaths = Pick<
  ShellPathService,
  'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'
>;

function resolveMarkerPath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope,
): string {
  return scope === 'project'
    ? shellPaths.resolveProjectPath('tui', ONBOARDING_CHECK_MARKER_FILE)
    : shellPaths.resolveUserPath('tui', ONBOARDING_CHECK_MARKER_FILE);
}

function isCheckMarkerPayload(value: unknown): value is OnboardingCheckMarkerPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v['version'] === 1
    && typeof v['checkedAt'] === 'number'
    && Number.isFinite(v['checkedAt'] as number)
    && typeof v['updatedAt'] === 'number'
    && Number.isFinite(v['updatedAt'] as number)
    && typeof v['source'] === 'string'
    && (v['mode'] === undefined || v['mode'] === 'new' || v['mode'] === 'edit' || v['mode'] === 'reopen')
    && (v['workspaceRoot'] === undefined || typeof v['workspaceRoot'] === 'string')
  );
}

function buildMissingMarkerState(
  scope: OnboardingStateScope,
  path: string,
): OnboardingCheckMarkerState {
  return { scope, path, exists: false, payload: null };
}

function buildErrorMarkerState(
  scope: OnboardingStateScope,
  path: string,
  parseError: string,
): OnboardingCheckMarkerState {
  return { scope, path, exists: true, payload: null, parseError };
}

function pickEffectiveMarker(
  user: OnboardingCheckMarkerState,
): OnboardingCheckMarkerState | null {
  if (user.payload) return user;
  if (user.exists) return user;
  return null;
}

export function getOnboardingCheckMarkerPath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope = 'user',
): string {
  return resolveMarkerPath(shellPaths, scope);
}

export function readOnboardingCheckMarker(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingStateScope = 'user',
): OnboardingCheckMarkerState {
  const path = resolveMarkerPath(shellPaths, scope);

  const parsed = readVersioned<OnboardingCheckMarkerPayload & { version: number }>(
    path,
    { currentVersion: 1, onUnknown: 'quarantine' },
  );

  if (parsed === null) {
    // readVersioned returns null for: missing, corrupt JSON, or unrecognised
    // version (renamed to <path>.unrecognized).
    const nowExists = existsSync(path);
    const quarantined = existsSync(`${path}.unrecognized`);
    if (!nowExists && !quarantined) return buildMissingMarkerState(scope, path);
    return buildErrorMarkerState(
      scope,
      path,
      quarantined
        ? 'Unrecognised or corrupt marker file; quarantined.'
        : 'Invalid onboarding check marker payload.',
    );
  }

  if (!isCheckMarkerPayload(parsed)) {
    return buildErrorMarkerState(scope, path, 'Invalid onboarding check marker payload.');
  }

  return { scope, path, exists: true, payload: parsed };
}

export function readOnboardingCheckMarkers(
  shellPaths: OnboardingShellPaths,
): OnboardingCheckMarkersState {
  const user = readOnboardingCheckMarker(shellPaths, 'user');
  const project = readOnboardingCheckMarker(shellPaths, 'project');

  return {
    user,
    project,
    effective: pickEffectiveMarker(user),
  };
}

export function writeOnboardingCheckMarker(
  shellPaths: OnboardingShellPaths,
  options: WriteOnboardingCheckMarkerOptions = {},
): OnboardingCheckMarkerState {
  const scope = options.scope ?? 'user';
  const path = resolveMarkerPath(shellPaths, scope);
  const checkedAt = options.checkedAt ?? Date.now();
  const payload: OnboardingCheckMarkerPayload = {
    version: 1,
    checkedAt,
    updatedAt: options.updatedAt ?? checkedAt,
    source: options.source ?? 'wizard',
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
  };

  atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });

  return readOnboardingCheckMarker(shellPaths, scope);
}
