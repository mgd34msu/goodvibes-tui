import { describe, expect, test } from 'bun:test';
import { applyComposerCapture } from '@/input/composer-capture.ts';

function harness() {
  const added: string[] = [];
  const messages: string[] = [];
  const deps = {
    sessionMemoryStore: { add: (t: string) => { added.push(t); return `mem_${added.length}`; } },
    notify: (m: string) => { messages.push(m); },
  };
  return { deps, added, messages };
}

describe('applyComposerCapture', () => {
  test('plain text is passed through untouched', () => {
    const h = harness();
    const r = applyComposerCapture('hello world', h.deps);
    expect(r).toEqual({ text: 'hello world', captured: false });
    expect(h.added).toEqual([]);
  });

  test('#note saves to session memory and does NOT send', () => {
    const h = harness();
    const r = applyComposerCapture('# remember the API key rotates monthly', h.deps);
    expect(r.captured).toBe(true);
    expect(r.text).toBe('');
    expect(h.added).toEqual(['remember the API key rotates monthly']);
    expect(h.messages[0]).toContain('session memory');
    expect(h.messages[0]).toContain('remember the API key');
  });

  test('#note without leading space still captures', () => {
    const h = harness();
    const r = applyComposerCapture('#quick note', h.deps);
    expect(r.captured).toBe(true);
    expect(h.added).toEqual(['quick note']);
  });

  test('## markdown heading is left alone (sent as prompt)', () => {
    const h = harness();
    const r = applyComposerCapture('## Heading in a prompt', h.deps);
    expect(r).toEqual({ text: '## Heading in a prompt', captured: false });
    expect(h.added).toEqual([]);
  });

  test('empty # shows usage and does not save', () => {
    const h = harness();
    const r = applyComposerCapture('#   ', h.deps);
    expect(r).toEqual({ text: '', captured: true });
    expect(h.added).toEqual([]);
    expect(h.messages[0]).toContain('Usage');
  });

  test('!# pins to session memory AND continues to send', () => {
    const h = harness();
    const r = applyComposerCapture('!# pin this fact', h.deps);
    expect(r.captured).toBe(true);
    expect(r.text).toBe('pin this fact');
    expect(h.added).toEqual(['pin this fact']);
    expect(h.messages[0]).toContain('Pinned');
  });

  test('empty !# shows usage and does not send', () => {
    const h = harness();
    const r = applyComposerCapture('!#', h.deps);
    expect(r).toEqual({ text: '', captured: true });
    expect(h.added).toEqual([]);
  });

  test('confirmation truncates long notes', () => {
    const h = harness();
    const long = 'x'.repeat(200);
    applyComposerCapture(`# ${long}`, h.deps);
    expect(h.messages[0].length).toBeLessThan(120);
    expect(h.messages[0]).toContain('...');
  });
});
