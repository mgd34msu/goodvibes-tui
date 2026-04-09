import { describe, expect, test } from 'bun:test';
import { extractOpenAIStreamTextDelta } from '../../providers/openai-stream-delta.ts';

describe('extractOpenAIStreamTextDelta', () => {
  test('extracts plain string content deltas', () => {
    expect(extractOpenAIStreamTextDelta({
      choices: [{ delta: { content: 'hello' } }],
    })).toEqual({ content: ['hello'], reasoning: [] });
  });

  test('extracts reasoning deltas from reasoning_content strings', () => {
    expect(extractOpenAIStreamTextDelta({
      choices: [{ delta: { reasoning_content: 'thinking...' } }],
    })).toEqual({ content: [], reasoning: ['thinking...'] });
  });

  test('extracts reasoning and content fragments from typed content arrays', () => {
    expect(extractOpenAIStreamTextDelta({
      choices: [{
        delta: {
          content: [
            { type: 'reasoning', text: 'plan first' },
            { type: 'text', text: 'answer now' },
          ],
        },
      }],
    })).toEqual({ content: ['answer now'], reasoning: ['plan first'] });
  });

  test('extracts reasoning_summary as reasoning text', () => {
    expect(extractOpenAIStreamTextDelta({
      choices: [{ delta: {} }],
      reasoning_summary: 'summary text',
    })).toEqual({ content: [], reasoning: ['summary text'] });
  });
});
