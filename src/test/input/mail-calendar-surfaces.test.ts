/**
 * The mail/calendar terminal surfaces, and where their verbs are answered now.
 *
 * ── The claim that changed ────────────────────────────────────────────────
 *
 * This file used to prove a WIRING claim: that this repository's own runtime
 * composition handed the platform what it needed for `email.*` and `calendar.*`
 * to have live handlers, because without `homeDirectory` the calendar
 * composition returned null and without `emailServiceDeps` the mail one did,
 * and either way the verbs stayed cataloged-but-unhandled while every surface
 * below reported "unreachable" on a daemon that was working perfectly.
 *
 * That composition is the daemon's now. This app answers no verbs at all — its
 * catalog is empty by construction — and mail and calendar reach the daemon
 * over the wire like every other verb family. So the claim this file makes is
 * the opposite one, and it is the honest one for a client: an empty catalog
 * reports UNREACHABLE, plainly, rather than inventing "nothing is configured"
 * for a daemon it never asked. The end-to-end proof that a real daemon answers
 * these verbs is the adopt-against-a-real-daemon suite
 * (src/test/runtime/client-adopt-e2e.test.ts) and the daemon repository's own
 * conformance suites.
 *
 * Everything else here — the argument parsing, the rendering, the status
 * derivation, the Connections category's behaviour — is surface work and is
 * unchanged by the split.
 */

import { describe, expect, test } from 'bun:test';
import { isDaemonOwnedConfigKey, isDaemonOwnedSecretKey } from '@pellux/goodvibes-sdk/platform/config';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
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

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

describe('a client with no verbs of its own says so instead of guessing', () => {
  const services = getTestRuntimeServices();

  test('this composition registers no mail or calendar handlers, because it registers none at all', () => {
    // Not an omission: the catalog exists only to satisfy the SDK's
    // startExternalServices parameter in adopt-only mode. Nothing is served off
    // it, and a handler appearing here would mean a second implementation had
    // come back into this process alongside the daemon's.
    for (const methodId of ['email.inbox.list', 'email.send', 'calendar.events.list', 'calendar.events.create'] as const) {
      expect(services.gatewayMethods.hasHandler(methodId), `${methodId} must not be answered in-process`).toBe(false);
    }
  });

  test('an empty catalog is reported as unreachable, never as needs-setup', async () => {
    // The distinction is the whole point. "needs-setup" tells the user to go
    // configure an account; "unreachable" tells them the daemon is not
    // answering. Reporting the first when the second is true sends someone to
    // re-enter a password that was never the problem.
    for (const surface of ['mail', 'calendar'] as const) {
      const status = await probeConnection(new GatewayMethodCatalog(), surface);
      expect(status.state).toBe('unreachable');
      expect(status.nextActions.length).toBeGreaterThan(0);
    }
  });
});

describe('daemon ownership of what setup writes', () => {
  test('the surfaces.* SETTINGS the daemon reads are daemon-owned, so /config set survives this client closing', () => {
    // The requirement: anything configured from a surface keeps working with
    // that surface closed. For the non-secret settings that already held,
    // because `surfaces.` is a daemon-owned prefix.
    expect(isDaemonOwnedConfigKey('surfaces.email.host' as never)).toBe(true);
    expect(isDaemonOwnedConfigKey('surfaces.email.user' as never)).toBe(true);
    expect(isDaemonOwnedConfigKey('surfaces.calendar.caldavUrl' as never)).toBe(true);
  });

  test('the mail/calendar PASSWORDS are daemon-owned too, which is what closed the gap this surface refused to paper over', () => {
    // This assertion is inverted from what it was, and the inversion is the
    // point — the previous version said in as many words that it would fail
    // when the owning round declared these paths, and that the setup guidance
    // should change in the same commit. Both happened here.
    //
    // A credential is filed in the daemon tier only when a daemon-owned config
    // path declares it. `surfaces.email.password` and
    // `surfaces.calendar.caldavPassword` were read by this repo's daemon and
    // declared in neither CONFIG_SCHEMA nor the platform's non-schema
    // daemon-owned path list, so they stranded in whichever client silo wrote
    // them. The platform round that began serving email.* and calendar.*
    // declares the whole mail and CalDAV connection, not just the passwords, on
    // the stated ground that a password with no host and no user is not a usable
    // credential either. Slack's token remains the control: always declared,
    // always routed correctly.
    expect(isDaemonOwnedSecretKey('GOODVIBES_SURFACES_SLACK_BOT_TOKEN')).toBe(true);
    expect(isDaemonOwnedSecretKey('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe(true);
    expect(isDaemonOwnedSecretKey('GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD')).toBe(true);
  });

  test('setup guidance now names the store write that reaches the daemon', () => {
    // The other half of the flip above: with the keys declared, a write
    // carrying an explicit scope is RELOCATED to the daemon tier rather than
    // filed where it was asked for, so `/secrets set` is the step that works —
    // and it needs no restart and no shell on the daemon's machine.
    const status = describeConnectionProbe('mail', { code: 'EMAIL_CREDENTIALS_MISSING' });
    const actions = status.nextActions.join('\n');
    expect(actions).toContain('/secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(actions).toContain('daemon-owned credential');
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

  test('an unknown failure still carries a next step rather than a bare message', () => {
    // The platform's config readers treat an absent SECTION as an absent value,
    // because `ConfigManager.get` throws for one and on a machine where nobody
    // ran setup that is the normal state, not a fault. This surface is the last
    // line if that ever regresses: an `Invalid config path` string is a
    // developer message, and whatever state it lands in must still be
    // actionable rather than a dead end.
    const status = describeConnectionProbe('mail', {
      message: "Invalid config path: section 'surfaces.email' does not exist",
    });
    expect(status.state).not.toBe('ready');
    expect(status.nextActions.length).toBeGreaterThan(0);
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
  const services = getTestRuntimeServices();

  test('rows start as checking, never as a settled state the daemon has not confirmed', () => {
    const entries = initialConnectionEntries();
    expect(entries.map((e) => e.surface)).toEqual(['mail', 'calendar']);
    for (const entry of entries) {
      expect(entry.state).toBe('checking');
      // A placeholder must not carry next steps: it has established nothing.
      expect(entry.nextActions).toEqual([]);
    }
  });

  test('a refresh replaces the placeholders with a settled answer and repaints', async () => {
    let painted = 0;
    const host = {
      active: true,
      selectedIndex: 0,
      connectionEntries: initialConnectionEntries(),
      connectionsRefreshing: false,
      gatewayMethods: services.gatewayMethods,
      requestRender: () => { painted += 1; },
    };
    await refreshConnectionEntries(host);
    expect(painted).toBe(1);
    // Both rows must LEAVE 'checking' for a state something actually
    // established, and carry a next step with it. Against this client's empty
    // catalog that state is 'unreachable' — the honest answer when no daemon
    // has been asked. What must never happen is a row left in 'checking'
    // forever, or one that settles with no next step.
    for (const surface of ['mail', 'calendar']) {
      const entry = host.connectionEntries.find((e) => e.surface === surface);
      expect(entry?.state, `${surface} row`).not.toBe('checking');
      expect(entry?.nextActions.length).toBeGreaterThan(0);
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
