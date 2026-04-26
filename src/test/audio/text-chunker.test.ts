import { describe, expect, test } from 'bun:test';
import { TtsTextChunker } from '../../audio/text-chunker.ts';

describe('TtsTextChunker', () => {
  test('flushes complete sentences before retaining the next fragment', () => {
    const chunker = new TtsTextChunker({ minBoundaryChars: 8 });

    expect(chunker.push('Hello there. Keep going')).toEqual(['Hello there.']);
    expect(chunker.flushAll()).toEqual(['Keep going']);
  });

  test('flushes buffered speech after max latency even without punctuation', () => {
    let now = 1_000;
    const chunker = new TtsTextChunker({
      maxLatencyMs: 500,
      now: () => now,
    });

    expect(chunker.push('short phrase')).toEqual([]);
    now += 499;
    expect(chunker.flushDue()).toEqual([]);
    now += 1;
    expect(chunker.flushDue()).toEqual(['short phrase']);
  });

  test('splits long chunks at a word boundary', () => {
    const chunker = new TtsTextChunker({
      maxChunkChars: 18,
      minBoundaryChars: 200,
    });

    expect(chunker.push('alpha beta gamma delta')).toEqual(['alpha beta gamma']);
    expect(chunker.flushAll()).toEqual(['delta']);
  });
});
