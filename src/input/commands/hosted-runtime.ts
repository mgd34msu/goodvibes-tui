/**
 * hosted-runtime.ts — `/hosted`, the front door to a conversation the DAEMON
 * runs.
 *
 * Local sessions are unchanged and remain the default experience: a turn typed
 * into the composer runs in this process, exactly as it always has. `/hosted`
 * is the opt-in — it asks the daemon to compose the same loop on its side, so
 * the conversation does not depend on this window staying open.
 *
 * ── The subcommands, and why they are these ───────────────────────────────
 *
 *   /hosted                    what this terminal is attached to, and what
 *                              leaving would do
 *   /hosted new [prompt…]      create one here and attach; `--survive` /
 *                              `--kill` set this session's own detach override
 *   /hosted list [--all]       every hosted session the daemon has
 *   /hosted attach <id|n>      join one and backfill its transcript
 *   /hosted say <text…>        steer the attached session (ordinary verb)
 *   /hosted later <text…>      queue a follow-up (ordinary verb)
 *   /hosted cancel [callId]    cancel one in-flight tool call (ordinary verb)
 *   /hosted detach             leave — the policy the record names then applies
 *   /hosted kill [id]          end it regardless of policy
 *
 * There is no `/hosted steer` beside `say` and no hosted-only cancel: those
 * operations are `sessions.steer`, `sessions.followUp` and
 * `sessions.toolCalls.cancel`, which resolve a hosted id daemon-side. This
 * command spells each one once.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError } from './operator-rpc.ts';
import { requireShellPaths } from './runtime-services.ts';
import {
  createDaemonVerbCaller,
  resolveControlPlaneBaseUrl,
  resolveDaemonStateDirectory,
} from '../../runtime/client/operator-endpoint.ts';
import {
  createHostedSessionsClient,
  describeDetachEffect,
  hostedSessionLabel,
  type HostedDetachPolicy,
  type HostedSessionRecord,
  type HostedSessionsClient,
} from '../../runtime/client/hosted-sessions.ts';
import { watchHostedSession, type HostedSessionSubscription } from '../../runtime/client/hosted-session-stream.ts';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';
import { getSharedHostedSessionFeed, type HostedSessionFeed } from '../../panels/hosted-session-feed.ts';
import { getSharedHostedSessionRoster } from '../../runtime/client/hosted-roster.ts';

/** The last list this terminal printed, so `attach 2` means what the user just read. */
let lastListedIds: readonly string[] = [];

/** One row of `/hosted list`, in the record's own words. */
export function renderHostedRecordLine(record: HostedSessionRecord, index: number): string {
  const attached = record.attachedClients.length > 0 ? record.attachedClients.join(', ') : 'nobody';
  const ended = record.status === 'terminated'
    ? ` — ended: ${record.terminatedReason ?? 'no reason recorded'}`
    : '';
  return [
    `  ${index + 1}. ${hostedSessionLabel(record)} [${record.status}]${ended}`,
    `     id ${record.id}`,
    `     ${describeDetachEffect(record)}`,
    `     ${record.turnCount} turn(s), ${record.messageCount} message(s); attached: ${attached}`,
  ].join('\n');
}

/** The status block `/hosted` with no arguments prints. */
export function renderHostedStatus(feed: HostedSessionFeed): string {
  const state = feed.getState();
  if (!state.record) {
    return [
      'No hosted session is attached in this terminal.',
      '  A hosted session runs inside the daemon, so it can outlive this window.',
      '  /hosted new [prompt]   start one and attach',
      '  /hosted list           see what already exists',
    ].join('\n');
  }
  const record = state.record;
  return [
    `Attached to ${hostedSessionLabel(record)} [${record.status}]`,
    `  id ${record.id}`,
    `  workspace ${record.workspaceRoot}`,
    `  ${describeDetachEffect(record)}`,
    `  ${record.turnCount} turn(s), ${record.messageCount} message(s)`,
    state.streaming
      ? '  live event stream open'
      : `  no live stream — ${state.streamNote ?? 'not subscribed'}`,
    state.runningToolCalls.length > 0
      ? `  running: ${state.runningToolCalls.map((call) => `${call.tool} (${call.callId})`).join(', ')}`
      : '  no tool call is running',
  ].join('\n');
}

/**
 * Read `--survive` / `--kill` out of the arguments.
 *
 * Absent means "follow the `hostedSessions.detachPolicy` setting", which is a
 * different thing from either value and is what most sessions want: the record
 * then reports the setting's current answer rather than a snapshot of it.
 */
export function readDetachOverride(args: readonly string[]): {
  readonly policy: HostedDetachPolicy | undefined;
  readonly rest: string[];
} {
  const rest: string[] = [];
  let policy: HostedDetachPolicy | undefined;
  for (const arg of args) {
    if (arg === '--survive') { policy = 'survive'; continue; }
    if (arg === '--kill') { policy = 'kill'; continue; }
    rest.push(arg);
  }
  return { policy, rest };
}

interface HostedCommandSeams {
  readonly client: HostedSessionsClient;
  readonly baseUrl: string | null;
  readonly authToken: string | null;
}

/**
 * Resolve everything a `/hosted` subcommand needs, or refuse honestly.
 *
 * The verbs go through `createDaemonVerbCaller` because every
 * `sessions.hosted.*` verb is ws-declared with no REST path; the stream needs
 * the base URL and bearer directly, which is the same resolution the verb
 * caller performs internally.
 */
function resolveSeams(context: CommandContext): HostedCommandSeams | null {
  const configManager = context.platform.configManager;
  const homeDirectory = (): string => requireShellPaths(context).homeDirectory;
  const client = createHostedSessionsClient(createDaemonVerbCaller({ configManager, homeDirectory }));
  const baseUrl = resolveControlPlaneBaseUrl(configManager);
  if (!baseUrl) return { client, baseUrl: null, authToken: null };
  let authToken: string | null = null;
  try {
    authToken = getOrCreateCompanionToken('tui', {
      daemonHomeDir: resolveDaemonStateDirectory(homeDirectory()),
    }).token;
  } catch {
    // A token this terminal cannot mint is a stream it cannot open; the verbs
    // resolve their own and still work, so this is not a refusal of the command.
    authToken = null;
  }
  return { client, baseUrl, authToken };
}

/** Open the live stream for the attached session, and say so in the feed either way. */
async function openStream(
  seams: HostedCommandSeams,
  sessionId: string,
  feed: HostedSessionFeed,
): Promise<void> {
  // The feed owns the subscription handle: the exit path has to be able to
  // close it too, and it has no way to reach a variable in this module.
  feed.closeStream();
  if (!seams.baseUrl) {
    feed.setStreaming(false, 'no control-plane base URL is configured, so nothing can be watched live');
    return;
  }
  if (!seams.authToken) {
    feed.setStreaming(false, 'no bearer token could be read for the event stream');
    return;
  }
  const token = seams.authToken;
  const subscription: HostedSessionSubscription | null = await watchHostedSession({
    baseUrl: seams.baseUrl,
    sessionId,
    getAuthToken: () => token,
    onEvent: (event) => feed.apply(event),
    onLifecycle: (update) => feed.applyLifecycle(update),
    onTerminate: (error) => {
      feed.setStreaming(false, `the event stream ended: ${describeOperatorRpcError(error)}`);
    },
  });
  feed.bindStream(subscription ? () => subscription.close() : null);
  feed.setStreaming(
    subscription !== null,
    subscription === null ? 'the daemon would not open an event stream' : null,
  );
}

/** Attach to a session by id, backfill it, and start watching it. */
async function attachSession(
  seams: HostedCommandSeams,
  sessionId: string,
  feed: HostedSessionFeed,
  context: CommandContext,
): Promise<void> {
  const attachment = await seams.client.attach(sessionId);
  feed.attach(attachment.session, attachment.history);
  await openStream(seams, attachment.session.id, feed);
  context.print([
    `[hosted] attached to ${hostedSessionLabel(attachment.session)} (${attachment.history.length} message(s) backfilled)`,
    `  ${describeDetachEffect(attachment.session)}`,
  ].join('\n'));
  context.showPanel?.('hosted');
}

/** Turn `attach 2` into the id the user just read off `/hosted list`. */
function resolveIdArgument(argument: string): string {
  const index = Number.parseInt(argument, 10);
  if (Number.isInteger(index) && index >= 1 && index <= lastListedIds.length) {
    return lastListedIds[index - 1] as string;
  }
  return argument;
}

export function registerHostedRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'hosted',
    description: 'Daemon-hosted sessions: start, join, steer and leave a conversation whose loop runs in the daemon',
    usage: '[new|list|attach|say|later|cancel|detach|kill] [args]',
    argsHint: '[new|list|attach|say|later|cancel|detach|kill]',
    async handler(args, ctx) {
      const feed = getSharedHostedSessionFeed();
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === '' || sub === 'status') {
        ctx.print(renderHostedStatus(feed));
        return;
      }

      const seams = resolveSeams(ctx);
      if (!seams) return;
      const attachedId = feed.getState().record?.id ?? null;

      try {
        switch (sub) {
          case 'new': {
            const { policy, rest } = readDetachOverride(args.slice(1));
            const workspaceRoot = requireShellPaths(ctx).workingDirectory;
            const prompt = rest.join(' ').trim();
            const record = await seams.client.create({
              workspaceRoot,
              ...(prompt ? { initialPrompt: prompt } : {}),
              ...(policy ? { detachPolicy: policy } : {}),
            });
            ctx.print([
              `[hosted] created ${hostedSessionLabel(record)} in ${record.workspaceRoot}`,
              `  ${describeDetachEffect(record)}`,
            ].join('\n'));
            await attachSession(seams, record.id, feed, ctx);
            return;
          }
          case 'list': {
            const includeTerminated = args.includes('--all');
            const records = await seams.client.list({ includeTerminated });
            lastListedIds = records.map((record) => record.id);
            // The session picker reads the same roster, so a list typed here is
            // the list it shows — one answer, not two that drift.
            if (!includeTerminated) getSharedHostedSessionRoster().accept(records);
            if (records.length === 0) {
              ctx.print(includeTerminated
                ? '[hosted] the daemon is hosting no sessions, and has no retained terminated ones.'
                : '[hosted] the daemon is hosting no sessions. Add --all to include ones that have ended.');
              return;
            }
            ctx.print([
              `Hosted sessions (${records.length}${includeTerminated ? ', including ended' : ''}):`,
              ...records.map(renderHostedRecordLine),
              '',
              '  /hosted attach <id or number>',
            ].join('\n'));
            return;
          }
          case 'attach': {
            const target = args[1];
            if (!target) { ctx.print('Usage: /hosted attach <id or list number>'); return; }
            await attachSession(seams, resolveIdArgument(target), feed, ctx);
            return;
          }
          case 'say':
          case 'later': {
            if (!attachedId) { ctx.print('[hosted] no hosted session is attached — /hosted attach <id> first.'); return; }
            const body = args.slice(1).join(' ').trim();
            if (!body) { ctx.print(`Usage: /hosted ${sub} <text>`); return; }
            if (sub === 'say') await seams.client.steer(attachedId, body);
            else await seams.client.followUp(attachedId, body);
            ctx.print(sub === 'say'
              ? '[hosted] sent — its output arrives on the Hosted Session panel.'
              : '[hosted] queued — it runs after the current turn.');
            return;
          }
          case 'cancel': {
            if (!attachedId) { ctx.print('[hosted] no hosted session is attached.'); return; }
            const running = feed.getState().runningToolCalls;
            const callId = args[1] ?? running[0]?.callId;
            if (!callId) { ctx.print('[hosted] no tool call is running in this session. Pass a callId to cancel a specific one.'); return; }
            const cancelled = await seams.client.cancelToolCall(attachedId, callId);
            ctx.print(cancelled
              ? `[hosted] cancelled tool call ${callId}.`
              : `[hosted] the daemon did not cancel ${callId} — it may have already settled.`);
            return;
          }
          case 'detach': {
            if (!attachedId) { ctx.print('[hosted] no hosted session is attached.'); return; }
            const record = await seams.client.detach(attachedId);
            feed.clear();
            ctx.print(record.status === 'terminated'
              ? `[hosted] detached — the session ended (${record.terminatedReason ?? 'no reason recorded'}), which is what its detach policy said would happen.`
              : '[hosted] detached — the session is still running in the daemon and can be reattached.');
            return;
          }
          case 'kill': {
            const target = args[1] ? resolveIdArgument(args[1]) : attachedId;
            if (!target) { ctx.print('Usage: /hosted kill <id> (or attach one first)'); return; }
            const record = await seams.client.kill(target);
            if (target === attachedId) feed.clear();
            ctx.print(`[hosted] ended ${hostedSessionLabel(record)} — ${record.terminatedReason ?? 'no reason recorded'}.`);
            return;
          }
          default:
            ctx.print('Usage: /hosted [status|new|list|attach|say|later|cancel|detach|kill]');
            return;
        }
      } catch (error) {
        ctx.print(`[hosted] ${describeOperatorRpcError(error)}`);
      }
    },
  });
}

/**
 * Tests drive the module-level list memory (`/hosted attach 2`); this resets it
 * between them. The live stream is the feed's, and is reset with the feed.
 */
export function resetHostedCommandState(): void {
  lastListedIds = [];
}
