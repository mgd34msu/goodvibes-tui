export type {
  ChannelConversationKind,
  ChannelLifecycleAction,
  JsonRecord,
} from '@pellux/goodvibes-sdk-beta/daemon';
export {
  isJsonRecord,
  missingScopes,
  readChannelConversationKind,
  readChannelLifecycleAction,
  scopeMatches,
} from '@pellux/goodvibes-sdk-beta/daemon';

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
