/**
 * The mail/calendar terminal surfaces, exercised against the REAL daemon
 * handlers registered into a real GatewayMethodCatalog.
 *
 * The point of going through the real handlers rather than a stub gateway is
 * that the whole reason these surfaces exist is a wiring claim: that
 * `GatewayMethodCatalog.invoke()` reaches an `email.*` / `calendar.*` handler
 * even though every one of those descriptors carries `invokable: false`. A test
 * against a fake gateway would pass while the product was dead. These tests
 * fail if that claim ever stops being true.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { isDaemonOwnedConfigKey, isDaemonOwnedSecretKey } from '@pellux/goodvibes-sdk/platform/config';
import type { HandlerContext } from '../../daemon/handlers/context.ts';
import { registerEmailMethods } from '../../daemon/handlers/email/index.ts';
import {
  makeConfig,
  makeCredentials,
  makeImapFactory,
  makeLogger,
  makeSmtpFactory,
  type FakeImapState,
  type FakeSmtpState,
  type LogEntry,
} from '../daemon/email/fakes.ts';
import {
  daemonErrorCode,
  describeConnectionProbe,
  probeConnection,
  renderConnectionStatus,
  unwiredConnectionStatus,
} from '../../input/commands/connection-status.ts';
import { parseComposeArgs, renderInboxList, renderMessage } from '../../input/commands/mail-runtime.ts';
import { formatWhen, parseEventArgs, renderAgenda } from '../../input/commands/calendar-runtime.ts';
import {
  initialConnectionEntries,
  refreshConnectionEntries,
  selectedConnectionEntry,
} from '../../input/settings-modal-connections.ts';
import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_GROUPS } from '../../input/settings-modal-types.ts';

const CONFIGURED = {
  'surfaces.email.host': 'mail.example.com',
  'surfaces.email.user': 'agent@example.com',
};
const SECRETS = { 'surfaces.email.password': 'word-style-fake-pass' };

let workdir: string;
let logs: LogEntry[];
let imapState: FakeImapState;
let smtpState: FakeSmtpState;

function buildContext(
  catalog: GatewayMethodCatalog,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): HandlerContext {
  return {
    catalog,
    credentials: makeCredentials({ ...secrets }),
    configManager: makeConfig({ ...config }),
    workingDirectory: workdir,
    homeDirectory: workdir,
    logger: makeLogger(logs),
  };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'gv-mailcal-'));
  logs = [];
  imapState = { listed: 0, read: 0, appended: [], closed: 0 };
  smtpState = { sent: [], closed: 0 };
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('the invokable:false wiring claim', () => {
  test('a probe reaches the real email handler through the in-process catalog', async () => {
    const catalog = new GatewayMethodCatalog();
    // Sanity: the descriptor really does carry invokable:false, so this test is
    // proving the bypass rather than passing because the flag went away.
    expect(catalog.get('email.inbox.list')?.invokable).toBe(false);

    const unregister = registerEmailMethods(buildContext(catalog, CONFIGURED, SECRETS), {
      imapFactory: makeImapFactory(imapState, { summaries: [] }),
      smtpFactory: makeSmtpFactory(smtpState),
      workingDirectory: workdir,
    });
    try {
      const status = await probeConnection(catalog, 'mail');
      expect(status.state).toBe('ready');
      expect(imapState.listed).toBe(1);
      expect(status.nextActions).toEqual([]);
    } finally {
      unregister();
    }
  });

  test('an unconfigured account reports needs-setup with the daemon\'s own next step', async () => {
    const catalog = new GatewayMethodCatalog();
    const unregister = registerEmailMethods(buildContext(catalog, {}, {}), {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState),
      workingDirectory: workdir,
    });
    try {
      const status = await probeConnection(catalog, 'mail');
      expect(status.state).toBe('needs-setup');
      // The concrete keys the daemon actually reads — never a vague message.
      expect(status.nextActions.join('\n')).toContain('surfaces.email.host');
      expect(status.nextActions.join('\n')).toContain('surfaces.email.user');
      expect(imapState.listed).toBe(0);
    } finally {
      unregister();
    }
  });

  test('a configured account with no stored password reports the missing credential only', async () => {
    const catalog = new GatewayMethodCatalog();
    const unregister = registerEmailMethods(buildContext(catalog, CONFIGURED, {}), {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState),
      workingDirectory: workdir,
    });
    try {
      const status = await probeConnection(catalog, 'mail');
      expect(status.state).toBe('needs-setup');
      const actions = status.nextActions.join('\n');
      expect(actions).toContain('GOODVIBES_SURFACES_EMAIL_PASSWORD');
      // Host/user are already set; re-listing them would be noise.
      expect(actions).not.toContain('surfaces.email.host');
    } finally {
      unregister();
    }
  });

  test('an unregistered calendar handler is reported as unreachable, not as needs-setup', async () => {
    // No calendar handlers registered: the catalog holds the descriptor with
    // invokable:false and no handler, which is the honest "this build does not
    // serve it" case.
    const status = await probeConnection(new GatewayMethodCatalog(), 'calendar');
    expect(status.state).toBe('unreachable');
    expect(status.detail).toContain('calendar.events.list');
  });
});

describe('daemon ownership of what setup writes', () => {
  test('the surfaces.* SETTINGS the daemon reads are daemon-owned, so /config set survives this client closing', () => {
    // The requirement: anything configured from a surface keeps working with
    // that surface closed. For the non-secret settings that already holds,
    // because `surfaces.` is a daemon-owned prefix.
    expect(isDaemonOwnedConfigKey('surfaces.email.host' as never)).toBe(true);
    expect(isDaemonOwnedConfigKey('surfaces.email.user' as never)).toBe(true);
    expect(isDaemonOwnedConfigKey('surfaces.calendar.caldavUrl' as never)).toBe(true);
  });

  test('the mail/calendar PASSWORDS are not daemon-owned — a known gap this surface refuses to paper over', () => {
    // A credential is filed in the daemon tier only when a daemon-owned config
    // path declares it. `surfaces.email.password` and
    // `surfaces.calendar.caldavPassword` are read by this repo's daemon but
    // declared in neither CONFIG_SCHEMA nor the SDK's non-schema daemon-owned
    // path list, so they strand in whichever client silo wrote them.
    //
    // Slack's token is the control: it IS declared, and it routes correctly.
    // When the owning round declares the two below, this test fails — and the
    // setup guidance in connection-status.ts should switch to `/secrets set`
    // at the same time.
    expect(isDaemonOwnedSecretKey('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe(true);
    expect(isDaemonOwnedSecretKey('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe(false);
    expect(isDaemonOwnedSecretKey('GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD')).toBe(false);
  });

  test('setup guidance never tells the operator to run a store write that would strand', () => {
    const status = describeConnectionProbe('mail', { code: 'EMAIL_CREDENTIALS_MISSING' });
    const actions = status.nextActions.join('\n');
    expect(actions).toContain('GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(actions).toContain("daemon's environment");
    expect(actions).not.toContain('/secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD');
  });
});

describe('status derivation', () => {
  test('a successful probe is the only thing that reports ready', () => {
    expect(describeConnectionProbe('mail', null).state).toBe('ready');
    expect(describeConnectionProbe('mail', new Error('boom')).state).toBe('unreachable');
  });

  test('the machine code is read from a direct throw and from a wire body alike', () => {
    expect(daemonErrorCode({ code: 'EMAIL_NOT_CONFIGURED' })).toBe('EMAIL_NOT_CONFIGURED');
    expect(daemonErrorCode({ body: { code: 'CALENDAR_NOT_CONFIGURED' } })).toBe('CALENDAR_NOT_CONFIGURED');
    expect(daemonErrorCode(new Error('no code here'))).toBeNull();
    expect(daemonErrorCode(null)).toBeNull();
  });

  test('an unwired gateway says so plainly rather than claiming nothing is configured', () => {
    const status = unwiredConnectionStatus('mail');
    expect(status.state).toBe('unreachable');
    expect(status.detail).toContain('not wired');
  });

  test('every non-ready status carries at least one concrete next step', () => {
    for (const error of [{ code: 'EMAIL_NOT_CONFIGURED' }, { code: 'METHOD_NOT_FOUND' }, new Error('x')]) {
      const status = describeConnectionProbe('mail', error);
      expect(status.state).not.toBe('ready');
      expect(status.nextActions.length).toBeGreaterThan(0);
    }
  });

  test('rendering shows the state, the detail and the next steps', () => {
    const text = renderConnectionStatus(describeConnectionProbe('calendar', { code: 'CALENDAR_NOT_CONFIGURED', message: 'nope' }));
    expect(text).toContain('Calendar: needs-setup');
    expect(text).toContain('Next:');
    expect(text).toContain('surfaces.calendar.caldavUrl');
  });
});

describe('argument parsing', () => {
  test('a compose line needs all three fields', () => {
    expect(parseComposeArgs('a@b.com | Subject | Body')).toEqual({ to: 'a@b.com', subject: 'Subject', body: 'Body' });
    expect(parseComposeArgs('a@b.com | Subject')).toBeNull();
    expect(parseComposeArgs('a@b.com |  | Body')).toBeNull();
    expect(parseComposeArgs('')).toBeNull();
  });

  test('an event line needs all three fields', () => {
    expect(parseEventArgs('Review | 2026-08-01T14:00:00Z | 2026-08-01T15:00:00Z'))
      .toEqual({ title: 'Review', start: '2026-08-01T14:00:00Z', end: '2026-08-01T15:00:00Z' });
    expect(parseEventArgs('Review | only-one-time')).toBeNull();
  });
});

describe('rendering', () => {
  test('an empty inbox says so instead of rendering an empty table', () => {
    expect(renderInboxList([])).toContain('empty');
  });

  test('inbox rows carry the uid the read verb needs', () => {
    const text = renderInboxList([
      { uid: 42, from: 'Jane <jane@example.com>', subject: 'Hello', date: 'd', unread: true, bodyPreview: 'p' },
    ]);
    expect(text).toContain('42');
    expect(text).toContain('Hello');
    expect(text).toContain('/mail read <uid>');
  });

  test('a message with no plain-text body says so rather than rendering blank', () => {
    const text = renderMessage({ uid: 1, from: 'a', subject: 's', date: 'd' });
    expect(text).toContain('(no plain-text body)');
  });

  test('an unparseable event time is shown verbatim, not replaced', () => {
    expect(formatWhen('not-a-date')).toBe('not-a-date');
    expect(formatWhen('2026-08-01T14:00:00Z')).toBe('2026-08-01 14:00');
  });

  test('an empty agenda says so', () => {
    expect(renderAgenda([])).toContain('No events');
  });
});

describe('the Connections category of the settings workspace', () => {
  test('rows start as checking, never as a settled state the daemon has not confirmed', () => {
    const entries = initialConnectionEntries();
    expect(entries.map((e) => e.surface)).toEqual(['mail', 'calendar']);
    for (const entry of entries) {
      expect(entry.state).toBe('checking');
      // A placeholder must not carry next steps: it has established nothing.
      expect(entry.nextActions).toEqual([]);
    }
  });

  test('a refresh replaces the placeholders with the daemon\'s real answer and repaints', async () => {
    const catalog = new GatewayMethodCatalog();
    const unregister = registerEmailMethods(buildContext(catalog, CONFIGURED, SECRETS), {
      imapFactory: makeImapFactory(imapState, { summaries: [] }),
      smtpFactory: makeSmtpFactory(smtpState),
      workingDirectory: workdir,
    });
    let painted = 0;
    const host = {
      active: true,
      selectedIndex: 0,
      connectionEntries: initialConnectionEntries(),
      connectionsRefreshing: false,
      gatewayMethods: catalog,
      requestRender: () => { painted += 1; },
    };
    try {
      await refreshConnectionEntries(host);
      expect(painted).toBe(1);
      expect(host.connectionEntries.find((e) => e.surface === 'mail')?.state).toBe('ready');
      // Calendar has no handler in this catalog, so it must not claim ready.
      expect(host.connectionEntries.find((e) => e.surface === 'calendar')?.state).toBe('unreachable');
    } finally {
      unregister();
    }
  });

  test('a probe that lands after the workspace closed is discarded, not written back', async () => {
    const host = {
      active: false,
      selectedIndex: 0,
      connectionEntries: initialConnectionEntries(),
      connectionsRefreshing: false,
      gatewayMethods: new GatewayMethodCatalog(),
      requestRender: () => { throw new Error('must not repaint a closed workspace'); },
    };
    await refreshConnectionEntries(host);
    expect(host.connectionEntries.every((e) => e.state === 'checking')).toBe(true);
  });

  test('overlapping refreshes are dropped rather than queued per keystroke', async () => {
    const host = {
      active: true,
      selectedIndex: 0,
      connectionEntries: initialConnectionEntries(),
      connectionsRefreshing: true,
      gatewayMethods: new GatewayMethodCatalog(),
      requestRender: () => { throw new Error('must not repaint while a probe is in flight'); },
    };
    await refreshConnectionEntries(host);
    expect(host.connectionEntries.every((e) => e.state === 'checking')).toBe(true);
  });

  test('the category is registered in the workspace rail', () => {
    expect(SETTINGS_CATEGORIES).toContain('connections');
    const group = SETTINGS_CATEGORY_GROUPS.find((g) => g.categories.includes('connections'));
    expect(group?.label).toBe('Surfaces & Cloud');
  });

  test('the selected row is clamped rather than throwing on a stale index', () => {
    const host = {
      active: true,
      selectedIndex: 99,
      connectionEntries: initialConnectionEntries(),
      connectionsRefreshing: false,
      gatewayMethods: null,
      requestRender: null,
    };
    expect(selectedConnectionEntry(host)?.surface).toBe('calendar');
    expect(selectedConnectionEntry({ ...host, connectionEntries: [] })).toBeNull();
  });
});

describe('an installation where the surfaces section was never created', () => {
  /**
   * The real ConfigManager does not return undefined for a key under a section
   * that does not exist — it throws. `surfaces.email` is not a CONFIG_SCHEMA
   * section, so that is the state of every machine that has never configured
   * mail, which is exactly the state this status surface has to describe well.
   */
  function throwingConfig(): HandlerContext['configManager'] {
    return {
      get: ((key: string) => {
        throw new Error(`Invalid config path: section '${key.split('.').slice(0, 2).join('.')}' does not exist`);
      }) as HandlerContext['configManager']['get'],
      getCategory: (() => ({})) as HandlerContext['configManager']['getCategory'],
    };
  }

  test('reports needs-setup with real next steps, not an opaque config-path error', async () => {
    const catalog = new GatewayMethodCatalog();
    const unregister = registerEmailMethods({
      catalog,
      credentials: makeCredentials({}),
      configManager: throwingConfig(),
      workingDirectory: workdir,
      homeDirectory: workdir,
      logger: makeLogger(logs),
    }, {
      imapFactory: makeImapFactory(imapState),
      smtpFactory: makeSmtpFactory(smtpState),
      workingDirectory: workdir,
    });
    try {
      const status = await probeConnection(catalog, 'mail');
      expect(status.state).toBe('needs-setup');
      expect(status.detail).not.toContain('Invalid config path');
      expect(status.nextActions.join('\n')).toContain('surfaces.email.host');
    } finally {
      unregister();
    }
  });
});
