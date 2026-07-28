/**
 * command.ts — `goodvibes-daemon send`, the shell's way to put a message on one
 * of the owner's channels.
 *
 * ## Why this exists
 *
 * Nothing on this machine could send the owner a message from a script. The
 * three binaries exposed no send verb, the daemon's HTTP API answers
 * `401 AUTH_REQUIRED` to the operator token as stored, and driving the agent to
 * do it failed with `Missing Telegram bot token` — because the credential lives
 * in the DAEMON tier (`~/.goodvibes/daemon/settings.json`) and the agent was
 * reading its own surface silo. So the one process that could always send was
 * the daemon, and only while it was running.
 *
 * ## Three properties this command is built around
 *
 * 1. **It uses the delivery path, it is not a second sender.** Everything below
 *    ends in `ChannelDeliveryRouter.deliver()` — the same call
 *    `AutomationDeliveryManager.sendTarget` makes, reaching the same
 *    per-surface strategies in `strategies-core.ts`. Nothing here talks to a
 *    provider API directly.
 *
 * 2. **It never exits 0 on a send that did not happen.** The router throws with
 *    the provider's own error text and that error is printed and exits non-zero.
 *    `AutomationDeliveryManager.deliverText` was the alternative entry point and
 *    was NOT used, deliberately: it returns an empty array when a feature gate
 *    is off and returns failed attempts rather than throwing, so a caller that
 *    did not inspect its result would report success for a message that never
 *    left the machine — the exact false-green this command exists to avoid. The
 *    gate check it would have done is done here instead, explicitly, and a gate
 *    that is off produces a refusal naming the settings key rather than silence.
 *
 * 3. **Every message it sends arrives as literal text.** The body is passed
 *    through `inertBodyFor` for the target surface before it reaches the router,
 *    and there is no flag, env var or code path that skips that. The message
 *    normally comes from the operator's own shell, but the command must not
 *    become the way something else's text — a log line, a captured error, a
 *    remote agent's output piped in — arrives on the owner's phone rendered as
 *    live markup with a clickable link in it. See inert-text.ts.
 */

import type { ConfigManager } from '../../config/index.ts';
import type { ChannelDeliveryRequest } from '@pellux/goodvibes-sdk/platform/channels';
import { getMissingSurfaceFeatureFlags, surfaceFeatureGateSettingsKeys } from '../../runtime/surface-feature-flags.ts';
import { findSendChannel, readChannelReadiness, resolveDefaultChannel, SEND_CHANNELS, type SendChannel } from './channels.ts';
import { describeSendFailure } from './failure-text.ts';
import { inertBodyFor } from './inert-text.ts';

/** What the router needs to actually send; injected so tests never reach the network. */
export type SendDeliver = (request: ChannelDeliveryRequest) => Promise<string | undefined>;

export interface SendCommandDeps {
  /** Built with a `homeDir` so the daemon tier overlays — see channels.ts. */
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly deliver: SendDeliver;
  /** Reads the whole of stdin; only called when no message argument was given. */
  readonly readStdin: () => Promise<string>;
  /** Whether stdin is a terminal. A TTY means there is no piped message to wait for. */
  readonly stdinIsTty: boolean;
  /** Injected so the run id in the delivery request is deterministic under test. */
  readonly newRunId?: (() => string) | undefined;
}

export interface SendCommandResult {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

interface ParsedSendArgs {
  readonly channel: string | null;
  readonly to: string | null;
  readonly title: string | null;
  readonly list: boolean;
  readonly help: boolean;
  readonly words: readonly string[];
  readonly errors: readonly string[];
}

const USAGE = [
  'Usage: goodvibes-daemon send [OPTIONS] [MESSAGE...]',
  '',
  'Send a message to one of your configured channels. With no MESSAGE, the',
  'message is read from stdin, so this composes with other tooling.',
  '',
  'Options:',
  '      --channel <id>   Channel to send to. With none named, your configured',
  '                       channel is used and the output says which one.',
  '      --to <address>   Where within that channel: an ntfy topic, a Telegram chat',
  '                       id, a Slack or Mattermost channel id, a Matrix room id.',
  '                       Without it the channel\'s configured destination is used.',
  '      --title <text>   Title for channels that show one (ntfy).',
  '      --list           Show every channel, whether it is on, and where it sends.',
  '  -h, --help           Print this help',
  '',
  'A channel that is switched off is refused by name and NOTHING is sent — the',
  'command never quietly falls back to the default, so a message meant for a',
  'quiet channel cannot end up on a noisy one.',
  '',
  'The message is always delivered as literal text: markup a channel would',
  'otherwise render — a Discord masked link, a Slack mention — arrives inert.',
].join('\n');

function parseSendArgs(argv: readonly string[]): ParsedSendArgs {
  let channel: string | null = null;
  let to: string | null = null;
  let title: string | null = null;
  let list = false;
  let help = false;
  const words: string[] = [];
  const errors: string[] = [];
  let optionsEnded = false;

  const takeValue = (flag: string, value: string | undefined): string | null => {
    if (value === undefined || value.length === 0) {
      errors.push(`${flag} needs a value.`);
      return null;
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (optionsEnded) { words.push(arg); continue; }
    // Everything after `--` is message text, so a message that starts with a
    // dash is still sendable.
    if (arg === '--') { optionsEnded = true; continue; }
    if (arg === '-h' || arg === '--help') { help = true; continue; }
    if (arg === '--list') { list = true; continue; }
    if (arg === '--channel' || arg === '-c') { channel = takeValue(arg, argv[++index]); continue; }
    if (arg.startsWith('--channel=')) { channel = takeValue('--channel', arg.slice('--channel='.length)); continue; }
    if (arg === '--to') { to = takeValue(arg, argv[++index]); continue; }
    if (arg.startsWith('--to=')) { to = takeValue('--to', arg.slice('--to='.length)); continue; }
    if (arg === '--title') { title = takeValue(arg, argv[++index]); continue; }
    if (arg.startsWith('--title=')) { title = takeValue('--title', arg.slice('--title='.length)); continue; }
    if (arg.startsWith('-') && arg.length > 1) {
      errors.push(`Unknown option: ${arg}`);
      continue;
    }
    words.push(arg);
  }
  return { channel, to, title, list, help, words, errors };
}

/**
 * The channels that are actually usable right now, named. Every refusal ends
 * with this: telling someone their channel is not configured without telling
 * them which ones are just moves the guessing to them.
 */
function describeConfiguredChannels(config: Pick<ConfigManager, 'get'>): string {
  const usable = readChannelReadiness(config)
    .filter((entry) => entry.enabled && entry.destination !== null)
    .map((entry) => entry.channel.id);
  return usable.length > 0
    ? `Configured and ready: ${usable.join(', ')}.`
    : 'No channel is currently both switched on and given a destination — run: goodvibes-daemon send --list';
}

function renderChannelList(config: Pick<ConfigManager, 'get'>): string[] {
  const readiness = readChannelReadiness(config);
  const idWidth = Math.max(...SEND_CHANNELS.map((channel) => channel.id.length), 7);
  const lines = ['Channels goodvibes-daemon send can reach:', ''];
  for (const entry of readiness) {
    const state = entry.enabled ? 'on ' : 'off';
    const destination = entry.destination ?? `not set (${entry.channel.destinationKey})`;
    lines.push(`  ${entry.channel.id.padEnd(idWidth)}  ${state}  ${entry.channel.addressLabel}: ${destination}`);
  }
  lines.push('');
  lines.push('Override any channel\'s destination for one message with --to <address>.');
  lines.push('');
  const resolution = resolveDefaultChannel(config);
  if (resolution.kind === 'resolved') {
    lines.push(`Default with no --channel: ${resolution.channel.id} (${resolution.reason}).`);
  } else if (resolution.kind === 'none') {
    lines.push('There is no default: no channel is both switched on and given a destination.');
  } else {
    const names = resolution.candidates.map((entry) => entry.channel.id).join(', ');
    lines.push(`There is no default: ${names} all qualify, so --channel is required.`);
  }
  return lines;
}

/** Refusals that must happen before anything is sent, in the order they matter. */
function checkChannelUsable(
  config: Pick<ConfigManager, 'get'>,
  channel: SendChannel,
): readonly string[] {
  if (config.get(channel.enabledKey) !== true) {
    // No fallback to the default channel, deliberately. Falling back is how a
    // message meant for a quiet channel lands on a noisy one, and how a caller
    // that named a channel because it mattered never finds out it was ignored.
    return [
      `${channel.label} is switched off, so nothing was sent.`,
      `Switch it on with: goodvibes surfaces enable ${channel.id}   (settings key ${channel.enabledKey})`,
      describeConfiguredChannels(config),
    ];
  }
  // The same capability gates the daemon's own delivery honours. Checked here
  // rather than left to AutomationDeliveryManager, which answers a disabled
  // gate with an empty result and no reason.
  const missing = getMissingSurfaceFeatureFlags(config, channel.id);
  if (missing.length > 0) {
    return [
      `${channel.label} is switched on but the capabilities delivery needs are off, so nothing was sent.`,
      `Turn these settings on: ${surfaceFeatureGateSettingsKeys(missing).join(', ')}`,
      describeConfiguredChannels(config),
    ];
  }
  return [];
}

export async function runSendCommand(
  argv: readonly string[],
  deps: SendCommandDeps,
): Promise<SendCommandResult> {
  const parsed = parseSendArgs(argv);
  if (parsed.errors.length > 0) {
    return { lines: [...parsed.errors, '', USAGE], exitCode: 2 };
  }
  if (parsed.help) return { lines: [USAGE], exitCode: 0 };
  if (parsed.list) return { lines: renderChannelList(deps.configManager), exitCode: 0 };

  // --- which channel -------------------------------------------------------
  let channel: SendChannel;
  let usedDefault = false;
  let defaultReason = '';
  if (parsed.channel !== null) {
    const named = findSendChannel(parsed.channel);
    if (!named) {
      return {
        lines: [
          `Unknown channel: ${parsed.channel}`,
          `Known channels: ${SEND_CHANNELS.map((entry) => entry.id).join(', ')}`,
          describeConfiguredChannels(deps.configManager),
        ],
        exitCode: 2,
      };
    }
    channel = named;
  } else {
    const resolution = resolveDefaultChannel(deps.configManager);
    if (resolution.kind === 'none') {
      return {
        lines: [
          'No channel was named and none is configured to be the default, so nothing was sent.',
          'A channel qualifies when it is switched on AND has a destination set.',
          '',
          ...renderChannelList(deps.configManager),
        ],
        exitCode: 2,
      };
    }
    if (resolution.kind === 'ambiguous') {
      return {
        lines: [
          `No channel was named and more than one qualifies (${resolution.candidates.map((entry) => entry.channel.id).join(', ')}), so nothing was sent.`,
          'Name one with --channel <id> rather than have this command guess which of your channels to message.',
        ],
        exitCode: 2,
      };
    }
    channel = resolution.channel;
    usedDefault = true;
    defaultReason = resolution.reason;
  }

  // --- what to send --------------------------------------------------------
  let message = parsed.words.join(' ');
  if (message.trim().length === 0) {
    if (deps.stdinIsTty) {
      return {
        lines: ['No message given. Pass it as an argument or pipe it on stdin.', '', USAGE],
        exitCode: 2,
      };
    }
    message = (await deps.readStdin()).replace(/\n+$/, '');
  }
  if (message.trim().length === 0) {
    return { lines: ['The message was empty, so nothing was sent.'], exitCode: 2 };
  }

  const refusal = checkChannelUsable(deps.configManager, channel);
  if (refusal.length > 0) return { lines: refusal, exitCode: 1 };

  // --- send ----------------------------------------------------------------
  const runId = deps.newRunId?.() ?? `cli-send-${Date.now().toString(36)}`;
  const title = parsed.title ?? 'GoodVibes';
  const body = inertBodyFor(channel.surfaceKind, message);
  const request: ChannelDeliveryRequest = {
    target: {
      kind: 'surface',
      surfaceKind: channel.surfaceKind,
      ...(parsed.to === null ? {} : { address: parsed.to }),
      label: title,
    },
    body,
    title,
    jobId: 'goodvibes-daemon-send',
    runId,
    // A message typed at a shell has no artifacts and no control-plane session
    // to link back to; a link appended here would point at a page the reader
    // did not ask for.
    includeLinks: false,
  };

  const preamble = usedDefault
    ? [`No channel named — using ${channel.id}: ${defaultReason}.`]
    : [];
  try {
    const responseId = await deps.deliver(request);
    return {
      lines: [
        ...preamble,
        `Sent to ${channel.label}${responseId ? ` (${responseId})` : ''}.`,
      ],
      exitCode: 0,
    };
  } catch (error) {
    // The provider's own words, not a paraphrase: "Missing Telegram chat id"
    // and "HTTP 401: Unauthorized" are different problems with different fixes,
    // and flattening them into "delivery failed" is what makes a failed send
    // take an hour to diagnose. See failure-text.ts for what is stripped
    // (credentials) and what is deliberately kept (everything else).
    return {
      lines: [
        ...preamble,
        `Sending to ${channel.label} failed, so the message did NOT go out.`,
        describeSendFailure(error),
      ],
      exitCode: 1,
    };
  }
}
