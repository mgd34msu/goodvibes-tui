import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway } from '@pellux/goodvibes-sdk/platform/control-plane';
import { RuntimeEventBus } from '@/runtime/index.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function decodeChunk(chunk: Uint8Array | undefined): string {
  return chunk ? new TextDecoder().decode(chunk) : '';
}

async function readStreamText(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  stopWhen: (text: string) => boolean,
): Promise<string> {
  if (!reader) return '';
  let text = '';
  for (let index = 0; index < 6; index += 1) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decodeChunk(value);
    if (stopWhen(text)) break;
  }
  return text;
}

describe('ControlPlaneGateway event streams', () => {
  test('replays recent events with ids and resumes after Last-Event-ID', async () => {
    // OBS-14: bus.emit now async; give stream subscriptions and replay buffer time to settle.
    await flushMicrotasks();
    const gateway = new ControlPlaneGateway({
      runtimeBus: new RuntimeEventBus(),
    });

    gateway.publishEvent('agents', { type: 'AGENT_STARTED', payload: { id: 'a1' } });
    gateway.publishEvent('agents', { type: 'AGENT_COMPLETED', payload: { id: 'a1' } });

    await flushMicrotasks();
    const firstAbort = new AbortController();
    const firstResponse = gateway.createEventStream(
      new Request('http://127.0.0.1/api/control-plane/events?domains=agents', {
        signal: firstAbort.signal,
      }),
      { domains: ['agents'] },
    );
    const firstReader = firstResponse.body?.getReader();
    await flushMicrotasks();
    const firstChunk = await readStreamText(firstReader, (text) => (text.match(/^id:\s+/gm)?.length ?? 0) >= 2);
    firstAbort.abort();

    const replayIds = [...firstChunk.matchAll(/^id:\s+([^\n]+)$/gm)].map((match) => match[1]);
    expect(replayIds.length).toBeGreaterThanOrEqual(2);
    expect(firstChunk).toContain('event: agents');

    const secondAbort = new AbortController();
    const secondResponse = gateway.createEventStream(
      new Request('http://127.0.0.1/api/control-plane/events?domains=agents', {
        signal: secondAbort.signal,
        headers: {
          'Last-Event-ID': replayIds[0]!,
        },
      }),
      { domains: ['agents'] },
    );
    const secondReader = secondResponse.body?.getReader();
    await flushMicrotasks();
    const secondChunk = await readStreamText(secondReader, (text) => text.includes(`id: ${replayIds[1]}`));
    secondAbort.abort();

    expect(secondChunk).not.toContain(`id: ${replayIds[0]}`);
    expect(secondChunk).toContain(`id: ${replayIds[1]}`);
  }, 15_000);
});
