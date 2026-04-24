import type { InputToken } from '@pellux/goodvibes-sdk/platform/core/tokenizer';
import {
  getOnboardingWizardVisibleFieldCount,
  type OnboardingWizardAction,
  type OnboardingWizardController,
} from './onboarding-wizard.ts';

type OnboardingRouteState = {
  onboardingWizard: OnboardingWizardController;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
  openModelPickerWithTarget?: (
    target: import('../model-picker.ts').ModelPickerTarget,
    source?: 'settings' | 'onboarding',
  ) => boolean;
  onAction?: (action: OnboardingWizardAction) => void;
};

function activateSelection(state: OnboardingRouteState): void {
  state.onboardingWizard.activateSelected();
  const target = state.onboardingWizard.consumePendingModelPickerTarget();
  if (target !== null) {
    if (state.openModelPickerWithTarget) state.openModelPickerWithTarget(target, 'onboarding');
    else state.onboardingWizard.clearPendingModelPickerTarget();
  }
  const action = state.onboardingWizard.consumePendingAction();
  if (action !== null) state.onAction?.(action);
}

function isEnterKey(token: InputToken): boolean {
  return token.type === 'key' && (token.logicalName === 'enter' || token.logicalName === 'return');
}

function getKeyTextInput(token: Extract<InputToken, { type: 'key' }>): string | null {
  if (token.ctrl || token.meta) return null;
  if (token.logicalName === 'space') return ' ';
  if (token.logicalName.length !== 1) return null;
  if (token.shift && token.logicalName >= 'a' && token.logicalName <= 'z') {
    return token.logicalName.toUpperCase();
  }
  return token.logicalName;
}

export function handleOnboardingWizardToken(state: OnboardingRouteState, token: InputToken): boolean {
  if (!state.onboardingWizard.active) return false;

  if (state.onboardingWizard.hydrationPending || state.onboardingWizard.hydrationError !== null) {
    if (token.type === 'key' && token.logicalName === 'escape') state.handleEscape();
    state.requestRender();
    return true;
  }

  const visibleFields = getOnboardingWizardVisibleFieldCount(state.getViewportHeight());
  const editing = state.onboardingWizard.isEditingTextField();

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (editing) state.onboardingWizard.cancelEdit();
      else state.handleEscape();
      return true;
    }

    if (editing) {
      if (isEnterKey(token)) {
        state.onboardingWizard.commitEdit();
      } else if (token.logicalName === 'backspace') {
        state.onboardingWizard.editBackspace();
      } else {
        const textInput = getKeyTextInput(token);
        if (textInput !== null) state.onboardingWizard.editChar(textInput);
      }
    } else if (token.logicalName === 'left') {
      state.onboardingWizard.prevStep();
    } else if (token.logicalName === 'right') {
      state.onboardingWizard.nextStep();
    } else if (token.logicalName === 'tab') {
      if (token.shift) state.onboardingWizard.prevStep();
      else state.onboardingWizard.nextStep();
    } else if (token.logicalName === 'up') {
      state.onboardingWizard.moveSelection(-1, visibleFields);
    } else if (token.logicalName === 'down') {
      state.onboardingWizard.moveSelection(1, visibleFields);
    } else if (token.logicalName === 'pageup') {
      state.onboardingWizard.pageSelection(-1, visibleFields);
    } else if (token.logicalName === 'pagedown') {
      state.onboardingWizard.pageSelection(1, visibleFields);
    } else if (token.logicalName === 'home') {
      state.onboardingWizard.selectFirst(visibleFields);
    } else if (token.logicalName === 'end') {
      state.onboardingWizard.selectLast(visibleFields);
    } else {
      const textInput = getKeyTextInput(token);
      if (textInput !== null && state.onboardingWizard.beginSelectedTextInput(textInput)) {
        state.requestRender();
        return true;
      }
      if (isEnterKey(token) || token.logicalName === 'space') {
        activateSelection(state);
      } else if (token.logicalName === 'backspace') {
        state.onboardingWizard.editBackspace();
      }
    }
  } else if (token.type === 'text') {
    if (editing) {
      state.onboardingWizard.editChar(token.value);
    } else if (state.onboardingWizard.beginSelectedTextInput(token.value)) {
      // Direct typing into selected inputs behaves like a real form field.
    } else if (token.value === ' ') {
      activateSelection(state);
    } else if (/^[1-9]$/.test(token.value)) {
      const stepIndex = Number(token.value) - 1;
      if (stepIndex < state.onboardingWizard.steps.length) {
        state.onboardingWizard.setStep(stepIndex);
      }
    }
  }

  state.requestRender();
  return true;
}
