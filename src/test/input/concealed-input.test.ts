import { describe, expect, test } from 'bun:test';
import {
  maskConcealedText,
  beginConcealedInputFor,
  submitConcealedInputFor,
  cancelConcealedInputFor,
  type ConcealedInputHost,
  type ConcealedInputRequest,
} from '../../input/concealed-input.ts';

function makeHost(): ConcealedInputHost & { renders: number } {
  return {
    prompt: '',
    cursorPos: 0,
    concealedInput: null,
    renders: 0,
    requestRender() { this.renders++; },
  };
}

describe('concealed-input', () => {
  test('mask preserves length and newlines, replaces every other unit with a bullet', () => {
    expect(maskConcealedText('hunter2')).toBe('•••••••');
    expect(maskConcealedText('a\nbc')).toBe('•\n••');
    // Length in UTF-16 units is preserved so cursor/wrap math stays correct.
    const secret = 's3cr3t pass';
    expect(maskConcealedText(secret).length).toBe(secret.length);
    expect(maskConcealedText('')).toBe('');
  });

  test('begin clears the buffer, arms concealed mode, and re-renders', () => {
    const host = makeHost();
    host.prompt = 'leftover';
    host.cursorPos = 8;
    const req: ConcealedInputRequest = { onSubmit: () => {} };
    beginConcealedInputFor(host, req);
    expect(host.concealedInput).toBe(req);
    expect(host.prompt).toBe('');
    expect(host.cursorPos).toBe(0);
    expect(host.renders).toBe(1);
  });

  test('a second begin cancels the first request so nothing is left dangling', () => {
    const host = makeHost();
    let firstCancelled = false;
    beginConcealedInputFor(host, { onSubmit: () => {}, onCancel: () => { firstCancelled = true; } });
    beginConcealedInputFor(host, { onSubmit: () => {} });
    expect(firstCancelled).toBe(true);
  });

  test('submit delivers plaintext once, clears concealed state before onSubmit runs', () => {
    const host = makeHost();
    let delivered: string | null = null;
    let stateWhenDelivered: unknown = 'unset';
    beginConcealedInputFor(host, {
      onSubmit: (v) => { delivered = v; stateWhenDelivered = host.concealedInput; },
    });
    const consumed = submitConcealedInputFor(host, 'my-secret');
    expect(consumed).toBe(true);
    expect(delivered).toBe('my-secret');
    // Cleared BEFORE the callback ran, so the secret does not linger.
    expect(stateWhenDelivered).toBeNull();
    expect(host.prompt).toBe('');
  });

  test('submit is a no-op returning false when not concealed', () => {
    const host = makeHost();
    expect(submitConcealedInputFor(host, 'x')).toBe(false);
  });

  test('cancel fires onCancel, clears state, re-renders, and returns true only when active', () => {
    const host = makeHost();
    expect(cancelConcealedInputFor(host)).toBe(false);
    let cancelled = false;
    beginConcealedInputFor(host, { onSubmit: () => {}, onCancel: () => { cancelled = true; } });
    const before = host.renders;
    expect(cancelConcealedInputFor(host)).toBe(true);
    expect(cancelled).toBe(true);
    expect(host.concealedInput).toBeNull();
    expect(host.renders).toBe(before + 1);
  });
});
