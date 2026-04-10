import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../../artifacts/index.ts';
import { ChannelDeliveryRouter } from '../../channels/index.ts';
import { ConfigManager } from '../../config/manager.ts';
import { ControlPlaneGateway } from '../../control-plane/index.ts';
import type { ChannelDeliveryRequest } from '../../channels/index.ts';

function serviceRequest(): ChannelDeliveryRequest {
  return {
    target: { kind: 'surface', surfaceKind: 'service', address: 'svc-1' },
    body: 'hello from automation',
    title: 'Automation delivery',
    jobId: 'job-1',
    runId: 'run-1',
    includeLinks: false,
  };
}

describe('ChannelDeliveryRouter', () => {
  test('registers default concrete channel delivery strategies', () => {
    const router = new ChannelDeliveryRouter();

    expect(router.listStrategies().map((strategy) => strategy.id)).toEqual([
      'channel-delivery:webhook',
      'channel-delivery:slack',
      'channel-delivery:discord',
      'channel-delivery:ntfy',
      'channel-delivery:web-control-plane',
      'channel-delivery:telegram',
      'channel-delivery:google-chat',
      'channel-delivery:signal',
      'channel-delivery:whatsapp',
      'channel-delivery:imessage',
    ]);
  });

  test('supports custom delivery strategies without automation owning egress behavior', async () => {
    const router = new ChannelDeliveryRouter({ strategies: [] });
    const delivered: ChannelDeliveryRequest[] = [];

    expect(router.listStrategies()).toHaveLength(0);
    await expect(router.deliver(serviceRequest())).rejects.toThrow('Unsupported channel delivery target: surface:service');

    router.registerStrategy({
      id: 'channel-delivery:test-service',
      canHandle(request) {
        return request.target.surfaceKind === 'service';
      },
      async deliver(request) {
        delivered.push(request);
        return { responseId: `service:${request.target.address}` };
      },
    });

    expect(await router.deliver(serviceRequest())).toBe('service:svc-1');
    expect(delivered[0]?.jobId).toBe('job-1');
    expect(delivered[0]?.runId).toBe('run-1');
  });

  test('guards strategy id collisions unless replacement is explicit', () => {
    const router = new ChannelDeliveryRouter({ strategies: [] });
    const strategy = {
      id: 'channel-delivery:test',
      canHandle: () => false,
      async deliver() {
        return {};
      },
    };

    router.registerStrategy(strategy);

    expect(() => router.registerStrategy(strategy)).toThrow('Channel delivery strategy already registered');
    expect(() => router.registerStrategy({ ...strategy, canHandle: () => true }, { replace: true })).not.toThrow();
    expect(router.listStrategies()).toHaveLength(1);
  });

  test('rejects unsafe webhook delivery targets before dispatch', async () => {
    const router = new ChannelDeliveryRouter();

    await expect(router.deliver({
      target: { kind: 'webhook', address: 'https://127.0.0.1/callback' },
      body: 'do not deliver to local network',
      title: 'Unsafe delivery',
      jobId: 'job-unsafe',
      runId: 'run-unsafe',
      includeLinks: false,
    })).rejects.toThrow('Webhook URL host is not allowed');
  });

  test('publishes attachments to web control-plane deliveries as structured attachments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-delivery-artifacts-'));
    const config = new ConfigManager({ configDir: root });
    const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const artifact = await artifactStore.create({
      filename: 'summary.md',
      text: '# summary\n',
    });
    new ControlPlaneGateway();
    const router = new ChannelDeliveryRouter({ configManager: config, artifactStore });

    try {
      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'web', address: 'web-client' },
        body: 'Automation complete',
        title: 'Delivery with attachment',
        jobId: 'job-web',
        runId: 'run-web',
        includeLinks: false,
        attachments: [{ artifactId: artifact.id, label: 'summary' }],
      });

      const messages = ControlPlaneGateway.getActive()!.listSurfaceMessages();
      expect(messages[0]?.attachments).toHaveLength(1);
      expect(messages[0]?.attachments?.[0]?.artifactId).toBe(artifact.id);
      expect(messages[0]?.attachments?.[0]?.contentPath).toBe(`/api/artifacts/${encodeURIComponent(artifact.id)}/content`);
    } finally {
      ArtifactStore.resetActiveForTesting();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('delivers Telegram and Google Chat payloads through their native HTTP shapes', async () => {
    const originalFetch = globalThis.fetch;
    const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 123 }, name: 'spaces/AAA/messages/BBB' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const router = new ChannelDeliveryRouter();

      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'telegram', address: '-100777' },
        body: 'hello telegram',
        title: 'Telegram delivery',
        jobId: 'job-telegram',
        runId: 'run-telegram',
        includeLinks: false,
      });

      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'google-chat', address: 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=key&token=token' },
        body: 'hello chat',
        title: 'Google Chat delivery',
        jobId: 'job-chat',
        runId: 'run-chat',
        includeLinks: false,
        binding: {
          id: 'route-chat',
          surfaceKind: 'google-chat',
          surfaceId: 'space',
          externalId: 'spaces/AAA',
          threadId: 'thread-key-1',
          metadata: {},
        },
      });

      expect(calls[0]?.url).toBe('https://api.telegram.org/bottelegram-token/sendMessage');
      const telegramBody = JSON.parse(String(calls[0]?.init?.body));
      expect(telegramBody.chat_id).toBe('-100777');
      expect(telegramBody.text).toContain('hello telegram');

      expect(calls[1]?.url).toContain('https://chat.googleapis.com/v1/spaces/AAA/messages');
      const googleChatBody = JSON.parse(String(calls[1]?.init?.body));
      expect(googleChatBody.text).toContain('hello chat');
      expect(googleChatBody.thread).toEqual({ threadKey: 'thread-key-1' });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
    }
  });

  test('delivers Signal, WhatsApp, and iMessage payloads through bridge and provider adapters', async () => {
    const originalFetch = globalThis.fetch;
    const originalWhatsAppToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const root = mkdtempSync(join(tmpdir(), 'gv-delivery-config-'));
    const config = new ConfigManager({ configDir: root });
    process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'msg-1', messages: [{ id: 'wamid-123' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      config.set('surfaces.signal.bridgeUrl', 'http://127.0.0.1:4101/signal');
      config.set('surfaces.signal.account', '+15550001111');
      config.set('surfaces.imessage.bridgeUrl', 'http://127.0.0.1:4101/imessage');
      config.set('surfaces.imessage.account', 'me@icloud.test');
      config.set('surfaces.whatsapp.phoneNumberId', '106540352242922');

      const router = new ChannelDeliveryRouter({ configManager: config });

      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'signal', address: '+15551212' },
        body: 'signal hello',
        title: 'Signal delivery',
        jobId: 'job-signal',
        runId: 'run-signal',
        includeLinks: false,
      });
      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'whatsapp', address: '+15552323' },
        body: 'whatsapp hello',
        title: 'WhatsApp delivery',
        jobId: 'job-whatsapp',
        runId: 'run-whatsapp',
        includeLinks: false,
      });
      await router.deliver({
        target: { kind: 'surface', surfaceKind: 'imessage', address: 'chat-123' },
        body: 'imessage hello',
        title: 'iMessage delivery',
        jobId: 'job-imessage',
        runId: 'run-imessage',
        includeLinks: false,
      });

      expect(calls[0]?.url).toBe('http://127.0.0.1:4101/signal');
      const signalBody = JSON.parse(String(calls[0]?.init?.body));
      expect(signalBody.surface).toBe('signal');
      expect(signalBody.recipient).toBe('+15551212');

      expect(calls[1]?.url).toBe('https://graph.facebook.com/v17.0/106540352242922/messages');
      const whatsappBody = JSON.parse(String(calls[1]?.init?.body));
      expect(whatsappBody.messaging_product).toBe('whatsapp');
      expect(whatsappBody.to).toBe('+15552323');

      expect(calls[2]?.url).toBe('http://127.0.0.1:4101/imessage');
      const imessageBody = JSON.parse(String(calls[2]?.init?.body));
      expect(imessageBody.surface).toBe('imessage');
      expect(imessageBody.chatId).toBe('chat-123');
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWhatsAppToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
      else process.env.WHATSAPP_ACCESS_TOKEN = originalWhatsAppToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
