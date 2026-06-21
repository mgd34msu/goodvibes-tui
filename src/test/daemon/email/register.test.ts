import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerEmailMethods,
  resolveEmailSettings,
  type ImapClient,
  type SmtpClient,
} from '../../../daemon/email/register.ts';
import type {
  ImapConnectionSettings,
  ImapEnvelopeSummary,
  ImapFullMessage,
} from '../../../daemon/email/imap-connector.ts';
import type { SmtpConnectionSettings, SmtpMessage, SmtpSendResult } from '../../../daemon/email/smtp-connector.ts';
import type { OperatorContext } from '../../../daemon/operator/index.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface RegisteredMethod {
  descriptor: Record<string, unknown>;
  handler: (input: { body: unknown; context: { principalId?: string; metadata?: Record<string, unknown> } }) => Promise<unknown>;
}

interface LogEntry { msg: string; meta?: unknown }

const SECRET_PASSWORD = 'super-secret-imap-pass';

function sampleSummary(overrides: Partial<ImapEnvelopeSummary> = {}): ImapEnvelopeSummary {
  return {
    uid: 10,
    from: 'Jane Doe <jane@example.com>',
    subject: 'Hello',
    date: 'Wed, 04 Mar 2026 10:00:00 +0000',
    unread: true,
    bodyPreview: 'Preview text',
    messageId: '<a@example.com>',
    ...overrides,
  };
}

function sampleFull(overrides: Partial<ImapFullMessage> = {}): ImapFullMessage {
  return {
    uid: 10,
    from: 'Jane Doe <jane@example.com>',
    subject: 'Hello',
    date: 'Wed, 04 Mar 2026 10:00:00 +0000',
    messageId: '<a@example.com>',
    bodyText: 'Full body text',
    bodyHtml: '<p>Full body text</p>',
    attachments: [{ filename: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 1234 }],
    ...overrides,
  };
}

function stubImap(overrides: Partial<ImapClient> = {}, capture?: { appended?: string[] }): ImapClient {
  return {
    async connect() {},
    async close() {},
    async listMessages() {
      return [sampleSummary(), sampleSummary({ uid: 11, unread: false, from: 'bob@example.com', messageId: '<b@example.com>' })];
    },
    async readMessage(uid: number) {
      return sampleFull({ uid });
    },
    async appendDraft(raw: string) {
      capture?.appended?.push(raw);
      return { uid: 77, mailbox: 'Drafts' };
    },
    ...overrides,
  };
}

function stubSmtp(overrides: Partial<SmtpClient> = {}, capture?: { sent?: SmtpMessage[] }): SmtpClient {
  return {
    async connect() {},
    async close() {},
    async send(message: SmtpMessage): Promise<SmtpSendResult> {
      capture?.sent?.push(message);
      return { messageId: '<sent-1@example.com>', sentAt: '2026-03-04T10:00:00.000Z' };
    },
    ...overrides,
  };
}

function makeHarness(opts?: {
  imap?: ImapClient;
  smtp?: SmtpClient;
  password?: string | null;
  config?: Record<string, unknown>;
  workingDirectory?: string;
  imapSettings?: (s: ImapConnectionSettings) => void;
  smtpSettings?: (s: SmtpConnectionSettings) => void;
}): {
  methods: Map<string, RegisteredMethod>;
  logs: LogEntry[];
  unregister: () => void;
} {
  const methods = new Map<string, RegisteredMethod>();
  const logs: LogEntry[] = [];
  const config: Record<string, unknown> = {
    'surfaces.email.host': 'mail.example.com',
    'surfaces.email.user': 'user@example.com',
    'surfaces.email.from': 'User <user@example.com>',
    'surfaces.email.imap.port': 993,
    'surfaces.email.smtp.port': 465,
    ...(opts?.config ?? {}),
  };
  const password = opts?.password === undefined ? SECRET_PASSWORD : opts.password;

  const catalog = {
    register(descriptor: Record<string, unknown>, handler: RegisteredMethod['handler']): () => void {
      const id = String(descriptor.id);
      methods.set(id, { descriptor, handler });
      return () => { methods.delete(id); };
    },
  };
  const secrets = {
    // resolveConfigSecret -> secrets.get(buildGoodVibesSecretKey(configKey)). The
    // password is returned for ANY email password key; null otherwise.
    async get(key: string): Promise<string | null> {
      if (/PASSWORD/i.test(key)) return password;
      return null;
    },
    async set() {},
  };
  const ctx = {
    catalog: catalog as unknown as OperatorContext['catalog'],
    secrets: secrets as unknown as OperatorContext['secrets'],
    configManager: {
      get: (key: string) => config[key],
      getCategory: () => ({}),
    } as unknown as OperatorContext['configManager'],
    workingDirectory: opts?.workingDirectory ?? '/tmp/email-test-work',
    homeDirectory: '/tmp/home',
    logger: {
      info(msg: string, meta?: unknown) { logs.push({ msg, meta }); },
      warn(msg: string, meta?: unknown) { logs.push({ msg, meta }); },
      error(msg: string, meta?: unknown) { logs.push({ msg, meta }); },
    },
  } satisfies OperatorContext;

  const imapCapture = { appended: [] as string[] };
  const smtpCapture = { sent: [] as SmtpMessage[] };
  const unregister = registerEmailMethods(ctx, {
    imapFactory: async (settings) => {
      opts?.imapSettings?.(settings);
      return opts?.imap ?? stubImap({}, imapCapture);
    },
    smtpFactory: async (settings) => {
      opts?.smtpSettings?.(settings);
      return opts?.smtp ?? stubSmtp({}, smtpCapture);
    },
  });
  return { methods, logs, unregister };
}

function invoke(
  methods: Map<string, RegisteredMethod>,
  id: string,
  body: unknown,
  explicitUserRequest = false,
): Promise<unknown> {
  const method = methods.get(id);
  if (!method) throw new Error(`method not registered: ${id}`);
  return method.handler({
    body,
    context: { principalId: 'user-1', metadata: explicitUserRequest ? { explicitUserRequest: true } : {} },
  });
}

// ---------------------------------------------------------------------------
// Registration / descriptor metadata
// ---------------------------------------------------------------------------

describe('registerEmailMethods registration', () => {
  it('registers exactly the four published method IDs', () => {
    const { methods, unregister } = makeHarness();
    expect([...methods.keys()].sort()).toEqual(
      ['email.draft.create', 'email.inbox.list', 'email.inbox.read', 'email.send'].sort(),
    );
    unregister();
    expect(methods.size).toBe(0);
  });

  it('maps access operator->admin and source daemon->builtin and strips effect/confirm', () => {
    const { methods, unregister } = makeHarness();
    for (const id of methods.keys()) {
      const d = methods.get(id)!.descriptor;
      expect(d.access).toBe('admin');
      expect(d.source).toBe('builtin');
      expect(d.effect).toBeUndefined();
      expect(d.confirm).toBeUndefined();
      expect(d.category).toBe('email');
      expect(Array.isArray(d.transport)).toBe(true);
    }
    expect(methods.get('email.inbox.list')!.descriptor.scopes).toEqual(['email:read']);
    expect(methods.get('email.inbox.read')!.descriptor.scopes).toEqual(['email:read']);
    expect(methods.get('email.draft.create')!.descriptor.scopes).toEqual(['email:write']);
    expect(methods.get('email.send')!.descriptor.scopes).toEqual(['email:send']);
    unregister();
  });

  it('exposes input/output schemas for every method', () => {
    const { methods, unregister } = makeHarness();
    for (const id of methods.keys()) {
      const d = methods.get(id)!.descriptor;
      expect(typeof d.inputSchema).toBe('object');
      expect(typeof d.outputSchema).toBe('object');
    }
    unregister();
  });
});

// ---------------------------------------------------------------------------
// resolveEmailSettings
// ---------------------------------------------------------------------------

describe('resolveEmailSettings', () => {
  function cfg(map: Record<string, unknown>): OperatorContext['configManager'] {
    return { get: (k: string) => map[k], getCategory: () => ({}) } as unknown as OperatorContext['configManager'];
  }
  const creds = (password: string | null) => ({
    async resolveRef() { return null; },
    async resolveConfigSecret() { return password; },
    async put() {},
    async has() { return false; },
  });

  it('resolves IMAP/SMTP settings from config + credential store', async () => {
    const settings = await resolveEmailSettings(
      cfg({
        'surfaces.email.host': 'mail.example.com',
        'surfaces.email.user': 'user@example.com',
        'surfaces.email.imap.port': 993,
        'surfaces.email.smtp.port': 587,
        'surfaces.email.smtp.secure': false,
      }),
      creds('pw'),
    );
    expect(settings.imap.host).toBe('mail.example.com');
    expect(settings.imap.port).toBe(993);
    expect(settings.imap.secure).toBe(true);
    expect(settings.imap.password).toBe('pw');
    expect(settings.smtp.port).toBe(587);
    expect(settings.smtp.secure).toBe(false);
    expect(settings.smtp.from).toBe('user@example.com');
  });

  it('throws EMAIL_NOT_CONFIGURED when host/user missing', async () => {
    await expect(resolveEmailSettings(cfg({}), creds('pw'))).rejects.toMatchObject({
      code: 'EMAIL_NOT_CONFIGURED',
    });
  });

  it('throws EMAIL_CREDENTIALS_MISSING when no password secret', async () => {
    await expect(
      resolveEmailSettings(
        cfg({ 'surfaces.email.host': 'h', 'surfaces.email.user': 'u@x.com' }),
        creds(null),
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_CREDENTIALS_MISSING' });
  });
});

// ---------------------------------------------------------------------------
// email.inbox.list (read-only, no confirm)
// ---------------------------------------------------------------------------

describe('email.inbox.list', () => {
  it('returns messages and total without confirmation', async () => {
    const { methods, unregister } = makeHarness();
    const result = (await invoke(methods, 'email.inbox.list', {})) as {
      messages: Array<Record<string, unknown>>;
      total: number;
    };
    expect(result.total).toBe(2);
    expect(result.messages[0].uid).toBe(10);
    expect(result.messages[0].from).toBe('Jane Doe <jane@example.com>');
    expect(result.messages[0]).toHaveProperty('bodyPreview');
    expect(result.messages[0]).toHaveProperty('messageId');
    unregister();
  });

  it('clamps limit into [1,100] and passes options through', async () => {
    let seen: { limit: number; since?: string; unreadOnly: boolean } | null = null;
    const imap = stubImap({
      async listMessages(options) { seen = options; return []; },
    });
    const { methods, unregister } = makeHarness({ imap });
    await invoke(methods, 'email.inbox.list', { limit: 9999, unreadOnly: false, since: '2026-01-01T00:00:00.000Z' });
    expect(seen!.limit).toBe(100);
    expect(seen!.unreadOnly).toBe(false);
    expect(seen!.since).toBe('2026-01-01T00:00:00.000Z');
    unregister();
  });

  it('defaults unreadOnly to true and limit to 10', async () => {
    let seen: { limit: number; unreadOnly: boolean } | null = null;
    const imap = stubImap({ async listMessages(options) { seen = options; return []; } });
    const { methods, unregister } = makeHarness({ imap });
    await invoke(methods, 'email.inbox.list', {});
    expect(seen!.limit).toBe(10);
    expect(seen!.unreadOnly).toBe(true);
    unregister();
  });

  it('rejects an invalid since date', async () => {
    const { methods, unregister } = makeHarness();
    await expect(invoke(methods, 'email.inbox.list', { since: 'nope' })).rejects.toMatchObject({
      code: 'EMAIL_BAD_INPUT',
    });
    unregister();
  });

  it('logs sender digests, never raw addresses', async () => {
    const { methods, logs, unregister } = makeHarness();
    await invoke(methods, 'email.inbox.list', {});
    const entry = logs.find((l) => l.msg === 'email.inbox.list')!;
    const serialized = JSON.stringify(entry.meta);
    expect(serialized.includes('jane@example.com')).toBe(false);
    expect((entry.meta as { senders: string[] }).senders.every((s) => s.length === 16)).toBe(true);
    unregister();
  });

  it('surfaces EMAIL_CREDENTIALS_MISSING when password secret absent', async () => {
    const { methods, unregister } = makeHarness({ password: null });
    await expect(invoke(methods, 'email.inbox.list', {})).rejects.toMatchObject({
      code: 'EMAIL_CREDENTIALS_MISSING',
    });
    unregister();
  });
});

// ---------------------------------------------------------------------------
// email.inbox.read (read-only, no confirm)
// ---------------------------------------------------------------------------

describe('email.inbox.read', () => {
  it('returns a full message with body and attachments', async () => {
    const { methods, unregister } = makeHarness();
    const result = (await invoke(methods, 'email.inbox.read', { uid: 10 })) as Record<string, unknown>;
    expect(result.uid).toBe(10);
    expect(result.bodyText).toBe('Full body text');
    expect(result.bodyHtml).toBe('<p>Full body text</p>');
    expect(Array.isArray(result.attachments)).toBe(true);
    unregister();
  });

  it('requires a positive integer uid', async () => {
    const { methods, unregister } = makeHarness();
    await expect(invoke(methods, 'email.inbox.read', {})).rejects.toMatchObject({ code: 'EMAIL_BAD_INPUT' });
    await expect(invoke(methods, 'email.inbox.read', { uid: -1 })).rejects.toMatchObject({ code: 'EMAIL_BAD_INPUT' });
    unregister();
  });
});

// ---------------------------------------------------------------------------
// email.draft.create (confirmed-effect)
// ---------------------------------------------------------------------------

describe('email.draft.create', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'gv-email-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  const validBody = { to: 'bob@y.com', subject: 'Draft subj', body: 'Draft body', confirm: true };

  it('rejects when confirm is missing', async () => {
    const { methods, unregister } = makeHarness({ workingDirectory: workDir });
    const { confirm: _omit, ...noConfirm } = validBody;
    await expect(invoke(methods, 'email.draft.create', noConfirm, true)).rejects.toMatchObject({
      code: 'OPERATOR_CONFIRMATION_REQUIRED',
    });
    unregister();
  });

  it('rejects when explicitUserRequest is absent even with confirm:true', async () => {
    const { methods, unregister } = makeHarness({ workingDirectory: workDir });
    await expect(invoke(methods, 'email.draft.create', validBody, false)).rejects.toMatchObject({
      code: 'OPERATOR_CONFIRMATION_REQUIRED',
    });
    unregister();
  });

  it('appends a draft, persists it encrypted at rest, and returns a receipt', async () => {
    const appended: string[] = [];
    const imap = stubImap({}, { appended });
    const { methods, unregister } = makeHarness({ imap, workingDirectory: workDir });
    const result = (await invoke(methods, 'email.draft.create', validBody, true)) as {
      uid: number;
      draftId: string;
    };
    expect(result.uid).toBe(77);
    expect(typeof result.draftId).toBe('string');
    expect(result.draftId.length).toBeGreaterThan(0);
    // The appended raw message includes the headers + body.
    expect(appended[0]).toContain('Subject: Draft subj');
    expect(appended[0]).toContain('To: bob@y.com');

    // The on-disk draft body must be ciphertext, NOT plaintext.
    const dbPath = join(workDir, '.goodvibes', 'tui', 'operator', 'email-drafts.sqlite');
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const { readFileSync } = await import('node:fs');
    const db = new SQL.Database(readFileSync(dbPath));
    const rows = db.exec('SELECT body_ciphertext FROM email_drafts');
    const ciphertext = String(rows[0]!.values[0]![0]);
    db.close();
    expect(ciphertext.includes('Draft body')).toBe(false);
    // base64(iv|tag|ct) decodes to >= 28 bytes (12 iv + 16 tag).
    expect(Buffer.from(ciphertext, 'base64').length).toBeGreaterThanOrEqual(28);
    unregister();
  });

  it('rejects an invalid recipient', async () => {
    const { methods, unregister } = makeHarness({ workingDirectory: workDir });
    await expect(
      invoke(methods, 'email.draft.create', { ...validBody, to: 'not-an-email' }, true),
    ).rejects.toMatchObject({ code: 'EMAIL_BAD_INPUT' });
    unregister();
  });

  it('rejects a missing subject/body', async () => {
    const { methods, unregister } = makeHarness({ workingDirectory: workDir });
    await expect(invoke(methods, 'email.draft.create', { ...validBody, subject: '' }, true)).rejects.toMatchObject({
      code: 'EMAIL_BAD_INPUT',
    });
    unregister();
  });
});

// ---------------------------------------------------------------------------
// email.send (confirmed-effect)
// ---------------------------------------------------------------------------

describe('email.send', () => {
  const validBody = { to: 'bob@y.com', subject: 'Subj', body: 'Body', confirm: true };

  it('rejects when confirm is missing (daemon must reject)', async () => {
    const { methods, unregister } = makeHarness();
    const { confirm: _omit, ...noConfirm } = validBody;
    await expect(invoke(methods, 'email.send', noConfirm, true)).rejects.toMatchObject({
      code: 'OPERATOR_CONFIRMATION_REQUIRED',
    });
    unregister();
  });

  it('rejects when explicitUserRequest is absent', async () => {
    const { methods, unregister } = makeHarness();
    await expect(invoke(methods, 'email.send', validBody, false)).rejects.toMatchObject({
      code: 'OPERATOR_CONFIRMATION_REQUIRED',
    });
    unregister();
  });

  it('sends and returns a certified receipt (messageId + sentAt)', async () => {
    const sent: SmtpMessage[] = [];
    const smtp = stubSmtp({}, { sent });
    const { methods, logs, unregister } = makeHarness({ smtp });
    const result = (await invoke(methods, 'email.send', { ...validBody, inReplyTo: '<prev@x.com>' }, true)) as {
      messageId: string;
      sentAt: string;
    };
    expect(result.messageId).toBe('<sent-1@example.com>');
    expect(Number.isNaN(new Date(result.sentAt).getTime())).toBe(false);
    expect(sent[0].to).toBe('bob@y.com');
    expect(sent[0].inReplyTo).toBe('<prev@x.com>');

    // The log entry digests the recipient and never leaks the password.
    const entry = logs.find((l) => l.msg === 'email.send')!;
    const serialized = JSON.stringify(entry.meta);
    expect(serialized.includes(SECRET_PASSWORD)).toBe(false);
    expect(serialized.includes('bob@y.com')).toBe(false);
    unregister();
  });

  it('rejects an invalid recipient', async () => {
    const { methods, unregister } = makeHarness();
    await expect(invoke(methods, 'email.send', { ...validBody, to: 'bad' }, true)).rejects.toMatchObject({
      code: 'EMAIL_BAD_INPUT',
    });
    unregister();
  });

  it('never echoes credentials in the response', async () => {
    const { methods, unregister } = makeHarness();
    const result = await invoke(methods, 'email.send', validBody, true);
    expect(JSON.stringify(result).includes(SECRET_PASSWORD)).toBe(false);
    unregister();
  });
});
