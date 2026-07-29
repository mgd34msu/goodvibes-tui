/**
 * send-wire.test.ts — `goodvibes-daemon send` driven through the REAL
 * `ChannelDeliveryRouter` and the real per-surface strategies, with only the
 * network stubbed.
 *
 * The companion send-command.test.ts stubs the delivery call and asserts the
 * request the command builds. This file asserts one step further out: the bytes
 * the strategy would put on the wire. That is the only level at which two of
 * this command's claims are actually checkable —
 *
 *   1. that a Telegram message is sent in PLAIN-TEXT mode (no `parse_mode`),
 *      which is the entire reason inert-text.ts does not escape for Telegram;
 *   2. that the credential comes out of the DAEMON tier.
 *
 * Both would keep passing against a stub no matter how wrong they got.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { runSendCommand } from '../../daemon/send/command.ts';
import { createSendStack } from '../../daemon/send/composition.ts';

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

const roots: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** An isolated tree with `settings` in the daemon tier, and a stubbed transport. */
function arrange(settings: Record<string, unknown>, respond?: () => Response): {
  readonly stack: ReturnType<typeof createSendStack>;
  readonly captured: CapturedRequest[];
} {
  const root = makeProjectTempDir('gv-send-wire');
  roots.push(root);
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(join(root, 'work'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'settings.json'), JSON.stringify(settings), 'utf-8');

  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .forEach((value, key) => { headers[key.toLowerCase()] = value; });
    captured.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      headers,
    });
    return respond ? respond() : new Response(JSON.stringify({ ok: true, result: { message_id: 4242 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return {
    stack: createSendStack({
      workingDirectory: join(root, 'work'),
      homeDirectory: root,
      daemonHomeDirectory: join(root, '.goodvibes', 'daemon'),
    }),
    captured,
  };
}

describe('goodvibes-daemon send — the credential comes out of the daemon\'s own store', () => {
  /**
   * The case the whole command exists for, and the one a literal-token fixture
   * cannot exercise.
   *
   * On a real machine `surfaces.telegram.botToken` does not hold the token — it
   * holds `goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN`, a reference that
   * only resolves when the composition root supplies a SecretsManager pointed
   * at the DAEMON's store. Two shipped composition roots omitted exactly that
   * and reported `Missing Telegram bot token` on machines where the credential
   * was present and correct.
   *
   * With a literal token in config every one of these tests passes whether or
   * not `daemonHome` is threaded, which is precisely why this one is here.
   */
  test('a goodvibes://secrets/... reference resolves from the daemon store, not a client silo', async () => {
    const root = makeProjectTempDir('gv-send-secret');
    roots.push(root);
    const daemonHome = join(root, '.goodvibes', 'daemon');
    mkdirSync(daemonHome, { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(join(daemonHome, 'settings.json'), JSON.stringify({
      surfaces: {
        telegram: {
          enabled: true,
          botToken: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN',
          defaultChatId: '99001',
        },
      },
    }), 'utf-8');

    // Stored ONLY in the daemon-scoped store under <daemonHome>/secrets.enc.
    const config = new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' });
    const secrets = new SecretsManager({
      projectRoot: join(root, 'work'),
      globalHome: root,
      daemonHome,
      configManager: config,
    });
    await secrets.set('TELEGRAM_BOT_TOKEN', 'token-from-the-daemon-store', { scope: 'daemon' });

    const captured: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const stack = createSendStack({
      workingDirectory: join(root, 'work'),
      homeDirectory: root,
      daemonHomeDirectory: daemonHome,
    });
    const result = await runSendCommand(['--channel', 'telegram', 'the train is blocked'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    expect(result.exitCode).toBe(0);
    // The RESOLVED token, never the reference text.
    expect(captured[0]).toBe('https://api.telegram.org/bottoken-from-the-daemon-store/sendMessage');
    expect(captured[0]).not.toContain('goodvibes');
  });

  /**
   * The same resolution with the daemon home moved OFF its default location.
   *
   * The test above cannot detect a composition root that forgets to thread
   * `daemonHome`, because `SecretsManager` defaults it to
   * `<globalHome>/.goodvibes/daemon` — which is exactly where that fixture puts
   * it. The thread only changes an outcome when the daemon home is somewhere
   * else, which is the case `--daemon-home` / `GOODVIBES_DAEMON_HOME` exists
   * for and the case an isolated harness runs in. Without this test the
   * threading is unpinned and a future tidy-up removes it silently.
   */
  test('the credential is read from an overridden daemon home, not the default one', async () => {
    const root = makeProjectTempDir('gv-send-altdaemon');
    roots.push(root);
    const daemonHome = join(root, 'somewhere-else', 'daemon-state');
    mkdirSync(daemonHome, { recursive: true });
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    mkdirSync(join(root, 'work'), { recursive: true });

    // The config tier still lives at the default path — only the SECRET store
    // moves, which is the split that makes this seam observable.
    writeFileSync(join(root, '.goodvibes', 'daemon', 'settings.json'), JSON.stringify({
      surfaces: {
        telegram: {
          enabled: true,
          botToken: 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN',
          defaultChatId: '99001',
        },
      },
    }), 'utf-8');

    const config = new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' });
    await new SecretsManager({
      projectRoot: join(root, 'work'),
      globalHome: root,
      daemonHome,
      configManager: config,
    }).set('TELEGRAM_BOT_TOKEN', 'token-from-the-moved-store', { scope: 'daemon' });

    const captured: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      captured.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const stack = createSendStack({
      workingDirectory: join(root, 'work'),
      homeDirectory: root,
      daemonHomeDirectory: daemonHome,
    });
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    // A stack that defaulted the daemon home would look in
    // <root>/.goodvibes/daemon, find no secret, and send the unresolved
    // reference text as the token.
    expect(result.exitCode).toBe(0);
    expect(captured[0]).toBe('https://api.telegram.org/bottoken-from-the-moved-store/sendMessage');
  });
});

describe('goodvibes-daemon send — what actually goes on the wire', () => {
  test('a Telegram send reads the bot token from the daemon tier and calls sendMessage', async () => {
    const { stack, captured } = arrange({
      surfaces: { telegram: { enabled: true, botToken: 'daemon-tier-token', defaultChatId: '99001' } },
    });
    const result = await runSendCommand(['--channel', 'telegram', 'the train is blocked'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    expect(result.exitCode).toBe(0);
    expect(captured).toHaveLength(1);
    const request = captured[0]!;
    // The credential was written ONLY to <home>/.goodvibes/daemon/settings.json.
    // Reading a surface silo instead is what produced "Missing Telegram bot
    // token" on a machine whose token was present and correct.
    expect(request.url).toBe('https://api.telegram.org/botdaemon-tier-token/sendMessage');
    expect(request.method).toBe('POST');
    const payload = JSON.parse(request.body) as Record<string, unknown>;
    expect(payload.chat_id).toBe('99001');
    expect(payload.text).toBe('the train is blocked');
  });

  test('a Telegram send sets NO parse_mode, which is what makes the un-escaped body safe', async () => {
    const { stack, captured } = arrange({
      surfaces: { telegram: { enabled: true, botToken: 'tok', defaultChatId: '1' } },
    });
    const message = '[Approved](https://evil.example) *bold* _under_ `code` v1.25.0!';
    await runSendCommand(['--channel', 'telegram', message], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    const payload = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    // THE assertion this file exists for. inert-text.ts deliberately does not
    // escape Telegram, and that is correct only while the strategy stays in
    // plain-text mode. If a future change adds parse_mode here, this fails —
    // which is the signal to add the MarkdownV2 escaper at the same time,
    // rather than discovering it as a live link on the owner's phone.
    expect(payload).not.toHaveProperty('parse_mode');
    // The owner's text arrives exactly as typed: no escaping, and no markup
    // interpreted either.
    expect(payload.text).toBe(message);
  });

  test('a Discord send puts ESCAPED content on the wire, because Discord does render markup', async () => {
    const { stack, captured } = arrange({
      surfaces: { discord: { enabled: true, botToken: 'bot-tok', defaultChannelId: '123456789012345678' } },
    });
    const result = await runSendCommand(['--channel', 'discord', '[Approved](https://evil.example)'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    expect(result.exitCode).toBe(0);
    const request = captured.find((entry) => entry.url.includes('discord.com'));
    expect(request).toBeDefined();
    const payload = JSON.parse(request!.body) as Record<string, unknown>;
    expect(payload.content).toBe('\\[Approved\\]\\(https://evil.example\\)');
    // The live form must not survive anywhere in the request.
    expect(request!.body).not.toContain('[Approved](https://evil.example)');
  });

  test('a provider rejection exits non-zero and prints what the provider said', async () => {
    const { stack, captured } = arrange(
      { surfaces: { telegram: { enabled: true, botToken: 'bad-token', defaultChatId: '1' } } },
      () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    expect(captured).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    const output = result.lines.join('\n');
    expect(output).toContain('did NOT go out');
    // Telegram's own words, not a classification of them.
    expect(output).toContain('Unauthorized');
    expect(output).toContain('401');
  });

  test('a failure that echoes the request URL does not print the bot token', async () => {
    const { stack } = arrange(
      { surfaces: { telegram: { enabled: true, botToken: '7654321:AAHsupersecretvalue0123456789', defaultChatId: '1' } } },
      () => { throw new Error('fetch failed for https://api.telegram.org/bot7654321:AAHsupersecretvalue0123456789/sendMessage'); },
    );
    const result = await runSendCommand(['--channel', 'telegram', 'ping'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    expect(result.exitCode).toBe(1);
    const output = result.lines.join('\n');
    // Telegram carries the token in the URL PATH, so an error echoing the URL
    // would otherwise print the owner's credential to a terminal and into
    // whatever log that output lands in.
    expect(output).not.toContain('AAHsupersecretvalue0123456789');
    expect(output).toContain('[REDACTED_BOT_TOKEN]');
    // Everything that is not the credential is still there to debug with.
    expect(output).toContain('fetch failed');
    expect(output).toContain('api.telegram.org');
  });

  test('an ntfy send publishes to the configured topic, and --to redirects it', async () => {
    const { stack, captured } = arrange({
      surfaces: { ntfy: { enabled: true, baseUrl: 'https://ntfy.example', topic: 'gv-default' } },
    });
    const deps = {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    };
    await runSendCommand(['--channel', 'ntfy', 'first'], deps);
    await runSendCommand(['--channel', 'ntfy', '--to', 'gv-noisy', 'second'], deps);

    expect(captured[0]!.url).toBe('https://ntfy.example/gv-default');
    expect(captured[0]!.body).toBe('first');
    expect(captured[1]!.url).toBe('https://ntfy.example/gv-noisy');
    expect(captured[1]!.body).toBe('second');
  });

  test('a message with newlines cannot inject an ntfy header', async () => {
    const { stack, captured } = arrange({
      surfaces: { ntfy: { enabled: true, baseUrl: 'https://ntfy.example', topic: 'gv' } },
    });
    await runSendCommand(['--channel', 'ntfy', '--title', 'Release', 'line one\nPriority: 5\nline two'], {
      configManager: stack.configManager,
      deliver: stack.deliver,
      readStdin: async () => '',
      stdinIsTty: true,
    });

    const request = captured[0]!;
    // The body is the HTTP body, never a header, and the title is the caller's
    // --title rather than anything derived from the message.
    expect(request.body).toContain('line one');
    expect(request.headers.title).toBe('Release');
    expect(request.headers.priority).toBeUndefined();
  });
});
