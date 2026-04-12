import type {
  ChannelAccountLifecycleAction,
  ChannelConversationKind,
  ChannelDirectoryScope,
} from '../types.ts';

export function readLifecycleAction(value: unknown): ChannelAccountLifecycleAction | null {
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

export function readConversationKind(value: unknown): ChannelConversationKind | null {
  return value === 'direct' || value === 'group' || value === 'channel' || value === 'thread' || value === 'service'
    ? value
    : null;
}

export function readDirectoryScope(value: unknown): ChannelDirectoryScope | null {
  return value === 'all'
    || value === 'self'
    || value === 'users'
    || value === 'peers'
    || value === 'groups'
    || value === 'channels'
    || value === 'threads'
    || value === 'services'
    || value === 'members'
    ? value
    : null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => typeof entry === 'string' ? entry.trim() : '').filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  return undefined;
}

export function readSecretScope(value: unknown): 'project' | 'user' {
  return value === 'user' ? 'user' : 'project';
}
