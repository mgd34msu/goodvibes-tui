/**
 * Keyboard actions that edit the prompt keep their edit.
 *
 * `feedInputTokens` snapshots the prompt into the shortcut route state BEFORE
 * dispatching a key, then restores from that snapshot afterwards. Paste, undo
 * and redo do not edit that route state — they call InputHandler methods that
 * edit the handler's own prompt and sync it into the live feed context. So the
 * restore has to be conditional, and it is: handler-feed.ts only writes the
 * snapshot back for a field the dispatched action left untouched (the
 * `promptBefore` guard).
 *
 * That guard is the only reason Ctrl+V, Ctrl+Z and Ctrl+Y do anything at all.
 * Remove it and every one of them inserts its edit and has it erased in the
 * same keystroke, so the composer looks completely dead while each individual
 * piece still passes its own unit test. The sibling agent product shipped
 * exactly that: same closures, same actions, no guard, and image paste was
 * dead on arrival. These tests pin the guard here so this product cannot
 * regress into it.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager, InfiniteBuffer } from '@pellux/goodvibes-terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

/** The bytes a terminal sends for these chords. */
const CTRL_V = '\x16';
const CTRL_Z = '\x1a';

const clipboardImage = { data: 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(400), mediaType: 'image/png' };
let imageOnClipboard: { data: string; mediaType: string } | null = clipboardImage;
let textOnClipboard = '';

function makeInput(): InputHandler {
  const ih = new InputHandler(
    () => {}, new SelectionManager(), () => 0, () => 20,
    () => new InfiniteBuffer(), () => {}, () => {}, createDefaultUiRuntimeServices(),
  );
  ih.setContentWidth(80);
  // Never reach for the machine's real clipboard in a test.
  ih.clipboardSource = {
    pasteImageFromClipboard: () => imageOnClipboard,
    pasteFromClipboard: () => textOnClipboard,
  };
  return ih;
}

describe('Ctrl+V keeps what it pasted', () => {
  beforeEach(() => {
    imageOnClipboard = clipboardImage;
    textOnClipboard = '';
  });

  test('an image marker survives the keystroke', () => {
    const input = makeInput();
    input.feed(CTRL_V);

    expect(input.prompt).toMatch(/^\[IMAGE: img\d+, clipboard, \d+KB\]$/);
    expect(input.cursorPos).toBe(input.prompt.length);
  });

  test('the pasted image is held as a real attachment', () => {
    const input = makeInput();
    input.feed(CTRL_V);

    const attachments = input.getImageAttachments();
    expect(attachments.size).toBe(1);
    expect([...attachments.values()][0]?.data).toBe(clipboardImage.data);
  });

  test('the attachment reaches the outgoing message as an image part', () => {
    const input = makeInput();
    input.feed(CTRL_V);
    input.feed('what is this?');

    const parts = input.expandPrompt(input.prompt) as { type: string; text?: string }[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.filter(p => p.type === 'image').length).toBe(1);
    expect(parts.filter(p => p.type === 'text').map(p => p.text).join('')).toContain('what is this?');
  });

  test('pasting mid-sentence keeps the surrounding text and the cursor', () => {
    const input = makeInput();
    input.feed('look: ');
    input.feed(CTRL_V);
    input.feed('!');

    expect(input.prompt.startsWith('look: [IMAGE:')).toBe(true);
    expect(input.prompt.endsWith(']!')).toBe(true);
  });

  test('text on the clipboard pastes when there is no image', () => {
    imageOnClipboard = null;
    textOnClipboard = 'pasted words';
    const input = makeInput();
    input.feed(CTRL_V);

    expect(input.prompt).toBe('pasted words');
  });

  test('an empty clipboard leaves what was already typed alone', () => {
    imageOnClipboard = null;
    const input = makeInput();
    input.feed('typed already');
    input.feed(CTRL_V);

    expect(input.prompt).toBe('typed already');
  });
});

describe('Ctrl+Z keeps what it undid', () => {
  beforeEach(() => {
    imageOnClipboard = null;
    textOnClipboard = '';
  });

  test('undo after a paste removes the pasted text', () => {
    textOnClipboard = 'some pasted text';
    const input = makeInput();
    input.feed('keep this ');
    input.feed(CTRL_V);
    expect(input.prompt).toBe('keep this some pasted text');

    input.feed(CTRL_Z);
    expect(input.prompt).toBe('keep this ');
  });

  test('undo after a typed edit restores the earlier prompt', () => {
    const input = makeInput();
    input.feed('hello');
    input.saveUndoState();
    input.feed(' world');
    expect(input.prompt).toBe('hello world');

    input.feed(CTRL_Z);
    expect(input.prompt).toBe('hello');
  });
});
