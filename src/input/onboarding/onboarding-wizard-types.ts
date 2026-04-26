import { isIP } from 'node:net';
import type { ModelPickerTarget } from '../model-picker.ts';
import {
  deriveOnboardingStepState,
  type OnboardingAcknowledgementReason,
  type OnboardingAcknowledgementTarget,
  type OnboardingApplyOperation,
  type OnboardingApplyRequest,
  type OnboardingMode,
  type OnboardingSnapshotState,
  type OnboardingStep1CapabilityId,
  type OnboardingStep1CapabilityItem,
  type OnboardingStepDerivationState,
} from '../../runtime/onboarding/index.ts';
import type { ConfigKey } from '../../config/index.ts';

export type OnboardingWizardMode = OnboardingMode;

export type OnboardingWizardExternalSurfaceStepId = `external-surface:${string}`;

export type OnboardingWizardStepId =
  | 'loading'
  | 'capabilities'
  | 'network'
  | 'access'
  | 'external-services'
  | OnboardingWizardExternalSurfaceStepId
  | 'cloudflare'
  | 'provider-access'
  | 'default-model'
  | 'experience'
  | 'review';

export type OnboardingWizardFieldKind =
  | 'status'
  | 'checklist'
  | 'radio'
  | 'text'
  | 'masked'
  | 'acknowledgement'
  | 'modelPicker'
  | 'action';

export type OnboardingWizardAction =
  | 'apply'
  | 'apply-and-continue'
  | 'select-all-capabilities'
  | 'clear-capabilities'
  | 'select-all-external-surfaces'
  | 'clear-external-surfaces'
  | 'cloudflare-token-requirements'
  | 'cloudflare-create-operational-token'
  | 'cloudflare-discover'
  | 'cloudflare-validate'
  | 'cloudflare-provision'
  | 'cloudflare-verify'
  | 'cloudflare-disable'
  | 'start-openai-subscription'
  | 'finish-openai-subscription';

export type OnboardingWizardApplyFeedbackSeverity = 'info' | 'warning' | 'error';

export interface OnboardingWizardApplyFeedback {
  readonly severity: OnboardingWizardApplyFeedbackSeverity;
  readonly title: string;
  readonly summary: string;
  readonly messages: readonly string[];
}

export interface OnboardingWizardRadioOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

export interface OnboardingWizardModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly enabled?: boolean;
}

interface OnboardingWizardFieldBase {
  readonly id: string;
  readonly kind: OnboardingWizardFieldKind;
  readonly label: string;
  readonly hint: string;
  readonly spacerBeforeRows?: number;
}

export interface OnboardingWizardChecklistFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'checklist';
  readonly defaultValue: boolean;
  readonly capabilityId?: OnboardingStep1CapabilityId;
}

export interface OnboardingWizardRadioFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'radio';
  readonly options: readonly OnboardingWizardRadioOption[];
  readonly defaultValue: string;
}

export interface OnboardingWizardTextFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'text';
  readonly defaultValue: string;
  readonly placeholder: string;
  readonly required?: boolean;
}

export interface OnboardingWizardMaskedFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'masked';
  readonly defaultValue: string;
  readonly placeholder: string;
  readonly required?: boolean;
}

export interface OnboardingWizardStatusFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'status';
  readonly defaultValue: string;
}

export interface OnboardingWizardAcknowledgementFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'acknowledgement';
  readonly defaultValue: boolean;
  readonly required: boolean;
  readonly reason: OnboardingAcknowledgementReason;
  readonly target?: OnboardingAcknowledgementTarget;
}

export interface OnboardingWizardModelPickerFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'modelPicker';
  readonly target: ModelPickerTarget;
  readonly defaultSelection: OnboardingWizardModelSelection;
}

export interface OnboardingWizardActionFieldDefinition extends OnboardingWizardFieldBase {
  readonly kind: 'action';
  readonly action: OnboardingWizardAction;
  readonly defaultValue: string;
}

export type OnboardingWizardFieldDefinition =
  | OnboardingWizardStatusFieldDefinition
  | OnboardingWizardChecklistFieldDefinition
  | OnboardingWizardRadioFieldDefinition
  | OnboardingWizardTextFieldDefinition
  | OnboardingWizardMaskedFieldDefinition
  | OnboardingWizardAcknowledgementFieldDefinition
  | OnboardingWizardModelPickerFieldDefinition
  | OnboardingWizardActionFieldDefinition;

export interface OnboardingWizardStepDefinition {
  readonly id: OnboardingWizardStepId;
  readonly title: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly summaryTitle: string;
  readonly summaryLines: readonly string[];
  readonly fields: readonly OnboardingWizardFieldDefinition[];
}

export interface OnboardingWizardFieldWindow {
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly fields: readonly OnboardingWizardFieldDefinition[];
}

export interface OnboardingWizardSnapshot {
  readonly active: boolean;
  readonly mode: OnboardingWizardMode;
  readonly stepIndex: number;
  readonly scrollOffsets: readonly number[];
  readonly selectedFieldIndices: readonly number[];
  readonly dirtyStepIds: readonly OnboardingWizardStepId[];
  readonly pendingModelPickerTarget: ModelPickerTarget | null;
  readonly pendingAction: OnboardingWizardAction | null;
  readonly toggleState: ReadonlyArray<readonly [string, boolean]>;
  readonly radioState: ReadonlyArray<readonly [string, string]>;
  readonly textState: ReadonlyArray<readonly [string, string]>;
  readonly modelSelectionState: ReadonlyArray<readonly [ModelPickerTarget, OnboardingWizardModelSelection]>;
  readonly touchedActionFields: readonly string[];
  readonly editingFieldId: string | null;
  readonly editBuffer: string;
  readonly hydrationPending: boolean;
  readonly hydrationError: string | null;
  readonly applyFeedback: OnboardingWizardApplyFeedback | null;
  readonly hydration: OnboardingWizardRuntimeHydration;
}

export interface OnboardingWizardRuntimeHydration {
  readonly snapshot?: OnboardingSnapshotState | null;
  readonly derived?: Partial<OnboardingStepDerivationState> | null;
}

export type MutableModelSelectionMap = Map<ModelPickerTarget, OnboardingWizardModelSelection>;
