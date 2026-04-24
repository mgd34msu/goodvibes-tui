import type { ModelPickerTarget } from '../model-picker.ts';
import type { OnboardingApplyRequest, OnboardingSnapshotState, OnboardingStep1CapabilityId, OnboardingStep1CapabilityItem, OnboardingStepDerivationState } from '../../runtime/onboarding/index.ts';
import { STEP_ORDER } from './onboarding-wizard-constants.ts';
import { buildOnboardingApplyRequest } from './onboarding-wizard-apply.ts';
import { buildOnboardingWizardSteps } from './onboarding-wizard-steps.ts';
import { buildDefaultDerivedState, clamp, cloneSelection, getRuntimeDerivedState, maskValue, modelSelectionLabel, normalizeText } from './onboarding-wizard-helpers.ts';
import { defaultReviewUserMarker as defaultReviewUserMarkerForController, getBooleanFieldValue as getBooleanFieldValueForController, getDefaultAdminUsername as getDefaultAdminUsernameForController, getNumberFieldValue as getNumberFieldValueForController, getPortFieldValue as getPortFieldValueForController, getSelectedSecretMedium as getSelectedSecretMediumForController, getSharedIpDefault as getSharedIpDefaultForController, getSharedIpHostDefault as getSharedIpHostDefaultForController, getStringFieldValue as getStringFieldValueForController, hasAdminAuthUser as hasAdminAuthUserForController, hasBootstrapCredentialPresent as hasBootstrapCredentialPresentForController, hasSelectedInboundExternalSurface as hasSelectedInboundExternalSurfaceForController, hasServerCapabilitiesSelected as hasServerCapabilitiesSelectedForController, isCapabilitySelected as isCapabilitySelectedForController, isRequiredExternalSetupField as isRequiredExternalSetupFieldForController, parseIntegerFieldValue as parseIntegerFieldValueForController, requiresAuthBootstrap as requiresAuthBootstrapForController, selectAllServerCapabilities as selectAllServerCapabilitiesForController, selectLocalTuiOnly as selectLocalTuiOnlyForController, setCapabilityValue as setCapabilityValueForController, shouldEnableBrowserSurface as shouldEnableBrowserSurfaceForController, shouldEnableHttpListener as shouldEnableHttpListenerForController, shouldExposeControlPlaneNetwork as shouldExposeControlPlaneNetworkForController, shouldExposeHttpListenerNetworkFields as shouldExposeHttpListenerNetworkFieldsForController, toggleCapability as toggleCapabilityForController } from './onboarding-wizard-rules.ts';
import { ensureSelectionVisible as ensureSelectionVisibleForController, getBlockingFieldLabels as getBlockingFieldLabelsForController, getCapabilitySelectionState as getCapabilitySelectionStateForController, getCompletedFieldCount as getCompletedFieldCountForController, getCompletedToggleCount as getCompletedToggleCountForController, getCurrentCapabilities as getCurrentCapabilitiesForController, getFieldById as getFieldByIdForController, getFieldValidationError as getFieldValidationErrorForController, getStepFieldCount as getStepFieldCountForController, getToggleFieldCount as getToggleFieldCountForController, hasExistingAccessState as hasExistingAccessStateForController, isFieldDirty as isFieldDirtyForController, isFieldDirtyByDefinition as isFieldDirtyByDefinitionForController, isFieldSatisfied as isFieldSatisfiedForController, isStepDirty as isStepDirtyForController, recalculateDirtyState as recalculateDirtyStateForController, reconcileStateWithCurrentDefinitions as reconcileStateWithCurrentDefinitionsForController, reconcileStepCursor as reconcileStepCursorForController, resetValuesFromCurrentDefinitions as resetValuesFromCurrentDefinitionsForController } from './onboarding-wizard-state.ts';
import type { MutableModelSelectionMap, OnboardingWizardAction, OnboardingWizardFieldDefinition, OnboardingWizardFieldWindow, OnboardingWizardMode, OnboardingWizardModelSelection, OnboardingWizardRuntimeHydration, OnboardingWizardSnapshot, OnboardingWizardStepDefinition, OnboardingWizardStepId } from './onboarding-wizard-types.ts';

export type { OnboardingWizardAcknowledgementFieldDefinition, OnboardingWizardAction, OnboardingWizardActionFieldDefinition, OnboardingWizardChecklistFieldDefinition, OnboardingWizardFieldDefinition, OnboardingWizardFieldKind, OnboardingWizardFieldWindow, OnboardingWizardMaskedFieldDefinition, OnboardingWizardMode, OnboardingWizardModelPickerFieldDefinition, OnboardingWizardModelSelection, OnboardingWizardRadioFieldDefinition, OnboardingWizardRadioOption, OnboardingWizardRuntimeHydration, OnboardingWizardSnapshot, OnboardingWizardStatusFieldDefinition, OnboardingWizardStepDefinition, OnboardingWizardStepId, OnboardingWizardTextFieldDefinition } from './onboarding-wizard-types.ts';
export { getOnboardingWizardBodyRows, getOnboardingWizardVisibleFieldCount } from './onboarding-wizard-helpers.ts';

export class OnboardingWizardController {
  public active = false;
  public mode: OnboardingWizardMode = 'new';
  public stepIndex = 0;
  public hydrationPending = false;
  public readonly scrollOffsets = Array.from({ length: STEP_ORDER.length }, () => 0);
  public readonly selectedFieldIndices = Array.from({ length: STEP_ORDER.length }, () => 0);
  public readonly dirtyStepIds = new Set<OnboardingWizardStepId>();
  public pendingModelPickerTarget: ModelPickerTarget | null = null;
  public pendingAction: OnboardingWizardAction | null = null;

  public readonly toggleState = new Map<string, boolean>();
  public readonly touchedActionFields = new Set<string>();
  public readonly radioState = new Map<string, string>();
  public readonly textState = new Map<string, string>();
  public readonly modelSelectionState: MutableModelSelectionMap = new Map();
  public editingFieldId: string | null = null;
  public editBuffer = '';
  public hydrationError: string | null = null;

  public readonly baselineToggleState = new Map<string, boolean>();
  public readonly baselineRadioState = new Map<string, string>();
  public readonly baselineTextState = new Map<string, string>();
  public readonly baselineModelSelectionState: MutableModelSelectionMap = new Map();

  public runtimeSnapshot: OnboardingSnapshotState | null = null;
  public runtimeDerived: OnboardingStepDerivationState = buildDefaultDerivedState();

  public get steps(): readonly OnboardingWizardStepDefinition[] {
    return buildOnboardingWizardSteps(this);
  }

  public get currentStep(): OnboardingWizardStepDefinition {
    return this.steps[this.stepIndex] ?? this.steps[0]!;
  }

  public get dirty(): boolean {
    return this.dirtyStepIds.size > 0;
  }

  public get dirtyStepCount(): number {
    return this.dirtyStepIds.size;
  }

  constructor() {
    this.resetValuesFromCurrentDefinitions();
  }

  public open(mode: OnboardingWizardMode = 'new'): void {
    this.mode = mode;
    this.active = true;
    this.hydrationPending = false;
    this.hydrationError = null;
    this.stepIndex = 0;
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.editingFieldId = null;
    this.editBuffer = '';
    this.scrollOffsets.fill(0);
    this.selectedFieldIndices.fill(0);
    this.resetValuesFromCurrentDefinitions();
  }

  public close(): void {
    this.active = false;
    this.hydrationPending = false;
    this.hydrationError = null;
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.cancelEdit();
  }

  public reopen(): void {
    this.active = true;
  }

  public setMode(mode: OnboardingWizardMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.cancelEdit();
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.resetValuesFromCurrentDefinitions();
  }

  public hydrateRuntimeState(
    hydration: OnboardingWizardRuntimeHydration,
    options: { resetValues?: boolean } = {},
  ): void {
    this.runtimeSnapshot = hydration.snapshot ?? this.runtimeSnapshot;
    this.runtimeDerived = getRuntimeDerivedState(hydration);
    this.hydrationPending = false;
    this.hydrationError = null;

    if (options.resetValues ?? true) {
      this.pendingModelPickerTarget = null;
      this.cancelEdit();
      this.stepIndex = 0;
      this.resetValuesFromCurrentDefinitions();
      return;
    }

    this.reconcileStateWithCurrentDefinitions();
    this.recalculateDirtyState();
  }

  public captureHydratedState(): OnboardingWizardRuntimeHydration {
    return {
      snapshot: this.runtimeSnapshot,
      derived: this.runtimeDerived,
    };
  }

  public captureSnapshot(): OnboardingWizardSnapshot {
    return {
      active: this.active,
      mode: this.mode,
      stepIndex: this.stepIndex,
      scrollOffsets: [...this.scrollOffsets],
      selectedFieldIndices: [...this.selectedFieldIndices],
      dirtyStepIds: [...this.dirtyStepIds],
      pendingModelPickerTarget: this.pendingModelPickerTarget,
      pendingAction: this.pendingAction,
      toggleState: [...this.toggleState.entries()],
      radioState: [...this.radioState.entries()],
      textState: [...this.textState.entries()],
      modelSelectionState: [...this.modelSelectionState.entries()].map(([target, selection]) => [target, cloneSelection(selection)] as const),
      touchedActionFields: [...this.touchedActionFields],
      editingFieldId: this.editingFieldId,
      editBuffer: this.editBuffer,
      hydrationPending: this.hydrationPending,
      hydrationError: this.hydrationError,
      hydration: this.captureHydratedState(),
    };
  }

  public restoreSnapshot(snapshot: OnboardingWizardSnapshot, options: { active?: boolean } = {}): void {
    this.runtimeSnapshot = snapshot.hydration.snapshot ?? null;
    this.runtimeDerived = getRuntimeDerivedState(snapshot.hydration);
    this.hydrationPending = snapshot.hydrationPending;
    this.hydrationError = snapshot.hydrationError;
    this.mode = snapshot.mode;
    this.stepIndex = clamp(snapshot.stepIndex, 0, Math.max(0, this.steps.length - 1));
    this.pendingModelPickerTarget = snapshot.pendingModelPickerTarget;
    this.pendingAction = snapshot.pendingAction;
    this.dirtyStepIds.clear();
    for (const stepId of snapshot.dirtyStepIds) this.dirtyStepIds.add(stepId);

    for (let index = 0; index < this.scrollOffsets.length; index += 1) {
      this.scrollOffsets[index] = snapshot.scrollOffsets[index] ?? 0;
      this.selectedFieldIndices[index] = snapshot.selectedFieldIndices[index] ?? 0;
    }

    this.toggleState.clear();
    for (const [fieldId, value] of snapshot.toggleState) this.toggleState.set(fieldId, value);
    this.radioState.clear();
    for (const [fieldId, value] of snapshot.radioState) this.radioState.set(fieldId, value);
    this.textState.clear();
    for (const [fieldId, value] of snapshot.textState) this.textState.set(fieldId, value);
    this.modelSelectionState.clear();
    for (const [target, selection] of snapshot.modelSelectionState) this.modelSelectionState.set(target, cloneSelection(selection));
    this.touchedActionFields.clear();
    for (const fieldId of snapshot.touchedActionFields) this.touchedActionFields.add(fieldId);

    this.editingFieldId = snapshot.editingFieldId;
    this.editBuffer = snapshot.editBuffer;
    this.active = options.active ?? snapshot.active;
    this.reconcileStateWithCurrentDefinitions();
    this.recalculateDirtyState();
    this.reconcileStepCursor(this.stepIndex);
  }

  public beginRuntimeHydration(): void {
    this.hydrationPending = true;
    this.hydrationError = null;
    this.stepIndex = 0;
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.cancelEdit();
  }

  public finishRuntimeHydration(): void {
    this.hydrationPending = false;
    this.hydrationError = null;
    this.stepIndex = clamp(this.stepIndex, 0, Math.max(0, this.steps.length - 1));
    this.reconcileStepCursor(this.stepIndex);
  }

  public failRuntimeHydration(message: string): void {
    this.hydrationPending = false;
    this.hydrationError = message;
    this.stepIndex = 0;
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.cancelEdit();
    this.scrollOffsets.fill(0);
    this.selectedFieldIndices.fill(0);
  }

  public setStep(stepIndex: number): void {
    const clamped = clamp(stepIndex, 0, this.steps.length - 1);
    if (clamped === this.stepIndex) return;
    this.cancelEdit();
    this.stepIndex = clamped;
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.reconcileStepCursor(clamped);
  }

  public nextStep(): void {
    this.setStep(this.stepIndex + 1);
  }

  public prevStep(): void {
    this.setStep(this.stepIndex - 1);
  }

  public moveSelection(delta: number, visibleFields: number): void {
    const total = this.currentStep.fields.length;
    if (total === 0) return;
    this.cancelEdit();
    const nextIndex = clamp(this.getSelectedFieldIndex() + delta, 0, total - 1);
    this.selectedFieldIndices[this.stepIndex] = nextIndex;
    this.ensureSelectionVisible(visibleFields);
  }

  public pageSelection(delta: number, visibleFields: number): void {
    const distance = Math.max(1, visibleFields) * delta;
    this.moveSelection(distance, visibleFields);
  }

  public selectFirst(visibleFields: number): void {
    this.cancelEdit();
    this.selectedFieldIndices[this.stepIndex] = 0;
    this.ensureSelectionVisible(visibleFields);
  }

  public selectLast(visibleFields: number): void {
    const total = this.currentStep.fields.length;
    if (total === 0) return;
    this.cancelEdit();
    this.selectedFieldIndices[this.stepIndex] = total - 1;
    this.ensureSelectionVisible(visibleFields);
  }

  public getSelectedFieldIndex(): number {
    this.reconcileStepCursor(this.stepIndex);
    return this.selectedFieldIndices[this.stepIndex] ?? 0;
  }

  public getSelectedField(): OnboardingWizardFieldDefinition | null {
    return this.currentStep.fields[this.getSelectedFieldIndex()] ?? null;
  }

  public isEditingTextField(): boolean {
    return this.editingFieldId !== null;
  }

  public getFieldWindow(visibleFields: number): OnboardingWizardFieldWindow {
    const fields = this.currentStep.fields;
    const total = fields.length;
    if (total === 0) {
      return {
        start: 0,
        end: 0,
        total: 0,
        fields: [],
      };
    }

    this.ensureSelectionVisible(visibleFields);
    const start = clamp(this.scrollOffsets[this.stepIndex] ?? 0, 0, Math.max(0, total - visibleFields));
    const end = Math.min(total, start + Math.max(1, visibleFields));

    return {
      start,
      end,
      total,
      fields: fields.slice(start, end),
    };
  }

  public clearPendingModelPickerTarget(): void {
    this.pendingModelPickerTarget = null;
  }

  public consumePendingModelPickerTarget(): ModelPickerTarget | null {
    const target = this.pendingModelPickerTarget;
    this.pendingModelPickerTarget = null;
    return target;
  }

  public clearPendingAction(): void {
    this.pendingAction = null;
  }

  public consumePendingAction(): OnboardingWizardAction | null {
    const action = this.pendingAction;
    this.pendingAction = null;
    return action;
  }

  public activateSelected(): void {
    if (this.hydrationPending || this.hydrationError !== null) return;
    const field = this.getSelectedField();
    if (!field) return;
    if (field.kind === 'status') return;

    if (field.kind === 'checklist' && field.capabilityId) {
      this.toggleCapability(field.capabilityId);
      this.pendingModelPickerTarget = null;
      this.pendingAction = null;
      this.recalculateDirtyState();
      return;
    }

    if (field.kind === 'checklist' || field.kind === 'acknowledgement') {
      const current = this.toggleState.get(field.id) ?? field.defaultValue;
      this.toggleState.set(field.id, !current);
      this.pendingModelPickerTarget = null;
      this.pendingAction = null;
      this.recalculateDirtyState();
      return;
    }

    if (field.kind === 'radio') {
      const options = field.options;
      const current = this.radioState.get(field.id) ?? field.defaultValue;
      const currentIndex = Math.max(0, options.findIndex((option) => option.id === current));
      const next = options[(currentIndex + 1) % options.length];
      if (!next) return;
      this.radioState.set(field.id, next.id);
      this.pendingModelPickerTarget = null;
      this.pendingAction = null;
      this.recalculateDirtyState();
      return;
    }

    if (field.kind === 'text' || field.kind === 'masked') {
      if (this.editingFieldId === field.id) this.commitEdit();
      else this.beginEdit(field.id);
      return;
    }

    if (field.kind === 'action') {
      if (field.action === 'select-all-capabilities') {
        this.selectAllServerCapabilities();
        this.pendingAction = null;
        this.pendingModelPickerTarget = null;
        this.recalculateDirtyState();
        return;
      }

      if (field.action === 'clear-capabilities') {
        this.selectLocalTuiOnly();
        this.pendingAction = null;
        this.pendingModelPickerTarget = null;
        this.recalculateDirtyState();
        return;
      }

      this.pendingAction = field.action;
      this.pendingModelPickerTarget = null;
      return;
    }

    this.pendingModelPickerTarget = field.target;
    this.pendingAction = null;
    this.touchedActionFields.add(field.id);
  }

  public beginEdit(fieldId: string): void {
    const field = this.getFieldById(fieldId);
    if (!field || (field.kind !== 'text' && field.kind !== 'masked')) return;
    this.pendingModelPickerTarget = null;
    this.pendingAction = null;
    this.editingFieldId = fieldId;
    this.editBuffer = this.textState.get(field.id) ?? field.defaultValue;
  }

  public commitEdit(): void {
    const fieldId = this.editingFieldId;
    if (fieldId === null) return;
    const field = this.getFieldById(fieldId);
    if (field && (field.kind === 'text' || field.kind === 'masked')) {
      this.textState.set(fieldId, this.editBuffer);
      this.recalculateDirtyState();
    }
    this.editingFieldId = null;
    this.editBuffer = '';
  }

  public cancelEdit(): void {
    this.editingFieldId = null;
    this.editBuffer = '';
  }

  public editChar(char: string): void {
    if (this.editingFieldId === null || char.length === 0) return;
    this.editBuffer += char;
  }

  public editBackspace(): void {
    if (this.editingFieldId === null || this.editBuffer.length === 0) return;
    this.editBuffer = this.editBuffer.slice(0, -1);
  }

  public setFieldValue(fieldId: string, value: boolean | string): void {
    const field = this.getFieldById(fieldId);
    if (!field) return;

    if (field.kind === 'checklist' || field.kind === 'acknowledgement') {
      if (typeof value === 'boolean') {
        if (field.kind === 'checklist' && field.capabilityId) this.setCapabilityValue(field.capabilityId, value);
        else this.toggleState.set(fieldId, value);
        this.recalculateDirtyState();
      }
      return;
    }

    if (field.kind === 'radio') {
      if (typeof value === 'string' && field.options.some((option) => option.id === value)) {
        this.radioState.set(fieldId, value);
        this.recalculateDirtyState();
      }
      return;
    }

    if (field.kind === 'text' || field.kind === 'masked') {
      if (typeof value === 'string') {
        this.textState.set(fieldId, value);
        if (this.editingFieldId === fieldId) this.editBuffer = value;
        this.recalculateDirtyState();
      }
    }
  }

  public getFieldValue(
    field: OnboardingWizardFieldDefinition,
  ): boolean | string | OnboardingWizardModelSelection {
    if (field.kind === 'status') return field.defaultValue;

    if (field.kind === 'checklist' || field.kind === 'acknowledgement') {
      return this.toggleState.get(field.id) ?? field.defaultValue;
    }

    if (field.kind === 'radio') {
      return this.radioState.get(field.id) ?? field.defaultValue;
    }

    if (field.kind === 'text' || field.kind === 'masked') {
      if (this.editingFieldId === field.id) return this.editBuffer;
      return this.textState.get(field.id) ?? field.defaultValue;
    }

    if (field.kind === 'action') return field.defaultValue;

    return this.modelSelectionState.get(field.target) ?? field.defaultSelection;
  }

  public getTextFieldValue(fieldId: string, fallback = ''): string {
    return this.getStringFieldValue(fieldId, fallback);
  }

  public getFieldValueLabel(field: OnboardingWizardFieldDefinition): string {
    if (field.kind === 'status') {
      const value = normalizeText(field.defaultValue);
      return value.length > 0 ? value : 'Status';
    }

    if (field.kind === 'checklist') {
      return (this.getFieldValue(field) as boolean) ? 'Included' : 'Off';
    }

    if (field.kind === 'acknowledgement') {
      const accepted = this.getFieldValue(field) as boolean;
      if (accepted) return 'Accepted';
      return field.required ? 'Pending' : 'Not needed';
    }

    if (field.kind === 'radio') {
      const value = this.getFieldValue(field) as string;
      return field.options.find((option) => option.id === value)?.label ?? value;
    }

    if (field.kind === 'text') {
      const value = normalizeText(this.getFieldValue(field) as string);
      return value.length > 0 ? value : field.placeholder;
    }

    if (field.kind === 'masked') {
      const value = normalizeText(this.getFieldValue(field) as string);
      return value.length > 0 ? maskValue(value) : field.placeholder;
    }

    if (field.kind === 'action') return field.defaultValue;

    return modelSelectionLabel(this.getFieldValue(field) as OnboardingWizardModelSelection);
  }

  public applyModelSelection(
    target: ModelPickerTarget,
    selection: Pick<OnboardingWizardModelSelection, 'providerId' | 'modelId'> & { enabled?: boolean },
  ): void {
    this.modelSelectionState.set(target, {
      providerId: selection.providerId,
      modelId: selection.modelId,
      enabled: selection.enabled ?? true,
    });
    this.pendingModelPickerTarget = null;
    this.recalculateDirtyState();
  }

  public buildApplyRequest(): OnboardingApplyRequest {
    return buildOnboardingApplyRequest(this);
  }

  public markApplied(): void {
    this.baselineToggleState.clear();
    for (const [key, value] of this.toggleState) this.baselineToggleState.set(key, value);
    this.baselineRadioState.clear();
    for (const [key, value] of this.radioState) this.baselineRadioState.set(key, value);
    this.baselineTextState.clear();
    for (const [key, value] of this.textState) this.baselineTextState.set(key, value);
    this.baselineModelSelectionState.clear();
    for (const [key, value] of this.modelSelectionState) this.baselineModelSelectionState.set(key, cloneSelection(value));
    this.dirtyStepIds.clear();
  }

  public getSharedIpDefault(enabled: { readonly controlPlane: boolean; readonly httpListener: boolean; readonly web: boolean }): boolean {
    return getSharedIpDefaultForController(this, enabled);
  }

  public getSharedIpHostDefault(enabled: { readonly controlPlane: boolean; readonly httpListener: boolean; readonly web: boolean }): string {
    return getSharedIpHostDefaultForController(this, enabled);
  }

  public defaultReviewUserMarker(): boolean { return defaultReviewUserMarkerForController(this); }
  public toggleCapability(capabilityId: OnboardingStep1CapabilityId): void { toggleCapabilityForController(this, capabilityId); }
  public selectAllServerCapabilities(): void { selectAllServerCapabilitiesForController(this); }
  public selectLocalTuiOnly(): void { selectLocalTuiOnlyForController(this); }
  public setCapabilityValue(capabilityId: OnboardingStep1CapabilityId, selected: boolean): void { setCapabilityValueForController(this, capabilityId, selected); }
  public isCapabilitySelected(capabilityId: OnboardingStep1CapabilityId): boolean { return isCapabilitySelectedForController(this, capabilityId); }
  public hasServerCapabilitiesSelected(): boolean { return hasServerCapabilitiesSelectedForController(this); }
  public shouldEnableBrowserSurface(): boolean { return shouldEnableBrowserSurfaceForController(this); }
  public hasSelectedInboundExternalSurface(): boolean { return hasSelectedInboundExternalSurfaceForController(this); }
  public isRequiredExternalSetupField(fieldId: string): boolean { return isRequiredExternalSetupFieldForController(this, fieldId); }
  public getSelectedSecretMedium(): 'secure' | 'plaintext' { return getSelectedSecretMediumForController(this); }
  public shouldEnableHttpListener(): boolean { return shouldEnableHttpListenerForController(this); }
  public shouldExposeHttpListenerNetworkFields(): boolean { return shouldExposeHttpListenerNetworkFieldsForController(this); }
  public shouldExposeControlPlaneNetwork(): boolean { return shouldExposeControlPlaneNetworkForController(this); }
  public requiresAuthBootstrap(): boolean { return requiresAuthBootstrapForController(this); }
  public hasAdminAuthUser(): boolean { return hasAdminAuthUserForController(this); }
  public hasBootstrapCredentialPresent(): boolean { return hasBootstrapCredentialPresentForController(this); }
  public getDefaultAdminUsername(): string { return getDefaultAdminUsernameForController(this); }
  public getBooleanFieldValue(fieldId: string, fallback: boolean): boolean { return getBooleanFieldValueForController(this, fieldId, fallback); }
  public getStringFieldValue(fieldId: string, fallback: string): string { return getStringFieldValueForController(this, fieldId, fallback); }
  public parseIntegerFieldValue(fieldId: string, fallback: number): number | null { return parseIntegerFieldValueForController(this, fieldId, fallback); }
  public getPortFieldValue(fieldId: string, fallback: number): number { return getPortFieldValueForController(this, fieldId, fallback); }
  public getNumberFieldValue(fieldId: string, fallback: number, min?: number, max?: number): number { return getNumberFieldValueForController(this, fieldId, fallback, min, max); }

  public getToggleFieldCount(stepIndex: number): number { return getToggleFieldCountForController(this, stepIndex); }
  public getCompletedToggleCount(stepIndex: number): number { return getCompletedToggleCountForController(this, stepIndex); }
  public getStepFieldCount(stepIndex: number): number { return getStepFieldCountForController(this, stepIndex); }
  public getCompletedFieldCount(stepIndex: number): number { return getCompletedFieldCountForController(this, stepIndex); }
  public isStepDirty(stepIndex: number): boolean { return isStepDirtyForController(this, stepIndex); }
  public isFieldDirty(fieldId: string): boolean { return isFieldDirtyForController(this, fieldId); }
  public getBlockingFieldLabels(): readonly string[] { return getBlockingFieldLabelsForController(this); }
  public getFieldValidationError(step: OnboardingWizardStepDefinition, field: OnboardingWizardFieldDefinition): string | null { return getFieldValidationErrorForController(this, step, field); }
  public getFieldById(fieldId: string): OnboardingWizardFieldDefinition | null { return getFieldByIdForController(this, fieldId); }
  public ensureSelectionVisible(visibleFields: number): void { ensureSelectionVisibleForController(this, visibleFields); }
  public reconcileStepCursor(stepIndex: number): void { reconcileStepCursorForController(this, stepIndex); }
  public resetValuesFromCurrentDefinitions(): void { resetValuesFromCurrentDefinitionsForController(this); }
  public reconcileStateWithCurrentDefinitions(): void { reconcileStateWithCurrentDefinitionsForController(this); }
  public recalculateDirtyState(): void { recalculateDirtyStateForController(this); }
  public isFieldDirtyByDefinition(field: OnboardingWizardFieldDefinition): boolean { return isFieldDirtyByDefinitionForController(this, field); }
  public isFieldSatisfied(field: OnboardingWizardFieldDefinition): boolean { return isFieldSatisfiedForController(this, field); }
  public getCurrentCapabilities(): readonly OnboardingStep1CapabilityItem[] { return getCurrentCapabilitiesForController(this); }
  public getCapabilitySelectionState(): readonly OnboardingStep1CapabilityItem[] { return getCapabilitySelectionStateForController(this); }
  public hasExistingAccessState(): boolean { return hasExistingAccessStateForController(this); }
}
