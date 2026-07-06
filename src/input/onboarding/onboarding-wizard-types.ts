import type { ModelPickerTarget } from '../model-picker.ts';
import {
  type OnboardingAcknowledgementReason,
  type OnboardingAcknowledgementTarget,
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
  | 'finish-openai-subscription'
  | 'connect-existing-daemon'
  | 'migrate-legacy-daemon-service';

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

// ---------------------------------------------------------------------------
// External surface types (moved here to break the surfaces ↔ extra-specs cycle)
// ---------------------------------------------------------------------------

export interface ExternalSurfaceSetupFieldSpec {
  readonly id: string;
  readonly configKey: ConfigKey;
  readonly kind: 'text' | 'masked' | 'radio';
  readonly valueType?: 'string' | 'number';
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly options?: readonly OnboardingWizardRadioOption[];
  readonly defaultNumber?: number;
  readonly min?: number;
  readonly max?: number;
  readonly defaultValue: (snapshot: OnboardingSnapshotState | null) => string;
}

export interface ExternalSurfaceSpec {
  readonly id: string;
  readonly enabledFieldId: string;
  readonly enabledConfigKey: ConfigKey;
  readonly label: string;
  readonly hint: string;
  /**
   * Existing SDK config key. In onboarding this maps to the per-surface
   * auto-start choice, not to whether setup fields are shown.
   */
  readonly defaultEnabled: (snapshot: OnboardingSnapshotState | null) => boolean;
  readonly fields: readonly ExternalSurfaceSetupFieldSpec[];
}

// ---------------------------------------------------------------------------
// Controller interface (moved here to break the wizard ↔ satellites cycle)
// ---------------------------------------------------------------------------

/**
 * Public interface of OnboardingWizardController. Satellite modules
 * (apply, steps, rules, state, cloudflare, cloudflare-step) receive the
 * controller through this interface so they do not need to import from
 * onboarding-wizard.ts and the circular dependency is broken.
 */
export interface OnboardingWizardControllerLike {
  // State fields
  active: boolean;
  mode: OnboardingWizardMode;
  stepIndex: number;
  hydrationPending: boolean;
  hydrationError: string | null;
  pendingModelPickerTarget: ModelPickerTarget | null;
  pendingAction: OnboardingWizardAction | null;
  editingFieldId: string | null;
  editBuffer: string;
  applyFeedback: OnboardingWizardApplyFeedback | null;

  readonly scrollOffsets: number[];
  readonly selectedFieldIndices: number[];
  readonly dirtyStepIds: Set<OnboardingWizardStepId>;
  readonly toggleState: Map<string, boolean>;
  readonly touchedActionFields: Set<string>;
  readonly radioState: Map<string, string>;
  readonly textState: Map<string, string>;
  readonly modelSelectionState: MutableModelSelectionMap;

  readonly baselineToggleState: Map<string, boolean>;
  readonly baselineRadioState: Map<string, string>;
  readonly baselineTextState: Map<string, string>;
  readonly baselineModelSelectionState: MutableModelSelectionMap;

  runtimeSnapshot: OnboardingSnapshotState | null;
  runtimeDerived: OnboardingStepDerivationState;

  // Computed
  readonly steps: readonly OnboardingWizardStepDefinition[];
  readonly currentStep: OnboardingWizardStepDefinition;
  readonly dirty: boolean;
  readonly dirtyStepCount: number;

  // Field value accessors
  getFieldValue(field: OnboardingWizardFieldDefinition): boolean | string | OnboardingWizardModelSelection;
  getFieldById(fieldId: string): OnboardingWizardFieldDefinition | null;
  getStringFieldValue(fieldId: string, fallback: string): string;
  getBooleanFieldValue(fieldId: string, fallback: boolean): boolean;
  parseIntegerFieldValue(fieldId: string, fallback: number): number | null;
  getPortFieldValue(fieldId: string, fallback: number): number;
  getNumberFieldValue(fieldId: string, fallback: number, min?: number, max?: number): number;

  // Capability / rules accessors
  isCapabilitySelected(capabilityId: OnboardingStep1CapabilityId): boolean;
  hasServerCapabilitiesSelected(): boolean;
  shouldEnableBrowserSurface(): boolean;
  hasSelectedInboundExternalSurface(): boolean;
  isRequiredExternalSetupField(fieldId: string): boolean;
  getSelectedSecretMedium(): 'secure' | 'plaintext';
  shouldEnableHttpListener(): boolean;
  shouldExposeHttpListenerNetworkFields(): boolean;
  shouldExposeControlPlaneNetwork(): boolean;
  requiresAuthBootstrap(): boolean;
  hasAdminAuthUser(): boolean;
  hasLocalAuthUser(): boolean;
  hasBootstrapCredentialPresent(): boolean;
  getDefaultAdminUsername(): string;
  getSharedIpDefault(enabled: { readonly controlPlane: boolean; readonly httpListener: boolean; readonly web: boolean }): boolean;
  getSharedIpHostDefault(enabled: { readonly controlPlane: boolean; readonly httpListener: boolean; readonly web: boolean }): string;

  // Capability mutations
  toggleCapability(capabilityId: OnboardingStep1CapabilityId): void;
  selectAllServerCapabilities(): void;
  selectLocalTuiOnly(): void;
  selectAllExternalSurfaces(): void;
  clearExternalSurfaces(): void;
  setCapabilityValue(capabilityId: OnboardingStep1CapabilityId, selected: boolean): void;
  getCurrentCapabilities(): readonly OnboardingStep1CapabilityItem[];
  getCapabilitySelectionState(): readonly OnboardingStep1CapabilityItem[];

  // State operations
  recalculateDirtyState(): void;
  reconcileStateWithCurrentDefinitions(): void;
  reconcileStepCursor(stepIndex: number): void;
  resetValuesFromCurrentDefinitions(): void;
  ensureSelectionVisible(visibleFields: number): void;
  isFieldDirty(fieldId: string): boolean;
  isFieldDirtyByDefinition(field: OnboardingWizardFieldDefinition): boolean;
  isFieldSatisfied(field: OnboardingWizardFieldDefinition): boolean;
  isStepDirty(stepIndex: number): boolean;
  hasExistingAccessState(): boolean;
  getBlockingFieldLabels(): readonly string[];
  getFieldValidationError(step: OnboardingWizardStepDefinition, field: OnboardingWizardFieldDefinition): string | null;
  getToggleFieldCount(stepIndex: number): number;
  getCompletedToggleCount(stepIndex: number): number;
  getStepFieldCount(stepIndex: number): number;
  getCompletedFieldCount(stepIndex: number): number;

  // Additional operations used by steps/apply
  buildApplyRequest(): OnboardingApplyRequest;
  isEditingTextField(): boolean;
  getTextFieldValue(fieldId: string, fallback?: string): string;
  getFieldValueLabel(field: OnboardingWizardFieldDefinition): string;
  getSelectedFieldIndex(): number;
  getSelectedField(): OnboardingWizardFieldDefinition | null;
  getFieldWindow(visibleFields: number): OnboardingWizardFieldWindow;
}

