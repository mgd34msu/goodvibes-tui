import { NETWORK_MODE_OPTIONS, REASONING_OPTIONS, HITL_MODE_OPTIONS, GUIDANCE_MODE_OPTIONS, PERMISSION_MODE_OPTIONS, SECRET_POLICY_OPTIONS } from './onboarding-wizard-constants.ts';
import { EXTERNAL_SURFACE_SPECS } from './onboarding-wizard-external-surfaces.ts';
import { countSelected, modelSelectionLabel, normalizeText } from './onboarding-wizard-helpers.ts';
import type { OnboardingWizardController } from './onboarding-wizard.ts';
import type { OnboardingWizardAcknowledgementFieldDefinition, OnboardingWizardChecklistFieldDefinition, OnboardingWizardFieldDefinition, OnboardingWizardModelPickerFieldDefinition, OnboardingWizardRadioFieldDefinition, OnboardingWizardStepDefinition } from './onboarding-wizard-types.ts';

export function buildOnboardingWizardSteps(controller: OnboardingWizardController): readonly OnboardingWizardStepDefinition[] {
  if (controller.hydrationPending || controller.hydrationError !== null) return [buildLoadingStep(controller)];

  const capabilities = controller.getCapabilitySelectionState();
  const hasServers = capabilities.some((item) => item.id !== 'local-tui-only' && item.selected);
  const wantsExternalServices = capabilities.some((item) => item.id === 'external-integrations' && item.selected);
  const steps: OnboardingWizardStepDefinition[] = [
    buildCapabilitiesStep(controller),
  ];

  if (hasServers) {
    steps.push(buildNetworkStep(controller));
  }

  if (hasServers || controller.hasExistingAccessState()) {
    steps.push(buildAccessStep(controller));
  }

  if (wantsExternalServices) {
    steps.push(buildExternalServicesStep(controller));
  }

  steps.push(buildProviderAccessStep(controller));
  steps.push(buildDefaultModelStep(controller));
  steps.push(buildExperienceStep(controller));
  steps.push(buildReviewStep(controller));

  return steps;
}

export function buildLoadingStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const failed = controller.hydrationError !== null;
    return {
      id: 'loading',
      title: failed ? 'Current settings unavailable' : 'Loading current settings',
      shortLabel: 'Loading',
      description: failed
        ? 'The wizard is locked because current runtime settings could not be collected. Close and reopen onboarding after fixing the reported issue.'
        : 'Collecting the current daemon, listener, provider, subscription, auth, and surface settings before the wizard becomes editable.',
      summaryTitle: failed ? 'Preload failed' : 'Preload required',
      summaryLines: [
        failed
          ? 'Editable fields remain locked to avoid applying defaults over existing configuration.'
          : 'Editable fields are locked until runtime settings are loaded.',
        failed
          ? controller.hydrationError ?? 'Unknown snapshot failure.'
          : 'This prevents the wizard from applying defaults over existing configuration.',
      ],
      fields: [
        {
          kind: 'status',
          id: 'loading.runtime-snapshot',
          label: failed ? 'Runtime settings snapshot failed' : 'Runtime settings snapshot',
          hint: failed
            ? controller.hydrationError ?? 'The runtime snapshot did not complete.'
            : 'Waiting for the current GoodVibes configuration and account state.',
          defaultValue: failed ? 'Locked' : 'Loading',
        },
      ],
    };
  }

export function buildCapabilitiesStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const capabilities = controller.getCapabilitySelectionState();
    const selectedCount = countSelected(capabilities);
    const fields: OnboardingWizardFieldDefinition[] = [
      ...capabilities.map((capability) => ({
        kind: 'checklist' as const,
        id: `capabilities.${capability.id}`,
        capabilityId: capability.id,
        label: capability.label,
        hint: capability.detail,
        defaultValue: capability.selected,
      })),
      {
        kind: 'action',
        id: 'capabilities.select-all',
        action: 'select-all-capabilities',
        label: 'Select all server-backed capabilities',
        hint: 'Enable browser access, other-device LAN access, webhooks/events, and external integrations. Local TUI Only is turned off.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'capabilities.clear',
        action: 'clear-capabilities',
        label: 'Use Local TUI Only (No Servers)',
        hint: 'Clear all server-backed capabilities and keep GoodVibes in this terminal only.',
        defaultValue: 'Action',
      },
    ];

    return {
      id: 'capabilities',
      title: 'What should GoodVibes be able to do?',
      shortLabel: 'Capabilities',
      description: 'Choose the features this install should enable. Local TUI Only is selected when no server-backed capabilities are enabled.',
      summaryTitle: 'Selected capabilities',
      summaryLines: [
        `${selectedCount}/${capabilities.length} option(s) selected`,
        `Mode: ${controller.mode === 'edit' ? 'edit existing shell state' : controller.mode === 'reopen' ? 'reopen review flow' : 'new setup'}`,
        controller.runtimeSnapshot?.collectionIssues.length
          ? `${controller.runtimeSnapshot.collectionIssues.length} runtime collection issue(s)`
          : 'Runtime snapshot collected cleanly',
      ],
      fields,
    };
  }

export function buildProvidersStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const providerAck = controller.runtimeDerived.reopenEditAcknowledgements.providers;
    const activeSubscriptions = controller.runtimeSnapshot?.subscriptions.active ?? [];
    const pendingSubscriptions = controller.runtimeSnapshot?.subscriptions.pending ?? [];
    const openAiActive = activeSubscriptions.some((subscription) => subscription.provider === 'openai');
    const openAiPending = pendingSubscriptions.some((subscription) => subscription.provider === 'openai');
    const providerSecretCount = controller.runtimeSnapshot?.secrets.records.filter((record) => record.key.endsWith('_API_KEY') || record.key.endsWith('_TOKEN')).length ?? 0;
    const openAiApiKeyConfigured = controller.runtimeSnapshot?.secrets.records.some((record) => record.key === 'OPENAI_API_KEY') ?? false;
    const providerReviewField: OnboardingWizardAcknowledgementFieldDefinition = {
      kind: 'acknowledgement',
      id: 'providers.reviewed',
      label: 'Confirm provider access review',
      hint: providerAck.detail,
      defaultValue: providerAck.accepted,
      required: controller.mode !== 'new' && providerAck.required,
      reason: providerAck.reason,
      target: 'providers',
    };

    const fields: OnboardingWizardFieldDefinition[] = [
      {
        kind: 'status',
        id: 'providers.openai-subscription',
        label: 'OpenAI subscription status',
        hint: openAiActive
          ? 'An OpenAI subscription session is already available.'
          : openAiPending
            ? 'An OpenAI subscription login is pending.'
            : 'No OpenAI subscription session was found in the current runtime state.',
        defaultValue: openAiActive ? 'Active' : openAiPending ? 'Pending' : 'Not detected',
      },
      {
        kind: 'status',
        id: 'providers.api-key-inventory',
        label: 'Provider API key inventory',
        hint: providerSecretCount > 0
          ? `${providerSecretCount} provider credential reference(s) were found. Values stay masked.`
          : 'No provider API key references were detected in the current runtime state.',
        defaultValue: providerSecretCount > 0 ? `${providerSecretCount} configured` : 'None detected',
      },
      {
        kind: 'masked',
        id: 'providers.openai-api-key',
        label: 'OpenAI API key',
        hint: openAiApiKeyConfigured
          ? 'An OpenAI API key is already stored. Leave blank to keep it; enter a new key to replace it through the secret manager.'
          : 'Optional: enter an OpenAI API key now. The value is stored through the secret manager, not in config.',
        placeholder: openAiApiKeyConfigured ? 'already configured' : 'sk-...',
        defaultValue: '',
      },
      ...(openAiActive ? [] : [
        {
          kind: 'action' as const,
          id: 'providers.openai-subscription-start',
          action: 'start-openai-subscription' as const,
          label: openAiPending ? 'Restart OpenAI subscription sign-in' : 'Start OpenAI subscription sign-in',
          hint: 'Opens the OpenAI sign-in flow from the wizard and records pending login state here.',
          defaultValue: openAiPending ? 'Restart' : 'Start',
        },
        ...(openAiPending ? [
          {
            kind: 'text' as const,
            id: 'providers.openai-authorization-url',
            label: 'OpenAI authorization URL',
            hint: 'If the browser did not open, use this URL to continue sign-in without leaving the wizard.',
            placeholder: 'authorization URL appears after start',
            defaultValue: '',
          },
          {
            kind: 'text' as const,
            id: 'providers.openai-callback-code',
            label: 'OpenAI callback code or URL',
            hint: 'Paste the callback code or redirected URL after completing browser sign-in.',
            placeholder: 'code or callback URL',
            defaultValue: '',
          },
          {
            kind: 'action' as const,
            id: 'providers.openai-subscription-finish',
            action: 'finish-openai-subscription' as const,
            label: 'Finish OpenAI subscription sign-in',
            hint: 'Completes the pending OpenAI subscription login using the code above.',
            defaultValue: 'Finish',
          },
        ] : []),
      ]),
      providerReviewField,
    ];

    return {
      id: 'provider-access',
      title: 'AI provider access',
      shortLabel: 'Providers',
      description: 'Review subscription posture and optionally add an OpenAI API key directly through the wizard.',
      summaryTitle: 'Provider access summary',
      summaryLines: [
        `OpenAI subscription: ${openAiActive ? 'active' : openAiPending ? 'pending' : 'not detected'}`,
        `OpenAI API key: ${openAiApiKeyConfigured ? 'configured' : 'not detected'}`,
        `Provider credential references: ${providerSecretCount}`,
        `Review: ${controller.getFieldValueLabel(providerReviewField)}`,
      ],
      fields,
    };
  }

export function buildProviderAccessStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    return buildProvidersStep(controller);
  }

export function buildDefaultModelStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const routing = controller.runtimeSnapshot?.providerRouting;
    const primarySelectionField: OnboardingWizardModelPickerFieldDefinition = {
      kind: 'modelPicker',
      id: 'default-model.primary-model',
      label: 'Default provider + model',
      hint: 'Open the nested model picker for the shell’s main routing target.',
      target: 'main',
      defaultSelection: {
        providerId: normalizeText(routing?.primaryProviderId),
        modelId: normalizeText(routing?.primaryModelId),
        enabled: true,
      },
    };
    const reasoningField: OnboardingWizardRadioFieldDefinition = {
      kind: 'radio',
      id: 'default-model.reasoning',
      label: 'Reasoning effort',
      hint: 'Use the shell reasoning default that matches the current provider routing.',
      options: REASONING_OPTIONS,
      defaultValue: normalizeText(routing?.primaryReasoningEffort) || 'medium',
    };

    return {
      id: 'default-model',
      title: 'Default model',
      shortLabel: 'Model',
      description: 'Choose the default model routing the shell should use after onboarding.',
      summaryTitle: 'Default model summary',
      summaryLines: [
        `Main: ${modelSelectionLabel(controller.modelSelectionState.get('main') ?? primarySelectionField.defaultSelection)}`,
        `Reasoning: ${controller.getFieldValueLabel(reasoningField)}`,
      ],
      fields: [
        primarySelectionField,
        reasoningField,
      ],
    };
  }

export function buildExternalServicesStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const enabledCount = EXTERNAL_SURFACE_SPECS
      .filter((surface) => controller.getBooleanFieldValue(surface.enabledFieldId, surface.defaultEnabled(controller.runtimeSnapshot)))
      .length;
    const fields: OnboardingWizardFieldDefinition[] = [];

    for (const surface of EXTERNAL_SURFACE_SPECS) {
      const enabled = controller.getBooleanFieldValue(surface.enabledFieldId, surface.defaultEnabled(controller.runtimeSnapshot));
      fields.push({
        kind: 'checklist',
        id: surface.enabledFieldId,
        label: surface.label,
        hint: surface.hint,
        defaultValue: surface.defaultEnabled(controller.runtimeSnapshot),
      });

      if (!enabled) continue;
      for (const setupField of surface.fields) {
        if (setupField.kind === 'radio') {
          fields.push({
            kind: 'radio',
            id: setupField.id,
            label: setupField.label,
            hint: setupField.hint,
            options: setupField.options ?? [],
            defaultValue: setupField.defaultValue(controller.runtimeSnapshot),
          });
          continue;
        }

        fields.push({
          kind: setupField.kind,
          id: setupField.id,
          label: setupField.label,
          hint: setupField.hint,
          placeholder: setupField.placeholder,
          defaultValue: setupField.defaultValue(controller.runtimeSnapshot),
          required: controller.isRequiredExternalSetupField(setupField.id),
        });
      }
    }

    fields.push({
      kind: 'radio',
      id: 'external-services.secret-policy',
      label: 'Secret storage policy',
      hint: 'Choose how external integration secrets should be stored.',
      options: SECRET_POLICY_OPTIONS,
      defaultValue: controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure',
    });

    return {
      id: 'external-services',
      title: 'External apps and services',
      shortLabel: 'Services',
      description: 'Select each external surface this install should prepare and enter its setup values directly in the wizard. Sensitive fields remain masked.',
      summaryTitle: 'External service summary',
      summaryLines: [
        `${enabledCount} external surface(s) selected`,
        `Secret policy: ${controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure')}`,
        'Secrets remain masked and policy-controlled.',
      ],
      fields,
    };
  }

export function buildAccessStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const step = buildAccountsStep(controller);
    return {
      ...step,
      id: 'access',
      title: 'Access and accounts',
      shortLabel: 'Access',
    };
  }

export function buildExperienceStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    return {
      id: 'experience',
      title: 'Shell experience',
      shortLabel: 'Experience',
      description: 'Tune review noise, guidance, and permission posture for day-to-day use.',
      summaryTitle: 'Experience posture',
      summaryLines: [
        `Human-in-the-Loop (HITL): ${controller.getStringFieldValue('experience.hitl', controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced')}`,
        `Guidance: ${controller.getStringFieldValue('experience.guidance', controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal')}`,
        `Permissions: ${controller.getStringFieldValue('experience.permissions', controller.runtimeSnapshot?.runtimeDefaults.permissionsMode ?? 'prompt')}`,
      ],
      fields: [
        {
          kind: 'radio',
          id: 'experience.hitl',
          label: 'Human-in-the-Loop (HITL) mode',
          hint: 'Choose how much operational activity should be surfaced.',
          options: HITL_MODE_OPTIONS,
          defaultValue: controller.runtimeSnapshot?.runtimeDefaults.behavior.hitlMode ?? 'balanced',
        },
        {
          kind: 'radio',
          id: 'experience.guidance',
          label: 'Guidance verbosity',
          hint: 'Choose how much explanation the shell should provide.',
          options: GUIDANCE_MODE_OPTIONS,
          defaultValue: controller.runtimeSnapshot?.runtimeDefaults.behavior.guidanceMode ?? 'minimal',
        },
        {
          kind: 'radio',
          id: 'experience.permissions',
          label: 'Permission posture',
          hint: 'Choose how aggressively the shell should ask before powerful actions.',
          options: PERMISSION_MODE_OPTIONS,
          defaultValue: controller.runtimeSnapshot?.runtimeDefaults.permissionsMode ?? 'prompt',
        },
      ],
    };
  }

export function buildNetworkStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const bindSettings = controller.runtimeSnapshot?.bindSettings;
    const browserEnabled = controller.shouldEnableBrowserSurface();
    const listenerEnabled = controller.shouldExposeHttpListenerNetworkFields();
    const listenerWillApply = controller.shouldEnableHttpListener();
    const controlPlaneRemote = controller.shouldExposeControlPlaneNetwork();
    const networkEnabled = {
      controlPlane: controlPlaneRemote,
      httpListener: listenerEnabled,
      web: browserEnabled,
    };
    const mode = controller.getStringFieldValue('network.mode', controller.runtimeDerived.step1_5NetworkMode);
    const custom = mode === 'custom';
    const fields: OnboardingWizardFieldDefinition[] = [
      {
        kind: 'radio',
        id: 'network.mode',
        label: 'Network mode',
        hint: 'Choose Local Network for the default LAN setup, or Custom to set IP addresses and ports.',
        options: NETWORK_MODE_OPTIONS,
        defaultValue: controller.runtimeDerived.step1_5NetworkMode,
      },
    ];

    if (custom) {
      const sharedIpField: OnboardingWizardChecklistFieldDefinition = {
        kind: 'checklist',
        id: 'network.shared-ip',
        label: 'Use the same IP address for all services',
        hint: 'When included, browser, GoodVibes service, and webhook listener network bindings share one IP address.',
        defaultValue: controller.getSharedIpDefault(networkEnabled),
      };
      const sharedIp = controller.getBooleanFieldValue(sharedIpField.id, sharedIpField.defaultValue);
      fields.push(sharedIpField);
      if (sharedIp) {
        fields.push({
          kind: 'text',
          id: 'network.shared-ip-address',
          label: 'Shared IP address',
          hint: 'IP address used by each enabled service.',
          placeholder: '0.0.0.0',
          defaultValue: controller.getSharedIpHostDefault(networkEnabled),
        });
      }

      if (controlPlaneRemote) {
        fields.push({
          kind: 'text',
          id: 'network.service-port',
          label: 'GoodVibes service port',
          hint: 'Port for the background service and control plane.',
          placeholder: '3421',
          defaultValue: String(bindSettings?.controlPlane.port ?? 3421),
        });
        if (!sharedIp) {
          fields.push({
            kind: 'text',
            id: 'network.service-ip',
            label: 'GoodVibes service IP address',
            hint: 'IP address for the background service and control plane.',
            placeholder: '0.0.0.0',
            defaultValue: normalizeText(bindSettings?.controlPlane.host) || '0.0.0.0',
          });
        }
      }

      if (browserEnabled) {
        fields.push({
          kind: 'text',
          id: 'network.browser-port',
          label: 'Browser surface port',
          hint: 'Port for browser access to GoodVibes.',
          placeholder: '3423',
          defaultValue: String(bindSettings?.web.port ?? 3423),
        });
        if (!sharedIp) {
          fields.push({
            kind: 'text',
            id: 'network.browser-ip',
            label: 'Browser surface IP address',
            hint: 'IP address for browser access.',
            placeholder: '0.0.0.0',
            defaultValue: normalizeText(bindSettings?.web.host) || '0.0.0.0',
          });
        }
      }

      if (listenerEnabled) {
        fields.push({
          kind: 'text',
          id: 'network.webhook-port',
          label: 'HTTP listener port',
          hint: 'Port for incoming webhooks and events.',
          placeholder: '3422',
          defaultValue: String(bindSettings?.httpListener.port ?? 3422),
        });
        if (!sharedIp) {
          fields.push({
            kind: 'text',
            id: 'network.webhook-ip',
            label: 'HTTP listener IP address',
            hint: 'IP address for incoming webhooks and events.',
            placeholder: '0.0.0.0',
            defaultValue: normalizeText(bindSettings?.httpListener.host) || '0.0.0.0',
          });
        }
      }
    }

    return {
      id: 'network',
      title: 'Network setup',
      shortLabel: 'Network',
      description: 'Choose the LAN default or customize IP addresses and ports for the enabled browser, service, and listener surfaces.',
      summaryTitle: 'Bind posture',
      summaryLines: [
        `Mode: ${custom ? 'custom' : 'local network default'}`,
        `Browser surface: ${browserEnabled ? 'enabled' : 'not selected'}`,
        `HTTP listener: ${listenerWillApply ? 'enabled' : listenerEnabled ? 'available for selected external apps' : 'not selected'}`,
      ],
      fields,
    };
  }

export function buildAccountsStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    const subscriptionsAck = controller.runtimeDerived.reopenEditAcknowledgements.subscriptions;
    const authAck = controller.runtimeDerived.reopenEditAcknowledgements.auth;
    const auth = controller.runtimeSnapshot?.auth.snapshot;
    const needsAuthBootstrap = controller.requiresAuthBootstrap();
    const needsExistingAuthAcknowledgement = controller.hasServerCapabilitiesSelected()
      && !needsAuthBootstrap
      && controller.hasAdminAuthUser();
    const fields: OnboardingWizardFieldDefinition[] = [];

    if (needsAuthBootstrap) {
      const defaultAdminUsername = controller.getDefaultAdminUsername();
      fields.push(
        {
          kind: 'text',
          id: 'accounts.admin-username',
          label: 'Local auth admin username',
          hint: 'Required before any background service, browser surface, or listener is exposed.',
          placeholder: defaultAdminUsername,
          defaultValue: defaultAdminUsername,
          required: true,
        },
        {
          kind: 'masked',
          id: 'accounts.admin-password',
          label: 'Local auth admin password',
          hint: controller.hasBootstrapCredentialPresent()
            ? 'Creates a new local admin, removes the bootstrap credential file, and retires the bootstrap admin before LAN/server settings are applied.'
            : 'Creates the first local admin user and an initial session before LAN/server settings are applied.',
          placeholder: 'password required',
          defaultValue: '',
          required: true,
        },
      );
    }

    fields.push(
      {
        kind: 'acknowledgement',
        id: 'accounts.subscriptions',
        label: 'Confirm stored subscription state',
        hint: subscriptionsAck.detail,
        defaultValue: subscriptionsAck.accepted,
        required: controller.mode !== 'new' && subscriptionsAck.required,
        reason: subscriptionsAck.reason,
        target: 'subscriptions',
      },
      {
        kind: 'acknowledgement',
        id: 'accounts.auth',
        label: 'Confirm local auth posture',
        hint: authAck.detail,
        defaultValue: authAck.accepted,
        required: needsExistingAuthAcknowledgement || (controller.mode !== 'new' && authAck.required),
        reason: authAck.reason,
        target: 'auth',
      },
      {
        kind: 'status',
        id: 'accounts.bootstrap',
        label: 'Bootstrap credential hint',
        hint: needsAuthBootstrap
          ? 'The wizard will create local auth before applying network-accessible settings.'
          : 'Masked auth state stays visible without leaking sensitive values.',
        defaultValue: needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent() ? 'Bootstrap replacement required' : 'Local admin required'
          : auth?.bootstrapCredentialPresent ? 'Configured' : 'Not detected',
      },
      {
        kind: 'status',
        id: 'accounts.user-store',
        label: 'Local auth store path',
        hint: 'Carry the current auth store location into edit/review mode.',
        defaultValue: normalizeText(auth?.userStorePath) || 'No local auth store path',
      },
    );

    return {
      id: 'access',
      title: 'Subscriptions and auth review',
      shortLabel: 'Accounts',
      description: needsAuthBootstrap
        ? 'Create wizard-owned local auth before any LAN, browser, service, or listener settings are applied.'
        : 'Require explicit acknowledgement for existing subscription or local-auth state when reopening the wizard in edit mode.',
      summaryTitle: 'Stored account state',
      summaryLines: [
        `Subscriptions: ${controller.runtimeSnapshot?.subscriptions.active.length ?? 0} active / ${controller.runtimeSnapshot?.subscriptions.pending.length ?? 0} pending`,
        `Auth: ${auth?.userCount ?? 0} users / ${auth?.sessionCount ?? 0} sessions`,
        needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent()
            ? 'Bootstrap credentials will be replaced before network settings are applied'
            : 'Local admin will be created before network settings are applied'
          : auth?.bootstrapCredentialPresent ? 'Bootstrap credential file present' : 'No bootstrap credential file detected',
      ],
      fields,
    };
  }

export function buildReviewStep(controller: OnboardingWizardController): OnboardingWizardStepDefinition {
    return {
      id: 'review',
      title: 'Review and completion',
      shortLabel: 'Review',
      description: 'Review the selected settings and apply them directly from the wizard.',
      summaryTitle: 'Review posture',
      summaryLines: [
        `${controller.dirtyStepCount} dirty step(s)`,
        `${controller.buildApplyRequest().operations.length} operation(s) ready to apply`,
        `Pending picker: ${controller.pendingModelPickerTarget ?? 'none'}`,
        controller.isEditingTextField() ? `Editing: ${controller.editingFieldId}` : 'Ready for apply/verify',
      ],
      fields: [
        {
          kind: 'checklist',
          id: 'review.project-marker',
          label: 'Write project completion marker',
          hint: 'Project scope keeps the workspace-specific completion state close to the repo.',
          defaultValue: true,
        },
        {
          kind: 'checklist',
          id: 'review.user-marker',
          label: 'Write user completion marker',
          hint: 'User scope keeps the shell-level completion marker available outside this workspace.',
          defaultValue: controller.defaultReviewUserMarker(),
        },
        {
          kind: 'action',
          id: 'review.apply',
          action: 'apply',
          label: 'Apply settings and verify',
          hint: 'Persist the wizard settings, write completion markers, and verify the resulting runtime state.',
          defaultValue: 'Ready',
        },
      ],
    };
  }
