import type { AutomationExternalContentSource, AutomationWakeMode } from '../automation/index.ts';
import type { AutomationExecutionPolicy } from '../automation/index.ts';
import {
  isJsonRecord,
  missingScopes,
  readChannelConversationKind,
  readChannelLifecycleAction,
  scopeMatches,
  type JsonRecord,
} from './http/route-helpers.ts';

export type { ChannelConversationKind, ChannelLifecycleAction, JsonRecord } from './http/route-helpers.ts';
export {
  isJsonRecord,
  missingScopes,
  readChannelConversationKind,
  readChannelLifecycleAction,
  scopeMatches,
} from './http/route-helpers.ts';

export function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return undefined;
}

export function resolveGatewayPathTemplate(
  template: string,
  query?: Record<string, unknown>,
  body?: unknown,
): { readonly path: string | null; readonly missing: readonly string[] } {
  const bodyRecord = isJsonRecord(body) ? body : null;
  const missingParams: string[] = [];
  const path = template.replace(/\{([^}]+)\}/g, (_full, rawKey: string) => {
    const key = rawKey.trim();
    const queryValue = query?.[key];
    const bodyValue = bodyRecord?.[key];
    const value = typeof queryValue === 'string' || typeof queryValue === 'number'
      ? queryValue
      : typeof bodyValue === 'string' || typeof bodyValue === 'number'
        ? bodyValue
        : null;
    if (value === null) {
      missingParams.push(key);
      return `{${key}}`;
    }
    return encodeURIComponent(String(value));
  });
  return missingParams.length > 0 ? { path: null, missing: missingParams } : { path, missing: [] };
}

export function readAutomationWakeMode(value: unknown): AutomationWakeMode | undefined {
  return value === 'now' || value === 'next-heartbeat' ? value : undefined;
}

export function readAutomationReasoningEffort(value: unknown): AutomationExecutionPolicy['reasoningEffort'] | undefined {
  return value === 'instant' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

export function readExternalContentSource(value: unknown): AutomationExternalContentSource | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim() as AutomationExternalContentSource;
  }
  if (value && typeof value === 'object') {
    return value as AutomationExternalContentSource;
  }
  return undefined;
}
