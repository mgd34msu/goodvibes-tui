import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOnboardingMode(value: unknown): value is OnboardingCheckMarkerPayload['mode'] {
  return value === 'new' || value === 'edit' || value === 'reopen';
}

function isCheckMarkerPayload(value: unknown): value is OnboardingCheckMarkerPayload {
  return isObject(value)
    && value.version === 1
    && typeof value.checkedAt === 'number'
    && Number.isFinite(value.checkedAt)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && typeof value.source === 'string'
    && (value.mode === undefined || isOnboardingMode(value.mode))
    && (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string');
}

function buildMissingMarkerState(
  scope: OnboardingStateScope,
  path: string,
): OnboardingCheckMarkerState {
  return {
    scope,
    path,
    exists: false,
    payload: null,
  };
}

function buildParseErrorState(
  scope: OnboardingStateScope,
  path: string,
  parseError: string,
): OnboardingCheckMarkerState {
  return {
    scope,
    path,
    exists: true,
    payload: null,
    parseError,
  };
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
  if (!existsSync(path)) return buildMissingMarkerState(scope, path);

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isCheckMarkerPayload(parsed)) {
      return buildParseErrorState(scope, path, 'Invalid onboarding check marker payload.');
    }

    return {
      scope,
      path,
      exists: true,
      payload: parsed,
    };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    return buildParseErrorState(scope, path, parseError);
  }
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

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

  return readOnboardingCheckMarker(shellPaths, scope);
}
