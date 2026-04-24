import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ShellPathService } from '@pellux/goodvibes-sdk/platform/runtime/shell-paths';
import type {
  OnboardingCompletionMarkerPayload,
  OnboardingCompletionMarkerScope,
  OnboardingCompletionMarkerState,
  OnboardingCompletionMarkersState,
  WriteOnboardingCompletionMarkerOptions,
} from './types.ts';

const ONBOARDING_COMPLETION_MARKER_FILE = 'onboarding-complete.json';

type OnboardingShellPaths = Pick<
  ShellPathService,
  'workingDirectory' | 'resolveProjectPath' | 'resolveUserPath'
>;

function resolveMarkerPath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingCompletionMarkerScope,
): string {
  return scope === 'project'
    ? shellPaths.resolveProjectPath('tui', ONBOARDING_COMPLETION_MARKER_FILE)
    : shellPaths.resolveUserPath('tui', ONBOARDING_COMPLETION_MARKER_FILE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOnboardingMode(value: unknown): value is OnboardingCompletionMarkerPayload['mode'] {
  return value === 'new' || value === 'edit' || value === 'reopen';
}

function isCompletionMarkerPayload(value: unknown): value is OnboardingCompletionMarkerPayload {
  return isObject(value)
    && value.version === 1
    && typeof value.completedAt === 'number'
    && Number.isFinite(value.completedAt)
    && typeof value.updatedAt === 'number'
    && Number.isFinite(value.updatedAt)
    && typeof value.source === 'string'
    && (value.mode === undefined || isOnboardingMode(value.mode))
    && (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string');
}

function buildMissingMarkerState(
  scope: OnboardingCompletionMarkerScope,
  path: string,
): OnboardingCompletionMarkerState {
  return {
    scope,
    path,
    exists: false,
    payload: null,
  };
}

function buildParseErrorState(
  scope: OnboardingCompletionMarkerScope,
  path: string,
  parseError: string,
): OnboardingCompletionMarkerState {
  return {
    scope,
    path,
    exists: true,
    payload: null,
    parseError,
  };
}

function pickEffectiveMarker(
  project: OnboardingCompletionMarkerState,
  user: OnboardingCompletionMarkerState,
): OnboardingCompletionMarkerState | null {
  if (project.payload) return project;
  if (user.payload) return user;
  if (project.exists) return project;
  if (user.exists) return user;
  return null;
}

export function getOnboardingCompletionMarkerPath(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingCompletionMarkerScope = 'user',
): string {
  return resolveMarkerPath(shellPaths, scope);
}

export function readOnboardingCompletionMarker(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingCompletionMarkerScope = 'user',
): OnboardingCompletionMarkerState {
  const path = resolveMarkerPath(shellPaths, scope);
  if (!existsSync(path)) return buildMissingMarkerState(scope, path);

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isCompletionMarkerPayload(parsed)) {
      return buildParseErrorState(scope, path, 'Invalid onboarding completion marker payload.');
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

export function readOnboardingCompletionMarkers(
  shellPaths: OnboardingShellPaths,
): OnboardingCompletionMarkersState {
  const user = readOnboardingCompletionMarker(shellPaths, 'user');
  const project = readOnboardingCompletionMarker(shellPaths, 'project');

  return {
    user,
    project,
    effective: pickEffectiveMarker(project, user),
  };
}

export function writeOnboardingCompletionMarker(
  shellPaths: OnboardingShellPaths,
  options: WriteOnboardingCompletionMarkerOptions = {},
): OnboardingCompletionMarkerState {
  const scope = options.scope ?? 'user';
  const path = resolveMarkerPath(shellPaths, scope);
  const completedAt = options.completedAt ?? Date.now();
  const payload: OnboardingCompletionMarkerPayload = {
    version: 1,
    completedAt,
    updatedAt: options.updatedAt ?? completedAt,
    source: options.source ?? 'wizard',
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.workspaceRoot ?? shellPaths.workingDirectory
      ? { workspaceRoot: options.workspaceRoot ?? shellPaths.workingDirectory }
      : {}),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

  return readOnboardingCompletionMarker(shellPaths, scope);
}

export function clearOnboardingCompletionMarker(
  shellPaths: OnboardingShellPaths,
  scope: OnboardingCompletionMarkerScope = 'user',
): OnboardingCompletionMarkerState {
  const path = resolveMarkerPath(shellPaths, scope);
  if (existsSync(path)) unlinkSync(path);
  return buildMissingMarkerState(scope, path);
}
