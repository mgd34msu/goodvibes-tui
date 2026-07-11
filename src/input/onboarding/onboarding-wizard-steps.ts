import { NETWORK_MODE_OPTIONS, REASONING_OPTIONS, HITL_MODE_OPTIONS, GUIDANCE_MODE_OPTIONS, PERMISSION_MODE_OPTIONS, SECRET_POLICY_OPTIONS } from './onboarding-wizard-constants.ts';
import { shouldShowCloudflareStep } from './onboarding-wizard-cloudflare.ts';
import { buildCloudflareStep } from './onboarding-wizard-cloudflare-step.ts';
import {
  EXTERNAL_SURFACE_SPECS,
  getExternalSurfaceAutoStartDefaultValue,
  getExternalSurfaceAutoStartFieldId,
  isExternalSurfaceSelectedByDefault,
  type ExternalSurfaceSpec,
} from './onboarding-wizard-external-surfaces.ts';
import { countSelected, modelSelectionLabel, normalizeText } from './onboarding-wizard-helpers.ts';
import { getDaemonSource, pushDaemonAdoptionFields, pushLegacyDaemonMigrationFields } from './onboarding-wizard-network-adopt.ts';
import type { OnboardingWizardControllerLike } from './onboarding-wizard-types.ts';
import type { OnboardingWizardAcknowledgementFieldDefinition, OnboardingWizardActionFieldDefinition, OnboardingWizardChecklistFieldDefinition, OnboardingWizardExternalSurfaceStepId, OnboardingWizardFieldDefinition, OnboardingWizardModelPickerFieldDefinition, OnboardingWizardRadioFieldDefinition, OnboardingWizardRadioOption, OnboardingWizardStepDefinition } from './onboarding-wizard-types.ts';

export function buildOnboardingWizardSteps(controller: OnboardingWizardControllerLike): readonly OnboardingWizardStepDefinition[] {
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
    for (const surface of getSelectedExternalSurfaceSpecs(controller)) {
      steps.push(buildExternalSurfaceStep(controller, surface));
    }
  }
  if (shouldShowCloudflareStep(controller)) {
    steps.push(buildCloudflareStep(controller));
  }
  steps.push(buildProviderAccessStep(controller));
  steps.push(buildDefaultModelStep(controller));
  steps.push(buildExperienceStep(controller));
  steps.push(buildReviewStep(controller));
  return steps.map(addApplyAndContinueAction);
}

function buildApplyAndContinueAction(step: OnboardingWizardStepDefinition): OnboardingWizardActionFieldDefinition {
    return {
      kind: 'action',
      id: `${step.id}.apply-and-continue`,
      action: 'apply-and-continue',
      label: 'Next section',
      hint: 'Selections are kept in this wizard session and persisted on the final Review apply.',
      defaultValue: 'Apply & next',
      spacerBeforeRows: 2,
    };
  }

function addApplyAndContinueAction(step: OnboardingWizardStepDefinition): OnboardingWizardStepDefinition {
    if (step.id === 'loading' || step.id === 'review') return step;
    return {
      ...step,
      fields: [
        ...step.fields,
        buildApplyAndContinueAction(step),
      ],
    };
  }

export function buildLoadingStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
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

export function buildCapabilitiesStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
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
        hint: 'Enable browser access, LAN reachability, webhooks/events, and external app surfaces. Local TUI Only is turned off.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'capabilities.clear',
        action: 'clear-capabilities',
        label: 'Use Local TUI Only (No Servers)',
        hint: 'Clear all server-backed capabilities: no browser access, LAN reachability, webhooks/events, or external app surfaces. The loopback-only background daemon still runs by default.',
        defaultValue: 'Action',
      },
    ];

    return {
      id: 'capabilities',
      title: 'Choose GoodVibes capabilities',
      shortLabel: 'Capabilities',
      description: 'Choose what GoodVibes should be able to do. Local TUI Only avoids servers; any other choice enables service mode and autostart.',
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

export function buildProvidersStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
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

export function buildProviderAccessStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    return buildProvidersStep(controller);
  }

export function buildDefaultModelStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
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

export function buildExternalServicesStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const selectedCount = EXTERNAL_SURFACE_SPECS
      .filter((surface) => controller.getBooleanFieldValue(
        surface.enabledFieldId,
        isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
      ))
      .length;
    const fields: OnboardingWizardFieldDefinition[] = [];

    for (const surface of EXTERNAL_SURFACE_SPECS) {
      fields.push({
        kind: 'checklist',
        id: surface.enabledFieldId,
        label: surface.label,
        hint: `${surface.hint} Selecting this opens a dedicated setup screen; auto-start is chosen on that screen.`,
        defaultValue: isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
      });
    }

    fields.push(
      {
        kind: 'action',
        id: 'external-services.select-all',
        action: 'select-all-external-surfaces',
        label: 'Select all external surfaces',
        hint: 'Show setup screens for every supported external surface. Auto-start stays controlled per surface.',
        defaultValue: 'Action',
      },
      {
        kind: 'action',
        id: 'external-services.clear',
        action: 'clear-external-surfaces',
        label: 'Clear all external surfaces',
        hint: 'Hide all external surface setup screens. The HTTP listener can still be enabled separately by webhook/event capabilities.',
        defaultValue: 'Action',
      },
      {
        kind: 'radio',
        id: 'external-services.secret-policy',
        label: 'Secret storage policy',
        hint: 'Choose how selected surface secrets should be stored. Secret values are never shown in the wizard.',
        options: SECRET_POLICY_OPTIONS,
        defaultValue: controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure',
      },
    );

    return {
      id: 'external-services',
      title: 'Choose external surfaces',
      shortLabel: 'Services',
      description: 'Select the apps and integration surfaces GoodVibes should prepare. Each selected surface gets its own setup screen and its own auto-start choice.',
      summaryTitle: 'External surfaces',
      summaryLines: [
        `${selectedCount} external surface(s) selected for setup`,
        `Secret policy: ${controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure')}`,
        selectedCount > 0 ? 'Selected surfaces appear as separate setup screens.' : 'No external surfaces selected.',
      ],
      fields,
    };
  }

function getSelectedExternalSurfaceSpecs(controller: OnboardingWizardControllerLike): readonly ExternalSurfaceSpec[] {
    return EXTERNAL_SURFACE_SPECS.filter((surface) => (
      controller.getBooleanFieldValue(
        surface.enabledFieldId,
        isExternalSurfaceSelectedByDefault(surface, controller.runtimeSnapshot),
      )
    ));
  }

const SURFACE_AUTO_START_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  {
    id: 'yes',
    label: 'Yes',
    hint: 'Start this surface automatically when the GoodVibes service starts.',
  },
  {
    id: 'no',
    label: 'No',
    hint: 'Save these settings but leave the surface idle until it is enabled from Settings > Surfaces.',
  },
];

function buildExternalSurfaceStep(
  controller: OnboardingWizardControllerLike,
  surface: ExternalSurfaceSpec,
): OnboardingWizardStepDefinition {
    let setupCount = 0;
    let setupCompleteCount = 0;
    const autoStartFieldId = getExternalSurfaceAutoStartFieldId(surface);
    const autoStartDefault = getExternalSurfaceAutoStartDefaultValue(surface, controller.runtimeSnapshot);
    const autoStartValue = controller.getStringFieldValue(autoStartFieldId, autoStartDefault);
    const setupFields = surface.fields.map((setupField): OnboardingWizardFieldDefinition => {
      const suggested = controller.isRequiredExternalSetupField(setupField.id);
      if (suggested) {
        setupCount += 1;
        if (normalizeText(setupField.defaultValue(controller.runtimeSnapshot)).length > 0
          || normalizeText(controller.getStringFieldValue(setupField.id, '')).length > 0) {
          setupCompleteCount += 1;
        }
      }

      const hint = suggested
        ? `${setupField.hint} Recommended because ${surface.label} is selected, but it will not block saving.`
        : setupField.hint;

      if (setupField.kind === 'radio') {
        return {
          kind: 'radio',
          id: setupField.id,
          label: setupField.label,
          hint,
          options: setupField.options ?? [],
          defaultValue: setupField.defaultValue(controller.runtimeSnapshot),
        };
      }

      return {
        kind: setupField.kind,
        id: setupField.id,
        label: setupField.label,
        hint,
        placeholder: setupField.placeholder,
        defaultValue: setupField.defaultValue(controller.runtimeSnapshot),
      };
    });
    const ntfyTopicSummary = surface.id === 'ntfy'
      ? [
          `Chat topic: ${controller.getStringFieldValue('external-services.ntfy.chat-topic', 'goodvibes-chat')}`,
          `Agent topic: ${controller.getStringFieldValue('external-services.ntfy.agent-topic', 'goodvibes-agent')}`,
          `Daemon-only remote topic: ${controller.getStringFieldValue('external-services.ntfy.remote-topic', 'goodvibes-ntfy')}`,
        ]
      : [];
    const title = `${surface.label.replace(/ surface$/i, '')} setup`;
    const setupSummary = setupCount === 0
      ? 'Suggested setup: none'
      : `Suggested setup entered: ${setupCompleteCount}/${setupCount}`;

    return {
      id: `external-surface:${surface.id}` as OnboardingWizardExternalSurfaceStepId,
      title,
      shortLabel: surface.label.replace(/ surface$/i, ''),
      description: `Configure ${surface.label}. Settings are saved either way; auto-start controls whether this surface starts with the background service.`,
      summaryTitle: `${surface.label} setup`,
      summaryLines: [
        `Auto-start: ${autoStartValue === 'yes' ? 'yes' : 'no'}`,
        ...ntfyTopicSummary,
        setupSummary,
        `Secret policy: ${controller.getStringFieldValue('external-services.secret-policy', controller.runtimeSnapshot?.runtimeDefaults.secretStoragePolicy ?? 'preferred_secure')}`,
        autoStartValue === 'yes'
          ? 'The surface will be enabled after apply.'
          : 'Start it later from Settings > Surfaces by turning Enabled on.',
      ],
      fields: [
        {
          kind: 'radio',
          id: autoStartFieldId,
          label: 'Auto-start this surface',
          hint: `Yes turns on ${surface.enabledConfigKey}. No saves setup values but keeps the surface off until Settings > Surfaces enables it.`,
          options: SURFACE_AUTO_START_OPTIONS,
          defaultValue: autoStartDefault,
        },
        ...setupFields,
      ],
    };
  }

export function buildAccessStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const step = buildAccountsStep(controller);
    return {
      ...step,
      id: 'access',
      title: 'Access and accounts',
      shortLabel: 'Access',
    };
  }

export function buildExperienceStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
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

export function buildNetworkStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const bindSettings = controller.runtimeSnapshot?.bindSettings;
    const browserEnabled = controller.shouldEnableBrowserSurface();
    const listenerEnabled = controller.shouldExposeHttpListenerNetworkFields();
    const listenerWillApply = controller.shouldEnableHttpListener();
    const controlPlaneRemote = controller.shouldExposeControlPlaneNetwork();
    const networkEnabled = { controlPlane: controlPlaneRemote, httpListener: listenerEnabled, web: browserEnabled };
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

    // Recognize an adoptable already-running daemon (see onboarding-wizard-network-adopt.ts).
    const daemonSource = getDaemonSource(controller);
    pushDaemonAdoptionFields(fields, controller, daemonSource, bindSettings);
    pushLegacyDaemonMigrationFields(fields, controller);

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

    if (controlPlaneRemote || listenerEnabled || browserEnabled) { // TLS warn + CORS notice.
      const cpOff = controlPlaneRemote && String(controller.runtimeSnapshot?.config.controlPlane?.tls?.mode ?? 'off') === 'off';
      const hlOff = listenerEnabled && String(controller.runtimeSnapshot?.config.httpListener?.tls?.mode ?? 'off') === 'off';
      if (cpOff || hlOff) { const a = [cpOff ? 'control plane' : '', hlOff ? 'HTTP listener' : ''].filter(Boolean).join(' and '); fields.push({ kind: 'status', id: 'network.tls-warn', label: `TLS off — ${a} transmits plaintext`, defaultValue: 'Warning', hint: `The ${a} is network-reachable but TLS is off. Traffic travels in plaintext. Enable TLS or use a terminating reverse proxy.` }); }
      if (listenerEnabled) { fields.push({ kind: 'status', id: 'network.cors-note', label: 'Browser CORS is off by default', defaultValue: 'Info', hint: 'The webhook/control-plane HTTP listener honors controlPlane.cors.enabled and controlPlane.cors.allowedOrigins. Set both from Settings > Control Plane (or /config controlPlane) to allow browser origins, then restart the daemon. CORS stays off until you enable it.' }); }
    }
    return {
      id: 'network',
      title: 'Network setup',
      shortLabel: 'Network',
      description: 'Choose the LAN default or customize IP addresses and ports for the enabled browser, service, and listener surfaces.',
      summaryTitle: 'Bind posture',
      summaryLines: [
        `Mode: ${custom ? 'custom' : 'local network default'}`,
        `Daemon source: ${daemonSource === 'adopt' ? 'connect to an existing running daemon' : 'start a new daemon'}`,
        `Browser surface: ${browserEnabled ? 'enabled' : 'not selected'}`,
        `HTTP listener: ${listenerWillApply ? 'enabled' : listenerEnabled ? 'available for selected external apps' : 'not selected'}`,
      ],
      fields,
    };
  }

export function buildAccountsStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const subscriptionsAck = controller.runtimeDerived.reopenEditAcknowledgements.subscriptions;
    const authAck = controller.runtimeDerived.reopenEditAcknowledgements.auth;
    const auth = controller.runtimeSnapshot?.auth.snapshot;
    const needsAuthBootstrap = controller.requiresAuthBootstrap();
    const needsExistingAuthAcknowledgement = controller.hasServerCapabilitiesSelected()
      && !needsAuthBootstrap
      && controller.hasLocalAuthUser();
    const fields: OnboardingWizardFieldDefinition[] = [];
    const defaultAdminUsername = controller.getDefaultAdminUsername();

    fields.push(
      {
        kind: 'text',
        id: 'accounts.admin-username',
        label: 'Local auth admin username',
        hint: needsAuthBootstrap
          ? 'Required before any background service, browser surface, or listener is exposed.'
          : 'Optional. Enter an existing admin username to rotate its password, or a new username to create another admin.',
        placeholder: defaultAdminUsername,
        defaultValue: defaultAdminUsername,
        required: needsAuthBootstrap,
      },
      {
        kind: 'masked',
        id: 'accounts.admin-password',
        label: 'Local auth admin password',
        hint: needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent()
            ? 'Creates or updates the named local admin, removes the bootstrap credential file, and retires the bootstrap admin when it is a different user.'
            : 'Creates the first local admin user and an initial session before LAN/server settings are applied.'
          : 'Optional. Leave blank to keep existing local auth unchanged; enter a password to create or rotate the named admin user.',
        placeholder: needsAuthBootstrap ? 'password required' : 'leave blank to keep unchanged',
        defaultValue: '',
        required: needsAuthBootstrap,
      },
    );

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
        label: 'Local auth readiness',
        hint: needsAuthBootstrap
          ? 'The wizard will create local auth before applying network-accessible settings.'
          : controller.hasAdminAuthUser()
            ? 'An existing local auth admin user was detected and will be kept.'
            : controller.hasLocalAuthUser()
              ? 'Existing local auth users were detected and will be kept.'
              : 'No server-backed capability is selected, so local auth is not required.',
        defaultValue: needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent() ? 'Bootstrap replacement required' : 'Local admin required'
          : controller.hasAdminAuthUser() ? 'Admin detected' : controller.hasLocalAuthUser() ? 'Local auth detected' : 'Not required',
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
        : 'Review existing subscription and local auth state. Existing local auth is kept unless you change it elsewhere.',
      summaryTitle: 'Stored account state',
      summaryLines: [
        `Subscriptions: ${controller.runtimeSnapshot?.subscriptions.active.length ?? 0} active / ${controller.runtimeSnapshot?.subscriptions.pending.length ?? 0} pending`,
        `Auth: ${auth?.userCount ?? 0} users / ${auth?.sessionCount ?? 0} sessions`,
        needsAuthBootstrap
          ? controller.hasBootstrapCredentialPresent()
            ? 'Bootstrap credentials will be replaced before network settings are applied'
            : 'Local admin will be created before network settings are applied'
          : controller.hasLocalAuthUser() ? 'Existing local auth will be kept' : 'Local auth is not required for this setup',
      ],
      fields,
    };
  }

export function buildReviewStep(controller: OnboardingWizardControllerLike): OnboardingWizardStepDefinition {
    const feedback = controller.applyFeedback;
    const feedbackFields: OnboardingWizardFieldDefinition[] = feedback
      ? [
          {
            kind: 'status',
            id: 'review.feedback',
            label: feedback.title,
            hint: feedback.summary,
            defaultValue: feedback.severity === 'error' ? 'Needs attention' : feedback.severity === 'warning' ? 'Warning' : 'Info',
          },
          ...feedback.messages.slice(0, 8).map((message, index): OnboardingWizardFieldDefinition => ({
            kind: 'status',
            id: `review.feedback.${index}`,
            label: message,
            hint: message,
            defaultValue: feedback.severity === 'error' ? 'Error' : feedback.severity === 'warning' ? 'Warning' : 'Info',
          })),
        ]
      : [];
    const unsavedLabel = controller.dirtyStepCount === 1
      ? '1 screen has unapplied changes'
      : `${controller.dirtyStepCount} screens have unapplied changes`;

    return {
      id: 'review',
      title: 'Review and apply',
      shortLabel: 'Review',
      description: 'Review the selected settings and apply them directly from the wizard.',
      summaryTitle: 'Review posture',
      summaryLines: [
        unsavedLabel,
        `${controller.buildApplyRequest().operations.length} settings change(s) ready to apply`,
        feedback ? `Last apply: ${feedback.title}` : 'No apply errors reported',
        controller.isEditingTextField() ? `Editing: ${controller.editingFieldId}` : 'Ready to apply',
      ],
      fields: [
        ...feedbackFields,
        {
          kind: 'action',
          id: 'review.apply',
          action: 'apply',
          label: 'Apply settings and verify',
          hint: 'Persist the wizard settings and verify the resulting runtime state. The global onboarding check marker is recorded when apply succeeds.',
          defaultValue: 'Ready',
        },
      ],
    };
  }
