/**
 * send-command.test.ts — `goodvibes-daemon send`, driven through
 * `runSendCommand` with the delivery call stubbed.
 *
 * The stub is the point of these tests: it captures the exact
 * `ChannelDeliveryRequest` the command hands the router, so what is asserted is
 * the payload the real strategies would receive rather than a paraphrase of it.
 * The companion file send-wire.test.ts drives the REAL router and asserts the
 * bytes that would go on the wire.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ChannelDeliveryRequest } from '@pellux/goodvibes-sdk/platform/channels';
import { runSendCommand, type SendCommandDeps } from '../../daemon/send/command.ts';
import { SEND_CHANNELS, resolveDefaultChannel } from '../../daemon/send/channels.ts';
import { inertBodyFor } from '../../daemon/send/inert-text.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * A config rooted in a throwaway tree, with `settings` written into the DAEMON
 * tier — `<home>/.goodvibes/daemon/settings.json` — because that is where every
 * `surfaces.*` key actually lives. Writing them into the surface silo instead
 * would reproduce the state that made the agent report "Missing Telegram bot
 * token" while the token was present, so these tests would pass against a
 * command that could not read a real machine's credentials.
 */
function configWithDaemonTier(settings: Record<string, unknown>): ConfigManager {
  const root = makeProjectTempDir('gv-send');
  roots.push(root);
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'settings.json'), JSON.stringify(settings), 'utf-8');
  mkdirSync(join(root, 'work'), { recursive: true });
  return new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' });
}

/** One switched-on channel with a destination — the shape a default resolves in. */
function telegramOnly(): Record<string, unknown> {
  return { surfaces: { telegram: { enabled: true, botToken: 'test-token', defaultChatId: '99001' } } };
}

interface Harness {
  readonly deps: SendCommandDeps;
  readonly sent: ChannelDeliveryRequest[];
}

function harness(
  settings: Record<string, unknown>,
  options: {
    readonly deliver?: SendCommandDeps['deliver'];
    readonly stdin?: string;
    readonly stdinIsTty?: boolean;
  } = {},
): Harness {
  const sent: ChannelDeliveryRequest[] = [];
  const configManager = configWithDaemonTier(settings);
  return {
    sent,
    deps: {
      configManager,
      deliver: options.deliver ?? (async (request) => { sent.push(request); return 'stub-response-id'; }),
      readStdin: async () => options.stdin ?? '',
      stdinIsTty: options.stdinIsTty ?? true,
      newRunId: () => 'run-fixed',
    },
  };
}

describe('goodvibes-daemon send — reaching the delivery router', () => {
  test('a send to a named channel reaches the router with the right payload', async () => {
    const { deps, sent } = harness(telegramOnly());
    const result = await runSendCommand(['--channel', 'telegram', 'release', 'train', 'is', 'blocked'], deps);

    expect(result.exitCode).toBe(0);
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.target.kind).toBe('surface');
    expect(request.target.surfaceKind).toBe('telegram');
    expect(request.body).toBe('release train is blocked');
    expect(request.title).toBe('GoodVibes');
    // No session, no artifacts, nothing to link back to.
    expect(request.includeLinks).toBe(false);
    // No address given, so the strategy falls back to surfaces.telegram.defaultChatId.
    expect(request.target.address).toBeUndefined();
    expect(result.lines.join('\n')).toContain('Sent to Telegram');
  });

  test('--to overrides the destination and rides on the request as target.address', async () => {
    const { deps, sent } = harness(telegramOnly());
    const result = await runSendCommand(['--channel', 'telegram', '--to', '12345', 'hi'], deps);

    expect(result.exitCode).toBe(0);
    expect(sent[0]!.target.address).toBe('12345');
  });

  test('--title rides through to the request rather than being dropped', async () => {
    const { deps, sent } = harness(telegramOnly());
    await runSendCommand(['--channel', 'telegram', '--title', 'Release train', 'blocked'], deps);

    expect(sent[0]!.title).toBe('Release train');
    expect(sent[0]!.target.label).toBe('Release train');
  });

  test('the channel id may be spelled as the routable kind (google-chat) or the settings id (googleChat)', async () => {
    const settings = {
      surfaces: { googleChat: { enabled: true, webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages' } },
    };
    for (const spelling of ['googleChat', 'google-chat']) {
      const { deps, sent } = harness(settings);
      const result = await runSendCommand(['--channel', spelling, 'hello'], deps);
      expect(result.exitCode).toBe(0);
      expect(sent[0]!.target.surfaceKind).toBe('google-chat');
    }
  });

  test('the message may be read from stdin, so the command composes with other tooling', async () => {
    const { deps, sent } = harness(telegramOnly(), { stdin: 'piped from a script\n', stdinIsTty: false });
    const result = await runSendCommand(['--channel', 'telegram'], deps);

    expect(result.exitCode).toBe(0);
    // The trailing newline every `echo` adds is not part of the message.
    expect(sent[0]!.body).toBe('piped from a script');
  });

  test('a message beginning with a dash survives after --, rather than being read as a flag', async () => {
    const { deps, sent } = harness(telegramOnly());
    const result = await runSendCommand(['--channel', 'telegram', '--', '--port', 'is', 'wrong'], deps);

    expect(result.exitCode).toBe(0);
    expect(sent[0]!.body).toBe('--port is wrong');
  });

  test('an unknown option is refused rather than silently swallowed into the message', async () => {
    const { deps, sent } = harness(telegramOnly());
    const result = await runSendCommand(['--channel', 'telegram', '--parse-mode', 'MarkdownV2', 'hi'], deps);

    expect(result.exitCode).toBe(2);
    expect(sent).toHaveLength(0);
    expect(result.lines.join('\n')).toContain('Unknown option: --parse-mode');
  });
});

describe('goodvibes-daemon send — the default channel', () => {
  test('a send with no channel named uses the configured default and reports which it used', async () => {
    const { deps, sent } = harness(telegramOnly());
    const result = await runSendCommand(['the train is blocked'], deps);

    expect(result.exitCode).toBe(0);
    expect(sent[0]!.target.surfaceKind).toBe('telegram');
    const output = result.lines.join('\n');
    // Naming the channel is the requirement: a send that does not say where it
    // went is one the operator has to go and check.
    expect(output).toContain('using telegram');
    expect(output).toContain('the only channel that is switched on and has a destination configured');
  });

  test('with no channel configured at all, nothing is sent and the exit code says so', async () => {
    const { deps, sent } = harness({});
    const result = await runSendCommand(['anyone there'], deps);

    expect(result.exitCode).toBe(2);
    expect(sent).toHaveLength(0);
    expect(result.lines.join('\n')).toContain('nothing was sent');
  });

  test('with two channels qualifying the command refuses rather than guessing which one to message', async () => {
    const { deps, sent } = harness({
      surfaces: {
        telegram: { enabled: true, botToken: 't', defaultChatId: '1' },
        ntfy: { enabled: true, topic: 'gv' },
      },
    });
    const result = await runSendCommand(['ambiguous'], deps);

    expect(result.exitCode).toBe(2);
    expect(sent).toHaveLength(0);
    const output = result.lines.join('\n');
    expect(output).toContain('more than one qualifies');
    expect(output).toContain('telegram');
    expect(output).toContain('ntfy');
  });

  test('an enabled channel with no destination does not qualify as the default', async () => {
    const config = configWithDaemonTier({
      surfaces: {
        telegram: { enabled: true, botToken: 'present', defaultChatId: '' },
        ntfy: { enabled: true, topic: 'gv' },
      },
    });
    const resolution = resolveDefaultChannel(config);

    // Telegram is switched on but would throw "Missing Telegram chat id" at the
    // provider, so it is not a candidate and ntfy resolves unambiguously.
    expect(resolution.kind).toBe('resolved');
    expect(resolution.kind === 'resolved' && resolution.channel.id).toBe('ntfy');
  });

  test('--list shows every channel, its state, and which one is the default', async () => {
    const { deps } = harness(telegramOnly());
    const result = await runSendCommand(['--list'], deps);

    expect(result.exitCode).toBe(0);
    const output = result.lines.join('\n');
    for (const channel of SEND_CHANNELS) expect(output).toContain(channel.id);
    expect(output).toContain('99001');
    expect(output).toContain('Default with no --channel: telegram');
  });
});

describe('goodvibes-daemon send — a failed send is never reported as success', () => {
  test('a failed send exits non-zero and prints the provider\'s own error', async () => {
    const providerError = 'Telegram delivery failed: HTTP 401 {"ok":false,"description":"Unauthorized"}';
    const { deps } = harness(telegramOnly(), {
      deliver: async () => { throw new Error(providerError); },
    });
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], deps);

    expect(result.exitCode).toBe(1);
    const output = result.lines.join('\n');
    // The provider's words, verbatim: "Unauthorized" and "Missing chat id" have
    // different fixes and must not be flattened into "delivery failed".
    expect(output).toContain('Unauthorized');
    expect(output).toContain('401');
    expect(output).toContain('did NOT go out');
  });

  test('a rejected promise from the router cannot produce exit code 0', async () => {
    const { deps } = harness(telegramOnly(), {
      deliver: () => Promise.reject(new Error('connect ECONNREFUSED 149.154.167.220:443')),
    });
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], deps);

    expect(result.exitCode).not.toBe(0);
    expect(result.lines.join('\n')).toContain('ECONNREFUSED');
  });

  test('a channel that is switched off refuses, names the settings key, and sends nothing', async () => {
    const { deps, sent } = harness({ surfaces: { telegram: { enabled: false, botToken: 't', defaultChatId: '1' } } });
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], deps);

    expect(result.exitCode).toBe(1);
    expect(sent).toHaveLength(0);
    expect(result.lines.join('\n')).toContain('surfaces.telegram.enabled');
  });

  test('a capability the daemon\'s own delivery needs, switched off, refuses by name instead of going quiet', async () => {
    const { deps, sent } = harness({
      surfaces: { telegram: { enabled: true, botToken: 't', defaultChatId: '1' } },
      // The gate AutomationDeliveryManager answers with an empty array and no
      // reason. Here it produces a refusal that names the key to turn back on.
      integrations: { deliveryTracking: false },
    });
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], deps);

    expect(result.exitCode).toBe(1);
    expect(sent).toHaveLength(0);
    const output = result.lines.join('\n');
    expect(output).toContain('integrations.deliveryTracking');
    expect(output).toContain('nothing was sent');
  });

  test('an empty message sends nothing', async () => {
    const { deps, sent } = harness(telegramOnly(), { stdin: '   \n', stdinIsTty: false });
    const result = await runSendCommand(['--channel', 'telegram'], deps);

    expect(result.exitCode).toBe(2);
    expect(sent).toHaveLength(0);
  });
});

describe('goodvibes-daemon send — channel markup arrives inert', () => {
  test('a Discord masked link arrives as visible text, not as a clickable link', async () => {
    const { deps, sent } = harness({ surfaces: { discord: { enabled: true, botToken: 'b', defaultChannelId: '42' } } });
    const result = await runSendCommand(['--channel', 'discord', '[Approved](https://evil.example)'], deps);

    expect(result.exitCode).toBe(0);
    const body = sent[0]!.body;
    // Masked links DO render in bot and webhook messages, which is how this
    // product delivers to Discord, so every bracket and paren is escaped.
    expect(body).toBe('\\[Approved\\]\\(https://evil.example\\)');
    expect(body).not.toContain('[Approved](');
  });

  test('Discord bold, spoiler and quote markers arrive as characters', async () => {
    const { deps, sent } = harness({ surfaces: { discord: { enabled: true, botToken: 'b', defaultChannelId: '42' } } });
    await runSendCommand(['--channel', 'discord', '**bold** ||spoiler|| > quote `code`'], deps);

    const body = sent[0]!.body;
    expect(body).not.toContain('**bold**');
    expect(body).toContain('\\*\\*bold\\*\\*');
    expect(body).toContain('\\|\\|spoiler\\|\\|');
    expect(body).toContain('\\> quote');
  });

  test('an @everyone in the message does not become a Discord mention', async () => {
    const { deps, sent } = harness({ surfaces: { discord: { enabled: true, botToken: 'b', defaultChannelId: '42' } } });
    await runSendCommand(['--channel', 'discord', 'ping @everyone now'], deps);

    // Backslash-escaping the @ does not defeat this in every client, so the
    // token is broken with a zero-width space instead.
    expect(sent[0]!.body).not.toContain('@everyone');
    expect(sent[0]!.body).toContain('@​everyone');
  });

  test('Slack link and mention syntax is entity-escaped, so neither renders', async () => {
    const { deps, sent } = harness({ surfaces: { slack: { enabled: true, botToken: 'x', defaultChannel: 'C1' } } });
    await runSendCommand(['--channel', 'slack', '<https://evil.example|Approved> <!channel>'], deps);

    const body = sent[0]!.body;
    expect(body).not.toContain('<https://evil.example|');
    expect(body).not.toContain('<!channel>');
    expect(body).toContain('&lt;https://evil.example|Approved&gt;');
    expect(body).toContain('&lt;!channel&gt;');
  });

  test('Google Chat link syntax is entity-escaped too', async () => {
    const { deps, sent } = harness({
      surfaces: { googleChat: { enabled: true, webhookUrl: 'https://chat.googleapis.com/v1/spaces/AAA/messages' } },
    });
    await runSendCommand(['--channel', 'google-chat', '<https://evil.example|Approved>'], deps);

    expect(sent[0]!.body).toContain('&lt;https://evil.example|Approved&gt;');
  });

  test('Telegram text is NOT escaped, because the strategy sends it in plain-text mode', async () => {
    const { deps, sent } = harness(telegramOnly());
    const message = 'build 1.25.0 failed — see step 3 (retry now!) [not a link](x)';
    await runSendCommand(['--channel', 'telegram', message], deps);

    // Running a MarkdownV2 escaper here would not protect anything the
    // strategy's plain-text send is not already protecting; it would put a
    // visible backslash in front of every . - ! ( ) in the owner's message.
    expect(sent[0]!.body).toBe(message);
    expect(sent[0]!.body).not.toContain('\\');
  });

  test('every channel the command offers has a verified inert transform', () => {
    // A surface reaching the send path with no transform would be a body handed
    // to a renderer nobody checked. inertBodyFor throws rather than pass it
    // through, and channels.ts filters on the same predicate; this pins that
    // the two agree for every channel actually on offer.
    for (const channel of SEND_CHANNELS) {
      expect(() => inertBodyFor(channel.surfaceKind, 'probe')).not.toThrow();
    }
    expect(SEND_CHANNELS.length).toBeGreaterThan(0);
  });

  test('a surface with no verified transform throws instead of sending an untransformed body', () => {
    // Both have a delivery strategy but are deliberately not offered as send
    // channels — telephony would place a carrier call, and web needs a live
    // gateway in-process. Neither may acquire a body by default.
    for (const surface of ['telephony', 'web'] as const) {
      expect(() => inertBodyFor(surface, 'probe')).toThrow(/No verified inert-text transform/);
      expect(SEND_CHANNELS.some((channel) => channel.surfaceKind === surface)).toBe(false);
    }
  });

  test('a Mattermost masked link is escaped, because Mattermost renders markdown links too', async () => {
    const { deps, sent } = harness({
      surfaces: { mattermost: { enabled: true, baseUrl: 'https://mm.example', botToken: 'b', defaultChannelId: 'c1' } },
    });
    const result = await runSendCommand(['--channel', 'mattermost', '[Approved](https://evil.example)'], deps);

    expect(result.exitCode).toBe(0);
    expect(sent[0]!.body).toBe('\\[Approved\\]\\(https://evil.example\\)');
  });

  test('WhatsApp formatting delimiters are broken, and its text is not bracket-escaped', async () => {
    const { deps, sent } = harness({
      surfaces: { whatsapp: { enabled: true, accessToken: 'a', phoneNumberId: '1', defaultRecipient: '+15550100' } },
    });
    await runSendCommand(['--channel', 'whatsapp', '*bold* and [not a link](x)'], deps);

    const body = sent[0]!.body;
    expect(body).not.toContain('*bold*');
    // WhatsApp has no masked-link syntax, so brackets stay readable rather than
    // being escaped into noise the reader has to look past.
    expect(body).toContain('[not a link](x)');
  });

  test('Matrix and Signal bodies pass through, because their strategies send plain text', async () => {
    const message = 'step 3 failed (retry now!) *not bold*';
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['matrix', { matrix: { enabled: true, homeserverUrl: 'https://m.example', accessToken: 'a', userId: '@x:m', defaultRoomId: '!r:m' } }],
      ['signal', { signal: { enabled: true, bridgeUrl: 'https://s.example', account: '+15550000', defaultRecipient: '+15550111' } }],
    ];
    for (const [channelId, surfaces] of cases) {
      const { deps, sent } = harness({ surfaces });
      const result = await runSendCommand(['--channel', channelId, message], deps);
      expect(result.exitCode).toBe(0);
      expect(sent[0]!.body).toBe(message);
    }
  });
});

describe('goodvibes-daemon send — targeting a channel explicitly', () => {
  test('naming a switched-off channel refuses it AND names what is configured, never falling back', async () => {
    // The owner's concern: a caller that would flood ntfy must be routable
    // somewhere else, and a caller that named a channel must never be silently
    // redirected to the busy default.
    const { deps, sent } = harness({
      surfaces: {
        ntfy: { enabled: true, topic: 'gv-busy-topic' },
        telegram: { enabled: false, botToken: 't', defaultChatId: '1' },
      },
    });
    const result = await runSendCommand(['--channel', 'telegram', 'important'], deps);

    expect(result.exitCode).toBe(1);
    expect(sent).toHaveLength(0);
    const output = result.lines.join('\n');
    expect(output).toContain('Configured and ready: ntfy');
    // The refusal must not have quietly become an ntfy send.
    expect(output).not.toContain('Sent to');
  });

  test('an unknown channel names what is configured rather than only what is spelled wrong', async () => {
    const { deps } = harness(telegramOnly());
    const result = await runSendCommand(['--channel', 'telgram', 'typo'], deps);

    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('Configured and ready: telegram');
  });

  test('--to targets one ntfy topic without changing the configured default', async () => {
    const { deps, sent } = harness({ surfaces: { ntfy: { enabled: true, topic: 'gv-default' } } });
    const result = await runSendCommand(['--channel', 'ntfy', '--to', 'gv-noisy-automation', 'tick'], deps);

    expect(result.exitCode).toBe(0);
    // address wins at the strategy; the configured topic is untouched.
    expect(sent[0]!.target.address).toBe('gv-noisy-automation');
    expect(deps.configManager.get('surfaces.ntfy.topic')).toBe('gv-default');
  });

  test('--list names each channel\'s addressing vocabulary, so a script author need not read settings.json', async () => {
    const { deps } = harness({
      surfaces: {
        ntfy: { enabled: true, topic: 'gv-default' },
        matrix: { enabled: true, homeserverUrl: 'https://m.example', accessToken: 'a', userId: '@x:m', defaultRoomId: '!room:m' },
      },
    });
    const result = await runSendCommand(['--list'], deps);
    const output = result.lines.join('\n');

    expect(output).toContain('topic: gv-default');
    expect(output).toContain('room id: !room:m');
    expect(output).toContain('chat id');
    expect(output).toContain('--to <address>');
  });
});
