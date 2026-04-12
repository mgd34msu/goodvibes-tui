import type { AutomationExternalContentSource, AutomationWakeMode } from '../automation/index.ts';
import type { AutomationExecutionPolicy } from '../automation/index.ts';
import type { ChannelAccountLifecycleAction, ChannelConversationKind } from '../channels/index.ts';

export type JsonRecord = Record<string, unknown>;

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

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function readChannelLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
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
