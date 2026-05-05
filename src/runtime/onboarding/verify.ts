import { isSecretRefInput } from '@pellux/goodvibes-sdk/platform/config';
import { readOnboardingRuntimeState } from './state.ts';
import type {
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingVerificationDependencies,
  OnboardingVerificationItem,
  OnboardingVerificationResult,
} from './types.ts';

function getNow(deps: Pick<OnboardingVerificationDependencies, 'clock'>): number {
  return deps.clock?.() ?? Date.now();
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => isDeepEqual(value, right[index]));
  }

  if (
    typeof left === 'object' && left !== null
    && typeof right === 'object' && right !== null
    && !Array.isArray(left)
    && !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) return false;

    return leftEntries.every(([key, value]) => isDeepEqual(value, (right as Record<string, unknown>)[key]));
  }

  return false;
}

function isGoodVibesSecretRefInput(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function verifyConfigOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): OnboardingVerificationItem {
  const actual = deps.config.get(operation.key as never);
  const ok = isDeepEqual(actual, operation.value);

  return {
    id: `config:${operation.key}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${operation.key} matches the requested onboarding value.`
      : `${operation.key} does not match the requested onboarding value.`,
    target: operation.key,
  };
}

function verifyAcknowledgementOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'acknowledge' }>,
): OnboardingVerificationItem {
  const state = readOnboardingRuntimeState(deps.shellPaths, deps.acknowledgementScope ?? 'project');
  if (state.parseError) {
    return {
      id: `acknowledge:${operation.target}`,
      status: 'fail',
      message: `Onboarding acknowledgement state could not be parsed: ${state.parseError}`,
      target: operation.target,
    };
  }

  const actual = state.payload?.acknowledgements[operation.target] ?? false;
  const ok = actual === operation.acknowledged;

  return {
    id: `acknowledge:${operation.target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${operation.target} acknowledgement matches the requested onboarding state.`
      : `${operation.target} acknowledgement does not match the requested onboarding state.`,
    target: operation.target,
  };
}

async function verifySecretOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): Promise<OnboardingVerificationItem> {
  if (!deps.secrets) {
    return {
      id: `secret:${operation.key}`,
      status: 'fail',
      message: 'Secret manager is unavailable.',
      target: operation.key,
    };
  }

  const actual = await deps.secrets.get(operation.key);
  const ok = isGoodVibesSecretRefInput(operation.value)
    ? actual !== null
    : actual === operation.value;
  return {
    id: `secret:${operation.key}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? isGoodVibesSecretRefInput(operation.value)
        ? `${operation.key} resolves through the stored GoodVibes secret reference.`
        : `${operation.key} was stored through the secret manager.`
      : `${operation.key} did not match the requested secret value.`,
    target: operation.key,
  };
}

function verifyAuthOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): OnboardingVerificationItem {
  if (!deps.auth) {
    return {
      id: `auth:${operation.username}`,
      status: 'fail',
      message: 'Local auth manager is unavailable.',
      target: operation.username,
    };
  }

  const snapshot = deps.auth.inspect();
  const username = operation.username.trim();
  const user = snapshot.users.find((entry) => entry.username === username);
  const requiredRoles = operation.roles ?? ['admin'];
  const userExists = Boolean(user) && requiredRoles.every((role) => user!.roles.includes(role));
  const sessionExists = operation.createSession === false
    ? true
    : snapshot.sessions.some((session) => session.username === username);
  const bootstrapRetired = operation.retireBootstrapCredential
    ? snapshot.bootstrapCredentialPresent === false
    : true;
  const ok = userExists && sessionExists && bootstrapRetired;
  return {
    id: `auth:${username}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${username} local auth user has required role(s) and session state.`
      : `${username} local auth user/session/role/bootstrap state was not created.`,
    target: username,
  };
}

async function verifyOperation(
  deps: OnboardingVerificationDependencies,
  operation: OnboardingApplyOperation,
): Promise<OnboardingVerificationItem> {
  if (operation.kind === 'set-config') return verifyConfigOperation(deps, operation);
  if (operation.kind === 'set-secret') return verifySecretOperation(deps, operation);
  if (operation.kind === 'ensure-auth-user') return verifyAuthOperation(deps, operation);
  return verifyAcknowledgementOperation(deps, operation);
}

export async function verifyOnboardingRequest(
  deps: OnboardingVerificationDependencies,
  request: OnboardingApplyRequest,
): Promise<OnboardingVerificationResult> {
  const items = await Promise.all(request.operations.map((operation) => verifyOperation(deps, operation)));

  return {
    verifiedAt: getNow(deps),
    ok: items.every((item) => item.status === 'pass'),
    items,
  };
}
