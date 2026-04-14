export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toSerializableJson(value: unknown, stack = new Map<object, string>(), path = '$'): unknown {
  if (!value || typeof value !== 'object') return value;
  const prior = stack.get(value as object);
  if (prior) {
    return { $ref: prior };
  }
  const next = new Map(stack);
  next.set(value as object, path);
  if (Array.isArray(value)) {
    return value.map((entry, index) => toSerializableJson(entry, next, `${path}[${index}]`));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      toSerializableJson(entry, next, `${path}.${key}`),
    ]),
  );
}

export function serializableJsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(toSerializableJson(body), init);
}

export function scopeMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  if (granted.endsWith(':*')) {
    return required.startsWith(granted.slice(0, -1));
  }
  return false;
}

export function missingScopes(grantedScopes: readonly string[] | undefined, requiredScopes: readonly string[]): string[] {
  const granted = grantedScopes ?? [];
  return requiredScopes.filter((required) => !granted.some((entry) => scopeMatches(entry, required)));
}

export type ChannelLifecycleAction =
  | 'inspect'
  | 'setup'
  | 'retest'
  | 'connect'
  | 'disconnect'
  | 'start'
  | 'stop'
  | 'login'
  | 'logout'
  | 'wait_login';

export type ChannelConversationKind = 'direct' | 'group' | 'channel' | 'thread' | 'service';

export function readChannelLifecycleAction(value: unknown): ChannelLifecycleAction | null {
  return value === 'inspect'
    || value === 'setup'
    || value === 'retest'
    || value === 'connect'
    || value === 'disconnect'
    || value === 'start'
    || value === 'stop'
    || value === 'login'
    || value === 'logout'
    || value === 'wait_login'
    ? value
    : null;
}

export function readChannelConversationKind(value: unknown): ChannelConversationKind | null {
  return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
    ? value
    : null;
}
