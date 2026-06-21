import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import { registerEmailMethods } from '../../../daemon/handlers/email/index.ts';
import type { EmailMethodsOptions } from '../../../daemon/handlers/email/config.ts';
import type {
  ImapEnvelopeSummary,
  ImapFullMessage,
} from '../../../daemon/handlers/email/imap-connector.ts';
import {
  makeConfig,
  makeCredentials,
  makeImapFactory,
  makeLogger,
  makeSmtpFactory,
  type FakeImapState,
  type FakeSmtpState,
  type LogEntry,
} from './fakes.ts';

const CONFIG = {
  'surfaces.email.host': 'mail.example.com',
  'surfaces.email.user': 'agent@example.com',
};
const SECRETS = { 'surfaces.email.password': 'word-style-fake-pass' };

const SUMMARY: ImapEnvelopeSummary = {
  uid: 11,
  from: 'Jane <jane@example.com>',
  subject: 'Hello',
  date: '2024-01-01',
  unread: true,
  bodyPreview: 'preview text',
  messageId: '<m1@example.com>',
};
const DETAIL: ImapFullMessage = {
  uid: 11,
  from: 'Jane <jane@example.com>',
  subject: 'Hello',
  date: '2024-01-01',
  messageId: '<m1@example.com>',
  bodyText: 'full body text',
  attachments: [{ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 4 }],
};

let workdir: string;
let logs: LogEntry[];
let imapState: FakeImapState;
let smtpState: FakeSmtpState;

function invocation(body: unknown, opts: { explicit?: boolean; query?: Record<string, string> } = {}) {
  return {
    body,
    query: opts.query ?? {},
    context: {
      authToken: 'token-fake',
      principalId: 'user-1',
      admin: true,
      scopes: ['read:email', 'write:email'],
      metadata: { explicitUserRequest: opts.explicit === true },
    },
  };
}

function buildContext(catalog: GatewayMethodCatalog): HandlerContext {
  return {
    catalog,
    credentials: makeCredentials({ ...SECRETS }),
    configManager: makeConfig({ ...CONFIG }),
    workingDirectory: workdir,
    homeDirectory: workdir,
    logger: makeLogger(logs),
  };
}

function register(catalog: GatewayMethodCatalog, options: EmailMethodsOptions) {
  return registerEmailMethods(buildContext(catalog), options);
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gv-email-'));
  logs = [];
  imapState = { listed: 0, read: 0, appended: [], closed: 0 };
  smtpState = { sent: [], closed: 0 };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('registerEmailMethods', () => {
  test('attaches handlers to the SDK builtin descriptors (no re-declaration)', () => {
    const catalog = new GatewayMethodCatalog();
    const ids = ['email.inbox.list', 'email.inbox.read', 'email.draft.create', 'email.send'];
    for (const id of ids) expect(catalog.hasHandler(id)).toBe(false);
    const teardown = register(catalog, {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState),
    });
    for (const id of ids) {
      expect(catalog.get(id)).toBeTruthy();
      expect(catalog.hasHandler(id)).toBe(true);
    }
    teardown();
    for (const id of ids) expect(catalog.hasHandler(id)).toBe(false);
  });

  test('email.inbox.list returns schema-shaped messages and never logs raw senders', async () => {
    const catalog = new GatewayMethodCatalog();
    register(catalog, {
      imapFactory: makeImapFactory(imapState, { summaries: [SUMMARY] }),
      smtpFactory: makeSmtpFactory(smtpState),
    });
    const result = (await catalog.invoke(
      'email.inbox.list',
      invocation({ limit: 5, unreadOnly: true }),
    )) as { messages: unknown[]; total: number };
    expect(result.total).toBe(1);
    expect(result.messages[0]).toEqual({
      uid: 11,
      from: 'Jane <jane@example.com>',
      subject: 'Hello',
      date: '2024-01-01',
      unread: true,
      bodyPreview: 'preview text',
      messageId: '<m1@example.com>',
    });
    expect(imapState.closed).toBe(1);
    const listLog = logs.find((l) => l.message === 'email.inbox.list');
    expect(JSON.stringify(listLog?.meta)).not.toContain('jane@example.com');
  });

  test('email.inbox.read accepts uid from the path query and returns detail', async () => {
    const catalog = new GatewayMethodCatalog();
    register(catalog, {
      imapFactory: makeImapFactory(imapState, { message: DETAIL }),
      smtpFactory: makeSmtpFactory(smtpState),
    });
    const result = (await catalog.invoke(
      'email.inbox.read',
      invocation({}, { query: { uid: '11' } }),
    )) as { uid: number; bodyText: string; attachments: unknown[] };
    expect(result.uid).toBe(11);
    expect(result.bodyText).toBe('full body text');
    expect(result.attachments.length).toBe(1);
  });

  test('email.draft.create appends a draft and returns {uid, draftId}', async () => {
    const catalog = new GatewayMethodCatalog();
    register(catalog, {
      imapFactory: makeImapFactory(imapState, { appendUid: 99 }),
      smtpFactory: makeSmtpFactory(smtpState),
    });
    const result = (await catalog.invoke(
      'email.draft.create',
      invocation({ to: 'rcpt@example.com', subject: 'Hi', body: 'Draft body' }),
    )) as { uid: number; draftId: string };
    expect(result.uid).toBe(99);
    expect(result.draftId.length).toBeGreaterThan(0);
    expect(imapState.appended.length).toBe(1);
    expect(imapState.appended[0]).toContain('To: rcpt@example.com');
  });

  test('email.draft.create rejects an invalid recipient with a 400', async () => {
    const catalog = new GatewayMethodCatalog();
    register(catalog, {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState),
    });
    await expect(
      catalog.invoke('email.draft.create', invocation({ to: 'not-an-email', subject: 'x', body: 'y' })),
    ).rejects.toMatchObject({ code: 'EMAIL_BAD_INPUT', status: 400 });
  });

  test('email.send requires confirmation: blocked without confirm/explicit, sends with both', async () => {
    const catalog = new GatewayMethodCatalog();
    register(catalog, {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState, {
        messageId: '<out@example.com>',
        sentAt: '2024-02-02T00:00:00.000Z',
      }),
    });
    const body = { to: 'rcpt@example.com', subject: 'Hi', body: 'Send body' };

    // Missing confirm.
    await expect(
      catalog.invoke('email.send', invocation(body, { explicit: true })),
    ).rejects.toMatchObject({ code: 'REQUIRE_CONFIRM', status: 403 });
    // confirm:true but not an explicit user request.
    await expect(
      catalog.invoke('email.send', invocation({ ...body, confirm: true }, { explicit: false })),
    ).rejects.toMatchObject({ code: 'REQUIRE_CONFIRM', status: 403 });
    expect(smtpState.sent.length).toBe(0);

    const result = (await catalog.invoke(
      'email.send',
      invocation({ ...body, confirm: true }, { explicit: true }),
    )) as { messageId: string; sentAt: string };
    expect(result.messageId).toBe('<out@example.com>');
    expect(result.sentAt).toBe('2024-02-02T00:00:00.000Z');
    expect(smtpState.sent.length).toBe(1);
    expect(smtpState.closed).toBe(1);
  });

  test('a missing-config invocation surfaces a mapped HandlerError', async () => {
    const catalog = new GatewayMethodCatalog();
    const ctx: HandlerContext = {
      catalog,
      credentials: makeCredentials({}),
      configManager: makeConfig({}),
      workingDirectory: workdir,
      homeDirectory: workdir,
      logger: makeLogger(logs),
    };
    registerEmailMethods(ctx, {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState),
    });
    await expect(
      catalog.invoke('email.inbox.list', invocation({})),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
  });
});
