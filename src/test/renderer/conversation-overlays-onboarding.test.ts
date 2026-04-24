import { describe, expect, test } from 'bun:test';
import type { ConversationManager } from '../../core/conversation';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '../../input/selection.ts';
import { applyConversationOverlays } from '../../renderer/conversation-overlays.ts';
import { createEmptyLine } from '../../types/grid.ts';
import { InfiniteBuffer } from '../../core/history.ts';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { linesToText } from '../setup.ts';

function makeInput(): InputHandler {
  const history = new InfiniteBuffer();
  const input = new InputHandler(
    () => {},
    new SelectionManager(),
    () => 0,
    () => 20,
    () => history,
    () => {},
    () => {},
    createDefaultUiRuntimeServices(),
  );
  input.setContentWidth(100);
  return input;
}

const pickerModel = {
  id: 'gpt-4o',
  provider: 'openai',
  displayName: 'GPT-4o',
  registryKey: 'openai:gpt-4o',
};

function wireModelPicker(input: InputHandler): unknown[] {
  const commits: unknown[] = [];
  input.setCommandRegistry(new CommandRegistry(), {
    session: {
      runtime: {
        reasoningEffort: 'medium',
      },
    },
    openModelPicker: () => {
      input.modalOpened('modelPicker');
      input.modelPicker.openAllModels([pickerModel] as never, pickerModel.id);
    },
    completeModelSelection: (selection: unknown) => {
      commits.push(selection);
    },
  } as unknown as CommandContext);
  return commits;
}

describe('applyConversationOverlays onboarding shell', () => {
  test('keeps the onboarding shell viewport-owning while allowing the model picker above it', () => {
    const width = 100;
    const height = 20;
    const viewport = Array.from({ length: height }, () => createEmptyLine(width));
    const input = makeInput();
    input.openOnboardingWizard();
    input.modelPicker.openProviders(['openai', 'anthropic'], 'openai');

    const lines = applyConversationOverlays(viewport, {
      input,
      conversation: {} as ConversationManager,
      commandRegistry: { getAll: () => [] } as never,
      keybindingsManager: createDefaultUiRuntimeServices().shell.keybindingsManager,
      conversationWidth: width,
      viewportHeight: height,
    });

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(height);
    const text = linesToText(lines).join('\n');
    expect(text).toContain('Onboarding Wizard');
    expect(text).toContain('Select Provider');
  });

  test('guards duplicate onboarding modal pushes in the shared stack', () => {
    const input = makeInput();
    input.onboardingWizard.open('new');
    input.modalOpened('onboarding');
    input.modelPicker.openProviders(['openai'], 'openai');
    input.modalOpened('modelPicker');

    input.modalOpened('onboarding');

    expect(input.modalStack).toEqual(['onboarding', 'modelPicker']);
  });

  test('preserves modalReturnFocus while escape unwinds nested onboarding modals', () => {
    const input = makeInput();
    input.panelFocused = true;
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.panelFocused = false;
    input.modelPicker.openProviders(['openai'], 'openai');
    input.modalOpened('modelPicker');

    input.feed('\x1b');

    expect(input.modelPicker.active).toBe(false);
    expect(input.onboardingWizard.active).toBe(true);
    expect(input.modalStack).toEqual(['onboarding']);
    expect(input.modalReturnFocus).toBe('panel');
    expect(input.panelFocused).toBe(false);

    input.feed('\x1b');

    expect(input.onboardingWizard.active).toBe(false);
    expect(input.modalStack).toEqual([]);
    expect(input.modalReturnFocus).toBe('prompt');
    expect(input.panelFocused).toBe(true);
  });

  test('restores onboarding snapshot when a nested model picker is cancelled', () => {
    const input = makeInput();
    wireModelPicker(input);
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.setStep(3);

    const primaryField = input.onboardingWizard.currentStep.fields[0]!;
    expect(primaryField.kind).toBe('modelPicker');
    const originalLabel = input.onboardingWizard.getFieldValueLabel(primaryField);

    input.feed('\r');
    input.onboardingWizard.applyModelSelection('main', {
      providerId: 'transient',
      modelId: 'discard-me',
      enabled: true,
    });
    expect(input.onboardingWizard.getFieldValueLabel(primaryField)).toBe('transient/discard-me');

    input.feed('\x1b');

    expect(input.modelPicker.active).toBe(false);
    expect(input.onboardingWizard.active).toBe(true);
    expect(input.modalStack).toEqual(['onboarding']);
    expect(input.onboardingWizard.getFieldValueLabel(primaryField)).toBe(originalLabel);
  });

  test('keeps committed nested model picker selection and clears the cancel snapshot', () => {
    const input = makeInput();
    const commits = wireModelPicker(input);
    input.openOnboardingWizard({ mode: 'edit', preload: () => {} });
    input.onboardingWizard.setStep(3);

    const primaryField = input.onboardingWizard.currentStep.fields[0]!;
    expect(primaryField.kind).toBe('modelPicker');

    input.feed('\r');
    input.feed('\r');

    expect(commits).toHaveLength(0);
    expect(input.modelPicker.active).toBe(false);
    expect(input.onboardingWizard.active).toBe(true);
    expect(input.modalStack).toEqual(['onboarding']);
    expect(input.onboardingWizard.getFieldValue(primaryField)).toEqual({
      providerId: 'openai',
      modelId: 'openai:gpt-4o',
      enabled: true,
    });
  });
});
