import { describe, expect, mock, test } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { InfiniteBuffer } from '@pellux/goodvibes-sdk/platform/core/history';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

type InputHandlerTestAccess = {
  commandContext?: {
    cancelGeneration?: () => void;
  };
};

function makeInput() {
  const selection = new SelectionManager();
  const history = new InfiniteBuffer();
  const renders: string[] = [];
  const input = new InputHandler(
    () => {
      renders.push(input.prompt);
    },
    selection,
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    createDefaultUiRuntimeServices(),
  );
  input.setContentWidth(80);
  return { input, renders };
}

describe('Ctrl+C behavior', () => {
  test('clears prompt content even when panel workspace has focus', () => {
    const { input, renders } = makeInput();
    input.prompt = 'pending text';
    input.cursorPos = input.prompt.length;
    input.panelFocused = true;

    input.feed('\x03');

    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(renders.at(-1)).toBe('');
  });

  test('clears prompt content even while a modal is active', () => {
    const { input, renders } = makeInput();
    input.prompt = 'clear me';
    input.cursorPos = input.prompt.length;
    input.helpOverlayActive = true;
    input.modalStack.push('help');

    input.feed('\x03');

    expect(input.prompt).toBe('');
    expect(input.cursorPos).toBe(0);
    expect(input.helpOverlayActive).toBe(true);
    expect(renders.at(-1)).toBe('');
  });

  test('cancels generation globally when prompt is empty', () => {
    const { input } = makeInput();
    const cancelGeneration = mock(() => {});
    (input as unknown as InputHandlerTestAccess).commandContext = { cancelGeneration };
    input.panelFocused = true;

    input.feed('\x03');

    expect(cancelGeneration).toHaveBeenCalled();
  });
});
