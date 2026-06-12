import { normalizeText } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';
import type { OnboardingWizardFieldDefinition, OnboardingWizardStepDefinition } from './onboarding-wizard-types.ts';

export interface WizardStepValidationResult {
  /** Human-readable error strings for each violating field. */
  readonly errors: readonly string[];
  /** ID of the first field that has an error, or null when all pass. */
  readonly firstOffendingFieldId: string | null;
}

/**
 * Validate all fields on a single wizard step, checking:
 *  - required text / masked fields that are empty
 *  - required acknowledgement fields that are unchecked
 *  - any general field-level validation errors (via getFieldValidationError)
 *
 * Returns per-field error messages and the first offending field id so the
 * caller can block navigation and jump focus to the first problem.
 */
export function getStepValidationErrors(
  controller: OnboardingWizardControllerLike,
  step: OnboardingWizardStepDefinition,
): WizardStepValidationResult {
  const errors: string[] = [];
  let firstOffendingFieldId: string | null = null;

  for (const field of step.fields) {
    const error = getFieldError(controller, step, field);
    if (error !== null) {
      errors.push(error);
      if (firstOffendingFieldId === null) firstOffendingFieldId = field.id;
    }
  }

  return { errors, firstOffendingFieldId };
}

function getFieldError(
  controller: OnboardingWizardControllerLike,
  step: OnboardingWizardStepDefinition,
  field: OnboardingWizardFieldDefinition,
): string | null {
  // Required acknowledgement not checked
  if (field.kind === 'acknowledgement' && field.required) {
    if (!controller.isFieldSatisfied(field)) {
      return `${step.shortLabel}: ${field.label} must be acknowledged before continuing.`;
    }
    return null;
  }

  // Required text / masked field that is empty
  if ((field.kind === 'text' || field.kind === 'masked') && field.required === true) {
    const value = normalizeText(controller.getFieldValue(field) as string);
    if (value.length === 0) {
      return `${step.shortLabel}: ${field.label} is required.`;
    }
  }

  // Delegate all other field-level validation (format errors, port range, etc.)
  return controller.getFieldValidationError(step, field);
}

/**
 * Focus the first offending field on the current step by mutating the
 * controller's selectedFieldIndices.  The renderer will pick up the change on
 * the next paint cycle.
 */
export function focusFirstOffendingField(
  controller: OnboardingWizardControllerLike,
  fieldId: string,
): void {
  const fields = controller.currentStep.fields;
  const index = fields.findIndex((f) => f.id === fieldId);
  if (index < 0) return;
  controller.selectedFieldIndices[controller.stepIndex] = index;
}
