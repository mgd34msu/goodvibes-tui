/**
 * connection-status.ts — honest connection state for the mail and calendar
 * capabilities, derived from the daemon's own answer rather than re-decided
 * here.
 *
 * The daemon owns mail (IMAP/SMTP) and calendar (CalDAV/ICS) end to end: the
 * settings resolution, the credential read, the connectors, the confirmation
 * posture (see src/daemon/handlers/email and src/daemon/handlers/calendar).
 * The TUI holds no second copy of any of it. So "is mail connected?" is not a
 * question this file answers from config — it is a question it ASKS, by
 * invoking the cheapest read verb and reading the failure code that comes back:
 *
 *   EMAIL_NOT_CONFIGURED       host/user are missing
 *   EMAIL_CREDENTIALS_MISSING  host/user are set, the password secret is not
 *   CALENDAR_NOT_CONFIGURED    CalDAV url/user are missing
 *
 * Those codes are the daemon's, and the next step each one implies is the
 * daemon's requirement, not a guess here. If the daemon changes what it needs,
 * this surface follows, because it never encoded the rule.
 *
 * ## Why the in-process catalog and not the operator HTTP wire
 *
 * Every `email.*` / `calendar.*` descriptor the SDK catalogs carries
 * `invokable: false`. On the generic HTTP/WS dispatch path that flag is checked
 * by `validateGatewayInvocation` BEFORE any handler lookup and answered with a
 * flat 400 `NOT_INVOKABLE` — so `sdk.operator.invoke('email.inbox.list', …)`
 * cannot reach these verbs no matter what is configured, and a surface built on
 * it would be a dead button.
 *
 * `GatewayMethodCatalog.invoke()` deliberately does NOT consult that flag: a
 * runtime that has registered a real handler is authoritative over whether its
 * own method works. This product registers those handlers into its own catalog
 * at composition time (`createDaemonHandlerComposition`, called by the shared
 * `createRuntimeServices` root that both the TUI and the daemon boot from), so
 * the in-process catalog is a live, correct route to the same code — the same
 * seam `/review` already uses for `checkpoints.*`. That is what these surfaces
 * call.
 *
 * Nothing here reads, holds, or renders a credential. The probe asks for one
 * item and discards it; only presence or absence of a failure reaches the UI.
 */

import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';

export type ConnectionSurface = 'mail' | 'calendar';

/**
 * What a surface can be.
 *
 * `checking` exists because the probe is real I/O and the settings workspace
 * renders synchronously — a row has to say something true while the answer is
 * in flight, and "checking" is true where "not configured" would be invented.
 */
export type ConnectionState = 'ready' | 'needs-setup' | 'unreachable' | 'checking';

export interface ConnectionStatus {
  readonly surface: ConnectionSurface;
  readonly state: ConnectionState;
  /** One line stating what is actually true right now. Never a credential. */
  readonly detail: string;
  /** Concrete next steps. Empty only when the state is `ready`. */
  readonly nextActions: readonly string[];
}

/** Display label for a surface. */
export function connectionSurfaceLabel(surface: ConnectionSurface): string {
  return surface === 'mail' ? 'Mail' : 'Calendar';
}

/** The read verb each surface is probed with — the cheapest read it has. */
export const CONNECTION_PROBE_METHOD = {
  mail: 'email.inbox.list',
  calendar: 'calendar.events.list',
} as const;

/**
 * The setup steps each daemon failure code implies.
 *
 * The `surfaces.*` settings are daemon-owned by prefix (see the SDK's
 * `config-ownership`), so `/config set` on them lands in the daemon's own
 * store and keeps working with this client closed — which is the requirement.
 *
 * The PASSWORDS now have it too, and these steps changed the round the platform
 * gave it to them. A credential is filed in the daemon's tier only when a
 * daemon-owned config path declares it, and the two keys this product's daemon
 * reads — `surfaces.email.password` and `surfaces.calendar.caldavPassword` —
 * were declared in neither `CONFIG_SCHEMA` nor the platform's non-schema
 * daemon-owned path list. `isDaemonOwnedSecretKey()` answered false for both,
 * so a `/secrets set` filed them in THIS client's store where the daemon never
 * looks, and telling anyone to run it would have been handing them a step that
 * silently did nothing. The instruction was the daemon's own environment
 * instead, because that genuinely reached it.
 *
 * The platform release that began serving `email.*` and `calendar.*` declares
 * the whole mail and CalDAV connection as daemon-owned, so both keys answer
 * true now and a write carrying an explicit scope is RELOCATED to the daemon
 * tier rather than filed where it was asked for. `/secrets set` is therefore the
 * step that works, and it is the better one: it needs no restart and no shell
 * access to the machine the daemon runs on. The environment still resolves
 * first, so an operator who already set it there is not broken by this.
 */
const DAEMON_TIER_NOTE =
  'The password reaches the DAEMON: a daemon-owned credential is filed in its tier '
  + 'no matter which surface stores it, so this keeps working with this client closed.';

const SETUP_STEPS: Readonly<Record<string, readonly string[]>> = {
  EMAIL_NOT_CONFIGURED: [
    '/config set surfaces.email.host imap.example.com',
    '/config set surfaces.email.user you@example.com',
    `/secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD <password>. ${DAEMON_TIER_NOTE}`,
  ],
  EMAIL_CREDENTIALS_MISSING: [
    `/secrets set GOODVIBES_SURFACES_EMAIL_PASSWORD <password>. ${DAEMON_TIER_NOTE}`,
  ],
  CALENDAR_NOT_CONFIGURED: [
    '/config set surfaces.calendar.caldavUrl https://example.com/dav/',
    '/config set surfaces.calendar.caldavUser you@example.com',
    `/secrets set GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD <password>. ${DAEMON_TIER_NOTE}`,
  ],
};

/** Message text off an unknown thrown value, without assuming Error. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pull the daemon's machine code off a thrown handler error.
 *
 * In-process the throw is the daemon's own `HandlerError`, which carries
 * `code` directly. The structured wire body is also checked so the same
 * derivation keeps working if a surface ever reaches these verbs over HTTP.
 */
export function daemonErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const direct = (error as { readonly code?: unknown }).code;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const body = (error as { readonly body?: unknown }).body;
  if (typeof body === 'object' && body !== null) {
    const bodyCode = (body as { readonly code?: unknown }).code;
    if (typeof bodyCode === 'string' && bodyCode.length > 0) return bodyCode;
  }
  return null;
}

/**
 * Turn a probe outcome into a status. Pure — the caller does the I/O, so every
 * daemon answer is exercised in tests without a daemon.
 *
 * `error === null` means the read verb returned. That is the only evidence
 * that counts as ready: settings resolved, credential read, server reached.
 */
export function describeConnectionProbe(
  surface: ConnectionSurface,
  error: unknown,
): ConnectionStatus {
  const label = connectionSurfaceLabel(surface);

  if (error === null) {
    return {
      surface,
      state: 'ready',
      detail: `${label} is connected — the daemon reached the server and returned a result.`,
      nextActions: [],
    };
  }

  const code = daemonErrorCode(error);
  const steps = code === null ? undefined : SETUP_STEPS[code];
  if (steps !== undefined) {
    return {
      surface,
      state: 'needs-setup',
      detail: `${label} is not set up yet: ${errorText(error)}`,
      nextActions: steps,
    };
  }

  // A missing descriptor is a real answer and a different problem from "not
  // configured". Saying "not set up" here would send the owner off to set
  // config keys that would change nothing.
  if (code === 'METHOD_NOT_FOUND' || code === 'NOT_INVOKABLE') {
    return {
      surface,
      state: 'unreachable',
      detail: `This build does not serve ${CONNECTION_PROBE_METHOD[surface]} (${code}).`,
      nextActions: [`Update to a build whose daemon serves the ${surface} methods.`],
    };
  }

  return {
    surface,
    state: 'unreachable',
    detail: `${label} could not be checked: ${errorText(error)}`,
    nextActions: ['Check that the runtime composed its daemon handlers: /doctor'],
  };
}

/** The status for a surface when the gateway catalog is not wired at all. */
export function unwiredConnectionStatus(surface: ConnectionSurface): ConnectionStatus {
  return {
    surface,
    state: 'unreachable',
    detail: `${connectionSurfaceLabel(surface)} runs through the gateway method catalog, which is not wired into this session.`,
    nextActions: ['Start the full runtime (this surface is unavailable in a reduced harness).'],
  };
}

/** The invocation envelope every read on these surfaces uses. */
export const READ_INVOCATION_CONTEXT = { context: { clientKind: 'tui' as const } };

/**
 * The invocation envelope a confirmation-gated write needs.
 *
 * The daemon's register wrapper demands BOTH `body.confirm === true` and
 * `context.metadata.explicitUserRequest === true`. The second is set only on
 * paths where a person typed the command that performs the write, which is the
 * whole point of the flag — it is never set on a read or on a background
 * refresh.
 */
export const EXPLICIT_WRITE_INVOCATION_CONTEXT = {
  context: { clientKind: 'tui' as const, metadata: { explicitUserRequest: true } },
};

/**
 * Probe one surface against the in-process gateway catalog.
 *
 * Asks for a single item — enough to prove the whole path (settings →
 * credential → connector → server) without pulling a mailbox into memory.
 */
export async function probeConnection(
  gateway: GatewayMethodCatalog | undefined,
  surface: ConnectionSurface,
): Promise<ConnectionStatus> {
  if (!gateway) return unwiredConnectionStatus(surface);
  try {
    await gateway.invoke(CONNECTION_PROBE_METHOD[surface], {
      ...READ_INVOCATION_CONTEXT,
      body: { limit: 1 },
    });
    return describeConnectionProbe(surface, null);
  } catch (error) {
    return describeConnectionProbe(surface, error);
  }
}

/** Render one status as transcript lines. Used by `/mail` and `/calendar`. */
export function renderConnectionStatus(status: ConnectionStatus): string {
  const lines = [
    `${connectionSurfaceLabel(status.surface)}: ${status.state}`,
    `  ${status.detail}`,
  ];
  if (status.nextActions.length > 0) {
    lines.push('  Next:');
    for (const action of status.nextActions) lines.push(`    ${action}`);
  }
  return lines.join('\n');
}
