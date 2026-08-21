import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '@pellux/goodvibes-sdk/platform/config';
import { isSecretRefInput } from '@pellux/goodvibes-sdk/platform/config';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '@pellux/goodvibes-sdk/platform/config';
import {
  getOnboardingRuntimeStatePath,
  readOnboardingRuntimeState,
  writeOnboardingAcknowledgementState,
} from './state.ts';
import { verifyOnboardingRequest } from './verify.ts';
import type {
  OnboardingApplyDependencies,
  OnboardingAppliedOperation,
  OnboardingApplyError,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingApplyResult,
} from './types.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function getNow(deps: Pick<OnboardingApplyDependencies, 'clock'>): number {
  return deps.clock?.() ?? Date.now();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!isPlainObject(parsed)) throw new Error(`Expected an object JSON payload at ${path}.`);
  return parsed;
}

function writeJsonObject(path: string, payload: Record<string, unknown>): void {
  atomicWriteFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mkdirp: true });
}

function setNestedValue(root: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.');
  const next = structuredClone(root);
  let cursor: Record<string, unknown> = next;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const existing = cursor[part];
    if (!isPlainObject(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }

  cursor[parts[parts.length - 1]!] = structuredClone(value);
  return next;
}

type RollbackAction = () => Promise<void> | void;

interface BootstrapCredential {
  readonly username: string;
  readonly password: string;
}

interface PersistedAuthUser {
  readonly username: string;
  readonly passwordHash: string;
  readonly roles?: readonly string[];
}

interface MutableAuthManager {
  readonly users?: Map<string, PersistedAuthUser>;
  readonly sessions?: Map<string, { readonly token: string; readonly username: string; readonly expiresAt: number }>;
}

function restoreFile(path: string, previous: string | null, reload?: () => void): void {
  if (previous === null) {
    if (existsSync(path)) unlinkSync(path);
  } else {
    atomicWriteFileSync(path, previous, { mkdirp: true });
  }
  reload?.();
}

function parseBootstrapCredential(content: string | null): BootstrapCredential | null {
  if (content === null) return null;
  let username = '';
  let password = '';
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('username=')) username = line.slice('username='.length);
    if (line.startsWith('password=')) password = line.slice('password='.length);
  }
  return username.length > 0 && password.length > 0 ? { username, password } : null;
}

function parsePersistedAuthUsers(content: string): readonly PersistedAuthUser[] {
  const parsed = JSON.parse(content) as unknown;
  if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.users)) {
    throw new Error('Expected a version 1 local auth user store.');
  }
  return parsed.users.filter((user): user is PersistedAuthUser => (
    isPlainObject(user)
    && typeof user.username === 'string'
    && typeof user.passwordHash === 'string'
    && (user.roles === undefined || (Array.isArray(user.roles) && user.roles.every((role) => typeof role === 'string')))
  ));
}

function snapshotFileRollback(path: string, reload?: () => void): RollbackAction {
  const previous = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  return () => restoreFile(path, previous, reload);
}

async function runRollbacks(rollbacks: readonly RollbackAction[]): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const rollback of [...rollbacks].reverse()) {
    try {
      await rollback();
    } catch (error) {
      errors.push(summarizeError(error));
    }
  }
  return errors;
}

function isGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://secrets/') && isSecretRefInput(normalized);
}

function isMalformedGoodVibesSecretReferenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith('goodvibes://') && !isGoodVibesSecretReferenceValue(normalized);
}

function validateConfigValue(operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>): void {
  if (typeof operation.value === 'string' && isMalformedGoodVibesSecretReferenceValue(operation.value)) {
    throw new Error(`Config key ${operation.key} only accepts goodvibes://secrets/... secret references.`);
  }

  // Feature enablement arrives as plain domain settings writes (e.g.
  // sandbox.enabled, controlPlane.gateway), validated by the schema path below
  // like any other key, there is no separate enablement namespace.
  const schema = CONFIG_SCHEMA.find((entry) => entry.key === operation.key);
  if (!schema) {
    const defaultValue = operation.key.split('.').reduce<unknown>((cursor, part) => (
      isPlainObject(cursor) ? cursor[part] : undefined
    ), DEFAULT_CONFIG);
    if (defaultValue === undefined) throw new Error(`Unknown config key: ${operation.key}`);
    if (typeof defaultValue === 'boolean' && typeof operation.value !== 'boolean') {
      throw new Error(`Config key ${operation.key} expects a boolean value.`);
    }
    if (typeof defaultValue === 'number' && typeof operation.value !== 'number') {
      throw new Error(`Config key ${operation.key} expects a numeric value.`);
    }
    if (typeof defaultValue === 'string' && typeof operation.value !== 'string') {
      throw new Error(`Config key ${operation.key} expects a string value.`);
    }
    return;
  }
  const stringValue = typeof operation.value === 'string' ? operation.value : null;

  if (schema.type === 'boolean' && typeof operation.value !== 'boolean') {
    throw new Error(`Config key ${operation.key} expects a boolean value.`);
  }

  if (schema.type === 'number' && typeof operation.value !== 'number') {
    throw new Error(`Config key ${operation.key} expects a numeric value.`);
  }

  if ((schema.type === 'string' || schema.type === 'enum') && stringValue === null) {
    throw new Error(`Config key ${operation.key} expects a string value.`);
  }

  if (schema.type === 'enum' && schema.enumValues && stringValue !== null && !schema.enumValues.includes(stringValue)) {
    throw new Error(`Invalid value for ${operation.key}: ${String(operation.value)}.`);
  }

  if (schema.validate && !schema.validate(operation.value)) {
    throw new Error(`Invalid value for ${operation.key}: ${String(operation.value)}.`);
  }
}

function validateSecretOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): void {
  if (!deps.secrets) throw new Error('Secret persistence is unavailable.');
  if (operation.key.trim().length === 0) throw new Error('Secret key is required.');
  if (operation.value.length === 0) throw new Error(`Secret value for ${operation.key} is required.`);
  if (!operation.medium) throw new Error(`Secret storage medium for ${operation.key} is required.`);
  if (isMalformedGoodVibesSecretReferenceValue(operation.value)) {
    throw new Error(`Secret value for ${operation.key} only accepts goodvibes://secrets/... secret references.`);
  }
}

function validateAuthOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): void {
  if (!deps.auth) throw new Error('Local auth management is unavailable.');
  if (operation.username.trim().length === 0) throw new Error('Local auth username is required.');
  if (operation.password.length === 0) throw new Error(`Local auth password for ${operation.username} is required.`);
  const username = operation.username.trim();
  const existing = deps.auth.inspect().users.find((user) => user.username === username);
  const requiredRoles = operation.roles ?? ['admin'];
  if (existing && !requiredRoles.every((role) => existing.roles.includes(role))) {
    throw new Error(`Existing local auth user ${username} is missing required role(s): ${requiredRoles.join(', ')}.`);
  }
}

function validateAcknowledgementOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'acknowledge' }>,
): void {
  if (typeof operation.acknowledged !== 'boolean') {
    throw new Error(`${operation.target} acknowledgement must be boolean.`);
  }

  const state = readOnboardingRuntimeState(deps.shellPaths, deps.acknowledgementScope ?? 'project');
  if (state.parseError) {
    throw new Error(`Existing onboarding acknowledgement state could not be parsed: ${state.parseError}`);
  }
}

function applyConfigOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): OnboardingAppliedOperation {
  validateConfigValue(operation);

  if ((operation.scope ?? 'global') === 'project') {
    const path = deps.shellPaths.resolveProjectPath('tui', 'settings.json');
    const existing = readJsonObject(path);
    const updated = setNestedValue(existing, operation.key, operation.value);
    writeJsonObject(path, updated);
    deps.config.load();

    return {
      kind: operation.kind,
      summary: `Persisted ${operation.key} in project onboarding settings.`,
    };
  }

  deps.config.setDynamic(operation.key as never, operation.value);
  return {
    kind: operation.kind,
    summary: `Updated ${operation.key} in global onboarding settings.`,
  };
}

async function applySecretOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): Promise<OnboardingAppliedOperation> {
  validateSecretOperation(deps, operation);
  await deps.secrets!.set(operation.key, operation.value, {
    scope: operation.scope ?? 'project',
    ...(operation.medium ? { medium: operation.medium } : {}),
  });

  return {
    kind: operation.kind,
    summary: `Stored ${operation.key} through the configured secret manager.`,
  };
}

function applyAuthOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): OnboardingAppliedOperation {
  validateAuthOperation(deps, operation);
  const auth = deps.auth!;
  const username = operation.username.trim();
  const before = auth.inspect();
  const existing = before.users.find((user) => user.username === username);
  const bootstrapCredential = before.bootstrapCredentialPresent
    ? parseBootstrapCredential(readFileSync(before.bootstrapCredentialPath, 'utf-8'))
    : null;

  if (existing) {
    auth.rotatePassword(username, operation.password);
  } else {
    auth.addUser(username, operation.password, operation.roles ?? ['admin']);
  }

  if (operation.retireBootstrapCredential) {
    if (bootstrapCredential && bootstrapCredential.username !== username && auth.getUser(bootstrapCredential.username)) {
      auth.deleteUser(bootstrapCredential.username);
    }
    auth.clearBootstrapCredentialFile();
  }

  if (operation.createSession ?? true) {
    auth.createSession(username);
  }

  return {
    kind: operation.kind,
    summary: existing
      ? `Updated local auth user ${username}.`
      : `Created local auth user ${username}.`,
  };
}

async function buildSecretRollbackAction(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-secret' }>,
): Promise<RollbackAction> {
  validateSecretOperation(deps, operation);
  const scope = operation.scope ?? 'project';
  const review = await deps.secrets!.inspect();
  const locations = review.locations.filter((entry) => entry.source.startsWith(`${scope}-`));
  if (locations.length === 0) throw new Error(`Secret storage locations for ${scope} scope are unavailable.`);
  const snapshots = locations.map((location) => ({
    path: location.path,
    previous: existsSync(location.path) ? readFileSync(location.path, 'utf-8') : null,
  }));
  return () => {
    for (const snapshot of snapshots) restoreFile(snapshot.path, snapshot.previous);
  };
}

function buildAuthRollbackAction(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): RollbackAction {
  validateAuthOperation(deps, operation);
  const auth = deps.auth!;
  const mutable = auth as unknown as MutableAuthManager;
  const username = operation.username.trim();
  const before = auth.inspect();
  const existingUser = before.users.find((user) => user.username === username);
  const existingSessionFingerprints = new Set(before.sessions
    .filter((session) => session.username === username)
    .map((session) => session.tokenFingerprint));
  const userStoreSnapshot = existsSync(before.userStorePath) ? readFileSync(before.userStorePath, 'utf-8') : null;
  const bootstrapCredentialSnapshot = existsSync(before.bootstrapCredentialPath)
    ? readFileSync(before.bootstrapCredentialPath, 'utf-8')
    : null;
  const bootstrapCredential = parseBootstrapCredential(bootstrapCredentialSnapshot);
  const beforeSessions = mutable.sessions instanceof Map
    ? [...mutable.sessions.entries()].map(([token, session]) => [token, { ...session }] as const)
    : [];

  return () => {
    for (const session of auth.inspect().sessions) {
      if (session.username === username && !existingSessionFingerprints.has(session.tokenFingerprint)) {
        auth.revokeSession(session.tokenFingerprint);
      }
    }

    if (bootstrapCredential && !auth.getUser(bootstrapCredential.username)) {
      auth.addUser(bootstrapCredential.username, bootstrapCredential.password, ['admin']);
    }

    if (!existingUser && auth.getUser(username)) {
      try {
        auth.deleteUser(username);
      } catch (error) {
        if (mutable.users instanceof Map) mutable.users.delete(username);
        else throw error;
      }
    }

    restoreFile(before.bootstrapCredentialPath, bootstrapCredentialSnapshot);
    restoreFile(before.userStorePath, userStoreSnapshot);

    if (mutable.users instanceof Map) {
      if (userStoreSnapshot === null) {
        if (before.users.length === 0) mutable.users.clear();
      } else {
        mutable.users.clear();
        for (const user of parsePersistedAuthUsers(userStoreSnapshot)) mutable.users.set(user.username, user);
      }
    }

    if (mutable.sessions instanceof Map) {
      mutable.sessions.clear();
      for (const [token, session] of beforeSessions) mutable.sessions.set(token, session);
    }
  };
}

async function buildRollbackAction(
  deps: OnboardingApplyDependencies,
  operation: OnboardingApplyOperation,
): Promise<RollbackAction> {
  if (operation.kind === 'set-config') {
    if ((operation.scope ?? 'global') === 'project') {
      return snapshotFileRollback(
        deps.shellPaths.resolveProjectPath('tui', 'settings.json'),
        () => deps.config.load(),
      );
    }

    const previous = deps.config.get(operation.key as never);
    return () => {
      deps.config.setDynamic(operation.key as never, previous);
    };
  }

  if (operation.kind === 'set-secret') {
    return buildSecretRollbackAction(deps, operation);
  }

  if (operation.kind === 'ensure-auth-user') {
    return buildAuthRollbackAction(deps, operation);
  }

  if (operation.kind === 'acknowledge') {
    return snapshotFileRollback(
      getOnboardingRuntimeStatePath(deps.shellPaths, deps.acknowledgementScope ?? 'project'),
    );
  }

  const neverOperation: never = operation;
  throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
}

function applyAcknowledgementOperation(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
  operation: Extract<OnboardingApplyOperation, { kind: 'acknowledge' }>,
): OnboardingAppliedOperation {
  writeOnboardingAcknowledgementState(deps.shellPaths, {
    scope: deps.acknowledgementScope ?? 'project',
    target: operation.target,
    acknowledged: operation.acknowledged,
    updatedAt: getNow(deps),
    source: request.source,
    mode: request.mode,
  });

  return {
    kind: operation.kind,
    summary: `${operation.target} acknowledgement set to ${operation.acknowledged ? 'accepted' : 'pending'}.`,
  };
}

function orderApplyOperations(
  operations: readonly OnboardingApplyOperation[],
): readonly OnboardingApplyOperation[] {
  const secretPolicyOperations = operations.filter((operation) => (
    operation.kind === 'set-config' && operation.key === 'storage.secretPolicy'
  ));
  const authOperations = operations.filter((operation) => operation.kind === 'ensure-auth-user');
  const secretOperations = operations.filter((operation) => operation.kind === 'set-secret');
  const configOperations = operations.filter((operation) => (
    operation.kind === 'set-config' && operation.key !== 'storage.secretPolicy'
  ));
  const finalOperations = operations.filter((operation) => (
    operation.kind === 'acknowledge'
  ));

  return [
    ...secretPolicyOperations,
    ...authOperations,
    ...secretOperations,
    ...configOperations,
    ...finalOperations,
  ];
}

function prevalidateApplyRequest(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
): OnboardingApplyError[] {
  const errors: OnboardingApplyError[] = [];
  const orderedOperations = orderApplyOperations(request.operations);

  for (const operation of orderedOperations) {
    try {
      if (operation.kind === 'set-config') {
        validateConfigValue(operation);
        if ((operation.scope ?? 'global') === 'project') {
          readJsonObject(deps.shellPaths.resolveProjectPath('tui', 'settings.json'));
        }
        continue;
      }

      if (operation.kind === 'set-secret') {
        validateSecretOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'ensure-auth-user') {
        validateAuthOperation(deps, operation);
        continue;
      }

      if (operation.kind === 'acknowledge') {
        validateAcknowledgementOperation(deps, operation);
        continue;
      }

      const neverOperation: never = operation;
      throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
    } catch (error) {
      errors.push({
        kind: operation.kind,
        message: summarizeError(error),
      });
    }
  }

  return errors;
}

function getVerificationFailureKind(itemId: string): OnboardingApplyOperation['kind'] {
  if (itemId.startsWith('config:')) return 'set-config';
  if (itemId.startsWith('secret:')) return 'set-secret';
  if (itemId.startsWith('auth:')) return 'ensure-auth-user';
  if (itemId.startsWith('acknowledge:')) return 'acknowledge';
  return 'set-config';
}

export async function applyOnboardingRequest(
  deps: OnboardingApplyDependencies,
  request: OnboardingApplyRequest,
): Promise<OnboardingApplyResult> {
  const applied: OnboardingAppliedOperation[] = [];
  const skipped: never[] = [];
  const errors: OnboardingApplyError[] = prevalidateApplyRequest(deps, request);
  if (errors.length > 0) {
    return {
      ok: false,
      applied,
      skipped,
      errors,
    };
  }

  const orderedOperations = orderApplyOperations(request.operations);
  const rollbacks: RollbackAction[] = [];

  const applyOperations = async (operations: readonly OnboardingApplyOperation[]): Promise<boolean> => {
    for (const operation of operations) {
      let rollback: RollbackAction = () => {};
      try {
        rollback = await buildRollbackAction(deps, operation);
        if (operation.kind === 'set-config') {
          applied.push(applyConfigOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'set-secret') {
          applied.push(await applySecretOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'ensure-auth-user') {
          applied.push(applyAuthOperation(deps, operation));
          rollbacks.push(rollback);
          continue;
        }

        if (operation.kind === 'acknowledge') {
          applied.push(applyAcknowledgementOperation(deps, request, operation));
          rollbacks.push(rollback);
          continue;
        }

        const neverOperation: never = operation;
        throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
      } catch (error) {
        const rollbackErrors = await runRollbacks([...rollbacks, rollback]);
        applied.length = 0;
        errors.push({
          kind: operation.kind,
          message: [
            summarizeError(error),
            ...rollbackErrors.map((rollbackError) => `rollback: ${rollbackError}`),
          ].join('; '),
        });
        return false;
      }
    }
    return true;
  };

  const verifyOrRollback = async (operations: readonly OnboardingApplyOperation[]): Promise<boolean> => {
    const verification = await verifyOnboardingRequest(deps, { ...request, operations });
    const failures = verification.items.filter((item) => item.status !== 'pass');
    if (failures.length === 0) return true;

    const rollbackErrors = await runRollbacks(rollbacks);
    applied.length = 0;
    errors.push(...failures.map((item, index) => ({
      kind: getVerificationFailureKind(item.id),
      message: [
        `verify ${item.id}: ${item.message}`,
        ...(index === 0 ? rollbackErrors.map((rollbackError) => `rollback: ${rollbackError}`) : []),
      ].join('; '),
    })));
    return false;
  };

  if (!await applyOperations(orderedOperations)) {
    return { ok: false, applied, skipped, errors };
  }

  if (!await verifyOrRollback(orderedOperations)) {
    return { ok: false, applied, skipped, errors };
  }

  return {
    ok: errors.length === 0,
    applied,
    skipped,
    errors,
  };
}
