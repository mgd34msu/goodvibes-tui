import { describe, test, expect, mock } from 'bun:test';
import {
  classifyError,
  formatUserFacingError,
  formatUserFacingErrorLine,
  type ErrorClass,
} from '../../core/format-user-error.ts';
import { SystemMessageRouter, createSystemMessageRouter } from '../../core/system-message-router.ts';
import type { ConversationManager } from '../../core/conversation';
import type { SystemMessageKind, SystemMessageTarget } from '../../core/system-message-router.ts';

// ---------------------------------------------------------------------------
// Classifier table
// ---------------------------------------------------------------------------

type ClassifyCase = { label: string; err: unknown; expected: ErrorClass };

const classifyCases: ClassifyCase[] = [
  // --- auth ---
  { label: 'status 401', err: { status: 401, message: 'Unauthorized' }, expected: 'auth' },
  { label: 'statusCode 401', err: { statusCode: 401, message: 'permission denied' }, expected: 'auth' },
  { label: 'invalid api key message', err: new Error('Invalid API key provided'), expected: 'auth' },
  { label: 'invalid key (variant)', err: new Error('invalid key — check your credentials'), expected: 'auth' },
  { label: 'Unauthorized string', err: 'Unauthorized', expected: 'auth' },
  { label: 'authentication failed message', err: new Error('authentication failed'), expected: 'auth' },

  // --- rate-limit ---
  { label: 'status 429', err: { status: 429, message: 'Too Many Requests' }, expected: 'rate-limit' },
  { label: 'rate_limit message', err: new Error('rate_limit exceeded'), expected: 'rate-limit' },
  { label: 'rate limit (spaced)', err: new Error('rate limit reached for this model'), expected: 'rate-limit' },
  { label: 'quota exceeded', err: new Error('quota exceeded for this billing period'), expected: 'rate-limit' },

  // --- context-overflow ---
  { label: 'context length', err: new Error('This model\'s maximum context length is 128000 tokens'), expected: 'context-overflow' },
  { label: 'context window', err: new Error('context window exceeded'), expected: 'context-overflow' },
  { label: 'too many tokens', err: new Error('too many tokens in conversation'), expected: 'context-overflow' },
  { label: 'input too long', err: new Error('input is too long for this model'), expected: 'context-overflow' },

  // --- network ---
  { label: 'ECONNREFUSED code', err: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }), expected: 'network' },
  { label: 'ETIMEDOUT', err: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), expected: 'network' },
  { label: 'fetch failed', err: new Error('fetch failed'), expected: 'network' },
  { label: 'socket hang up', err: new Error('socket hang up'), expected: 'network' },
  { label: 'connection refused', err: new Error('connection refused by remote host'), expected: 'network' },
  { label: 'network timeout', err: new Error('network timeout after 30s'), expected: 'network' },

  // --- generic fallback ---
  { label: 'unknown error object', err: new Error('some unknown provider failure'), expected: 'generic' },
  { label: 'plain string', err: 'something went wrong', expected: 'generic' },
  { label: 'null', err: null, expected: 'generic' },
  { label: 'undefined', err: undefined, expected: 'generic' },
];

describe('classifyError', () => {
  for (const { label, err, expected } of classifyCases) {
    test(`classifies as ${expected}: ${label}`, () => {
      expect(classifyError(err)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// formatUserFacingError — verify messages and actions per class
// ---------------------------------------------------------------------------

describe('formatUserFacingError', () => {
  test('auth error has /login action', () => {
    const result = formatUserFacingError({ status: 401, message: 'Unauthorized' });
    expect(result.kind).toBe('auth');
    expect(result.message).toContain('Authentication failed');
    expect(result.action).toContain('/login');
  });

  test('rate-limit error has /model action', () => {
    const result = formatUserFacingError({ status: 429, message: 'Too Many Requests' });
    expect(result.kind).toBe('rate-limit');
    expect(result.action).toContain('/model');
  });

  test('context-overflow error has /compact action', () => {
    const result = formatUserFacingError(new Error('context window exceeded'));
    expect(result.kind).toBe('context-overflow');
    expect(result.action).toContain('/compact');
  });

  test('network error has /model action', () => {
    const result = formatUserFacingError(new Error('fetch failed'));
    expect(result.kind).toBe('network');
    expect(result.action).toContain('/model');
  });

  test('generic error uses summarizeError fallback and has /model action', () => {
    const result = formatUserFacingError(new Error('some unknown thing'));
    expect(result.kind).toBe('generic');
    expect(result.message).toMatch(/provider error/i);
    expect(result.action).toContain('/model');
  });

  test('formatUserFacingErrorLine returns message + action concatenated', () => {
    const line = formatUserFacingErrorLine(new Error('socket hang up'));
    expect(typeof line).toBe('string');
    expect(line.length).toBeGreaterThan(0);
    // Should contain both halves
    expect(line).toMatch(/network/i);
    expect(line).toMatch(/\/model|retry/i);
  });
});

// ---------------------------------------------------------------------------
// TURN_ERROR -> SystemMessageRouter integration
// ---------------------------------------------------------------------------

function makeConversation(): {
  addSystemMessage: ReturnType<typeof mock>;
  addTypedSystemMessage: ReturnType<typeof mock>;
  _typedMessages: Array<{ msg: string; kind: string }>;
} {
  const _typedMessages: Array<{ msg: string; kind: string }> = [];
  return {
    addSystemMessage: mock((_msg: string) => {}),
    addTypedSystemMessage: mock((msg: string, kind: string) => { _typedMessages.push({ msg, kind }); }),
    _typedMessages,
  } as unknown as {
    addSystemMessage: ReturnType<typeof mock>;
    addTypedSystemMessage: ReturnType<typeof mock>;
    _typedMessages: Array<{ msg: string; kind: string }>;
  };
}

function makeTargetResolver(
  overrides: Partial<Record<SystemMessageKind, SystemMessageTarget>> = {},
): (kind: SystemMessageKind) => SystemMessageTarget {
  return (kind) => overrides[kind] ?? 'both';
}

/**
 * Simulates what main.ts TURN_ERROR handler does:
 * format the error and route it as a high-priority system message.
 */
function simulateTurnError(
  router: SystemMessageRouter,
  err: unknown,
): void {
  const { message, action } = formatUserFacingError(err);
  router.high(`[Error] ${message} ${action}`);
}

// W6.1 (the purge): SystemMessagesPanel was DELETE-disposition and has been
// removed; SystemMessageRouter no longer takes a panel argument at all (see
// system-message-router.ts's file doc — every message now reaches
// conversation.addTypedSystemMessage()). These tests used to also assert on
// a mock panel's push() calls; that assertion is gone, the conversation
// assertion is what remains and is unchanged in spirit.
describe('TURN_ERROR -> SystemMessageRouter', () => {
  test('auth error routes as high-priority message containing /login', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    simulateTurnError(router, { status: 401, message: 'Unauthorized' });

    expect(conv.addTypedSystemMessage).toHaveBeenCalledTimes(1);
    const [msg, kind] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(kind).toBe('system');
    expect(msg).toContain('/login');
  });

  test('rate-limit error routes as high-priority message containing /model', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    simulateTurnError(router, { status: 429, message: 'Too Many Requests' });

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toContain('/model');
  });

  test('context-overflow error routes as high-priority message containing /compact', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    simulateTurnError(router, new Error('context window exceeded'));

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toContain('/compact');
  });

  test('network error routes as high-priority message', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    simulateTurnError(router, new Error('fetch failed'));

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toMatch(/network/i);
  });

  test('generic error routes as high-priority message', () => {
    const conv = makeConversation();
    const router = createSystemMessageRouter(
      conv as unknown as ConversationManager,
      makeTargetResolver({ system: 'both' }),
    );

    simulateTurnError(router, new Error('completely unknown failure'));

    const [msg] = (conv.addTypedSystemMessage as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(msg).toMatch(/\[Error\]/i);
  });
});
