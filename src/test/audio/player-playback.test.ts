import { describe, expect, test } from 'bun:test';
import type { VoiceAudioChunk } from '@pellux/goodvibes-sdk/platform/voice';
import { LocalStreamingAudioPlayer } from '../../audio/player.ts';
import type { LocalStreamingAudioPlayerOptions } from '../../audio/player.ts';

/**
 * Deterministic fake-sink coverage for the two TTS playback regressions:
 *  - HEAD CLIP: the player must not write the first audio byte until the sink
 *    has actually started, so a slow-to-ready sink still receives the complete
 *    head of the stream.
 *  - TRUNCATION: a natural end-of-speech must wait for the sink to confirm it
 *    drained every buffered sample before play() resolves; an intentional
 *    interrupt must cut immediately without waiting for that drain.
 */

type Listener = (arg?: unknown) => void;

class FakeStdin {
  readonly chunks: Buffer[] = [];
  writesBeforeReady = 0;
  ended = false;
  destroyed = false;
  private ready = false;

  markReady(): void {
    this.ready = true;
  }

  write(data: Uint8Array, cb?: (error?: Error | null) => void): boolean {
    if (this.destroyed) {
      cb?.(new Error('stdin destroyed'));
      return false;
    }
    if (!this.ready) this.writesBeforeReady++;
    this.chunks.push(Buffer.from(data));
    cb?.(null);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class FakeProcess {
  readonly stdin = new FakeStdin();
  killed = false;
  private readonly listeners = new Map<string, Listener[]>();

  once(event: string, listener: Listener): this {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emit(event: string, arg?: unknown): void {
    const arr = this.listeners.get(event) ?? [];
    this.listeners.set(event, []);
    for (const listener of arr) listener(arg);
  }

  /** Test control: the sink has started and its device is open. */
  emitSpawn(): void {
    this.stdin.markReady();
    this.emit('spawn');
  }

  /** Test control: the sink failed to start. */
  emitError(error: Error): void {
    this.emit('error', error);
  }

  /** Test control: the sink finished draining and exited. */
  emitClose(): void {
    this.emit('close');
  }
}

function makePlayer(proc: FakeProcess): LocalStreamingAudioPlayer {
  return new LocalStreamingAudioPlayer({
    // The fake stands in for a spawned mpv/ffplay; cast bridges the private
    // SpawnProcess shape without pulling node's full Writable surface in.
    spawnProcess: (() => proc) as unknown as LocalStreamingAudioPlayerOptions['spawnProcess'],
  });
}

async function* chunksOf(...datas: Uint8Array[]): AsyncIterable<VoiceAudioChunk> {
  let sequence = 0;
  for (const data of datas) {
    yield { data, sequence: ++sequence, format: 'mp3' };
  }
}

async function* pacedChunks(
  datas: Uint8Array[],
  gate: () => Promise<void>,
): AsyncIterable<VoiceAudioChunk> {
  let sequence = 0;
  for (const data of datas) {
    yield { data, sequence: ++sequence, format: 'mp3' };
    await gate();
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Let queued microtasks and 0ms timers settle. */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('LocalStreamingAudioPlayer playback', () => {
  test('a slow-to-ready sink still receives the complete head', async () => {
    const proc = new FakeProcess();
    const player = makePlayer(proc);
    const head = bytes('HEAD-of-the-response');

    const playing = player.play(chunksOf(head), { format: 'mp3' });

    // Sink has not started yet: nothing may be written into it.
    await flush();
    expect(proc.stdin.chunks.length).toBe(0);

    // Sink starts; the head is written only now.
    proc.emitSpawn();
    await flush();
    expect(proc.stdin.ended).toBe(true);
    proc.emitClose();
    await playing;

    expect(proc.stdin.writesBeforeReady).toBe(0);
    expect(proc.stdin.bytes.equals(Buffer.from(head))).toBe(true);
  });

  test('a natural end waits for the sink to drain the full tail before resolving', async () => {
    const proc = new FakeProcess();
    const player = makePlayer(proc);
    const tail = bytes('...and the final words of the tail.');

    const playing = player.play(chunksOf(tail), { format: 'mp3' });
    let resolved = false;
    void playing.then(() => { resolved = true; });

    proc.emitSpawn();
    await flush();

    // All bytes are in and stdin is closed, but the sink has not confirmed it
    // drained — play() must still be pending so the tail is not cut short.
    expect(proc.stdin.ended).toBe(true);
    expect(proc.stdin.bytes.equals(Buffer.from(tail))).toBe(true);
    expect(resolved).toBe(false);

    // Sink drains and exits: only now does playback complete.
    proc.emitClose();
    await playing;
    expect(resolved).toBe(true);
  });

  test('an intentional interrupt cuts immediately without waiting for a drain', async () => {
    const proc = new FakeProcess();
    const player = makePlayer(proc);
    const abort = new AbortController();
    let gateReleases = 0;

    const playing = player.play(
      pacedChunks([bytes('first'), bytes('second'), bytes('third')], () => {
        gateReleases++;
        return new Promise((resolve) => setTimeout(resolve, 5));
      }),
      { format: 'mp3', signal: abort.signal },
    );

    proc.emitSpawn();
    await flush(2);

    // Interrupt mid-stream. No emitClose() is issued — a graceful drain never
    // comes — yet play() must still settle promptly.
    abort.abort();
    await playing;

    expect(proc.stdin.destroyed).toBe(true);
    expect(proc.killed).toBe(true);
    // The interrupt path never issues a graceful stdin.end(); it tears down.
    expect(proc.stdin.ended).toBe(false);
  });

  test('a sink that fails to start surfaces the failure instead of swallowing it', async () => {
    const proc = new FakeProcess();
    const player = makePlayer(proc);

    const playing = player.play(chunksOf(bytes('never heard')), { format: 'mp3' });
    const settled = playing.then(() => 'ok').catch((error: unknown) => `err:${(error as Error).message}`);

    proc.emitError(new Error('device busy'));

    expect(await settled).toBe('err:device busy');
    // Nothing was written into a sink that never opened.
    expect(proc.stdin.chunks.length).toBe(0);
  });
});
