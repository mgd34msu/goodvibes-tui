/**
 * Guided feature coverage for onboarding.
 *
 * Every feature flag that is NOT already reached through a surface/server
 * capability selection (or the HITL experience step) is presented here as ONE
 * unit — its enable toggle plus a meaningful subset of its config sub-options —
 * grouped into thematic first-run steps (safety & sandboxing, memory & context,
 * telemetry & observability, automation & initiative, provider & runtime, and a
 * compact advanced-toggles step). Full sub-option depth lives in /settings; each
 * unit points there.
 *
 * The wizard step builders and the apply builder both read from this single
 * declarative table so the onboarding surface and the settings surface stay in
 * lockstep with the SDK feature-flag set.
 */

import type { ConfigKey } from '../../config/index.ts';
import { getFeatureSetting, isFeatureDefaultEnabled } from '../../runtime/feature-settings.ts';
import type {
  OnboardingWizardControllerLike,
  OnboardingWizardFieldDefinition,
  OnboardingWizardRadioOption,
  OnboardingWizardStepDefinition,
  OnboardingWizardStepId,
} from './onboarding-wizard-types.ts';

// ---------------------------------------------------------------------------
// Declarative model
// ---------------------------------------------------------------------------

/** A single tunable sub-option of a feature unit, rendered as a radio and written when the feature is enabled. */
export interface FeatureSubOption {
  /** Short id; forms the wizard field id `feature.<flagId>.<key>`. */
  readonly key: string;
  readonly configKey: ConfigKey;
  readonly label: string;
  readonly hint: string;
  /** boolean sub-options render as a Yes/No radio and coerce to a boolean config value. */
  readonly valueType: 'enum' | 'boolean' | 'text';
  /** For enum: the option ids (valid schema enum values). For boolean: ignored (Yes/No). */
  readonly options?: readonly string[];
  /** Default option id (enum) / 'yes'|'no' (boolean) / default text. */
  readonly defaultValue: string;
  readonly placeholder?: string;
}

/** A feature unit: its gating flag, its enable label, and its onboarding sub-options. */
export interface FeatureUnit {
  readonly flagId: string;
  readonly label: string;
  readonly hint: string;
  /** Optional extra guidance rendered as a status row under the toggle. */
  readonly note?: string;
  /** Config written verbatim when the feature is enabled (e.g. sandbox.enabled=true). */
  readonly impliedConfig?: ReadonlyArray<{ readonly key: ConfigKey; readonly value: unknown }>;
  /** Prerequisite flags that must also be enabled for this feature to function. */
  readonly requiresFlags?: readonly string[];
  readonly subOptions?: readonly FeatureSubOption[];
}

export interface FeatureSection {
  readonly stepId: OnboardingWizardStepId;
  readonly title: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly units: readonly FeatureUnit[];
}

const YES_NO_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'yes', label: 'Yes', hint: 'Turn this sub-option on.' },
  { id: 'no', label: 'No', hint: 'Leave this sub-option off.' },
];

// ---------------------------------------------------------------------------
// The feature coverage table
// ---------------------------------------------------------------------------

export const FEATURE_ONBOARDING_SECTIONS: readonly FeatureSection[] = [
  {
    stepId: 'features-safety',
    title: 'Safety and sandboxing',
    shortLabel: 'Safety',
    description: 'Optional guardrails for command execution, outbound fetch, tokens, and permission policy. All off by default unless noted; full tuning lives in /settings.',
    units: [
      {
        flagId: 'exec-sandbox',
        label: 'Per-command exec sandbox',
        hint: 'Run shell commands inside an OS-level boundary (bubblewrap on Linux): workspace writable, rest read-only, network off unless allowlisted. Reports unavailable and leaves exec unchanged where bubblewrap is absent.',
        impliedConfig: [{ key: 'sandbox.enabled' as ConfigKey, value: true }],
      },
      {
        flagId: 'sandbox-model-judgment',
        label: 'Sandbox model-judgment tier',
        hint: 'When the exec sandbox leaves a command on ask, a model pass annotates the ask with stated reasons. Never converts allow to deny; never touches the frozen catastrophic block.',
        subOptions: [
          {
            key: 'mode',
            configKey: 'sandbox.judgment' as ConfigKey,
            label: 'Judgment mode',
            hint: 'annotate (default) proposes a verdict with stated reasons and the human still decides; auto-approve additionally auto-approves looks-safe verdicts; off keeps plain asks.',
            valueType: 'enum',
            options: ['off', 'annotate', 'auto-approve'],
            defaultValue: 'annotate',
          },
        ],
      },
      {
        flagId: 'fetch-sanitization',
        label: 'Fetch response sanitization',
        hint: 'Sanitize fetched HTTP content and block SSRF-risk hosts (private IPs, metadata endpoints, localhost).',
        subOptions: [
          {
            key: 'mode',
            configKey: 'fetch.sanitizeMode' as ConfigKey,
            label: 'Default sanitize mode',
            hint: 'none, safe-text (strip active/script content, default), or strict (aggressive text-only).',
            valueType: 'enum',
            options: ['none', 'safe-text', 'strict'],
            defaultValue: 'safe-text',
          },
        ],
      },
      {
        flagId: 'token-scope-rotation-audit',
        label: 'Token scope and rotation audit',
        hint: 'Audit API token scopes and rotation cadence, surfacing overdue or over-scoped tokens.',
        subOptions: [
          {
            key: 'managed',
            configKey: 'security.tokenAudit.managed' as ConfigKey,
            label: 'Block violating tokens (managed)',
            hint: 'Yes blocks over-scoped/overdue tokens from use; No is advisory reporting only (default).',
            valueType: 'boolean',
            defaultValue: 'no',
          },
        ],
      },
      {
        flagId: 'permissions-policy-engine',
        label: 'Permissions policy engine',
        hint: 'Activate the granular tool-class and path-level permission model. Your permission posture from the Experience step still applies.',
      },
      {
        flagId: 'permission-divergence-dashboard',
        label: 'Divergence dashboard and enforce gate',
        hint: 'Aggregate permission-simulation divergence and gate enforce-mode transitions when the divergence rate is too high.',
      },
      {
        flagId: 'policy-as-code',
        label: 'Policy-as-code',
        hint: 'Versioned policy bundle registry with promote/rollback and a divergence gate. Exposes /policy commands.',
        subOptions: [
          {
            key: 'source',
            configKey: 'policy.bundleSource' as ConfigKey,
            label: 'Startup bundle source',
            hint: 'none (bundles supplied via commands) or file (load policy.bundlePath — set it in /settings).',
            valueType: 'enum',
            options: ['none', 'file'],
            defaultValue: 'none',
          },
        ],
      },
      {
        flagId: 'shell-ast-normalization',
        label: 'Shell AST command analysis',
        hint: 'Per-segment verdicts for compound commands with more specific denial explanations. Default on; falls back to the flat matcher on parser failure.',
      },
    ],
  },
  {
    stepId: 'features-context',
    title: 'Memory and context',
    shortLabel: 'Context',
    description: 'How the shell manages the conversation window and what it retrieves per turn. Several default on; turn any off here.',
    units: [
      {
        flagId: 'session-compaction',
        label: 'Structured session compaction',
        hint: 'Compact the main session with semantic chunking and relevance scoring as the window fills.',
        subOptions: [
          {
            key: 'strategy',
            configKey: 'behavior.compactionStrategy' as ConfigKey,
            label: 'Compaction strategy',
            hint: 'structured (in-place summarization, default) or distiller (a fresh-context continuation brief). distiller also needs the distiller feature below.',
            valueType: 'enum',
            options: ['structured', 'distiller'],
            defaultValue: 'structured',
          },
        ],
      },
      {
        flagId: 'compaction-distiller-strategy',
        label: 'Fresh-context distiller compaction',
        hint: 'Enable the distiller strategy option (used only when the strategy above is set to distiller). Scored through the same quality gate as structured, with fallback.',
      },
      {
        flagId: 'agent-context-window-awareness',
        label: 'Agent context-window awareness',
        hint: 'Sub-agents estimate token usage before each call and compact past 85% of the model window. Default on.',
      },
      {
        flagId: 'agent-passive-knowledge-injection',
        label: 'Passive knowledge injection',
        hint: 'Re-retrieve project-memory knowledge each turn against the evolving conversation, under a hard token budget with a per-turn record. Default on.',
      },
      {
        flagId: 'agent-passive-code-injection',
        label: 'Passive code injection',
        hint: 'Also inject ranked chunks from the repo source-tree code index, sharing the same budget. Off by default; needs a built code index (storage.codeIndexEnabled).',
      },
      {
        flagId: 'local-provider-context-ingestion',
        label: 'Local provider context ingestion',
        hint: 'Read the real max context length from local/custom provider /v1/models endpoints for token budgeting. Default on.',
      },
    ],
  },
  {
    stepId: 'features-telemetry',
    title: 'Telemetry and observability',
    shortLabel: 'Telemetry',
    description: 'Instrumentation and tool-result integrity checks. Nothing leaves the machine unless you enable remote export.',
    units: [
      {
        flagId: 'otel-foundation',
        label: 'OpenTelemetry foundation',
        hint: 'In-process span creation and instrumentation. Required before remote export.',
      },
      {
        flagId: 'otel-remote-export',
        label: 'OTLP remote export',
        hint: 'Export spans over OTLP/HTTP JSON to a collector. Enabling this also turns on the OpenTelemetry foundation. Span export reads the OTEL_EXPORTER_OTLP_* environment variables; decision export reads telemetry.decisionOtlpEndpoint — this unit sets the latter.',
        requiresFlags: ['otel-foundation'],
        impliedConfig: [{ key: 'telemetry.decisionOtlpEnabled' as ConfigKey, value: true }],
        subOptions: [
          {
            key: 'endpoint',
            configKey: 'telemetry.decisionOtlpEndpoint' as ConfigKey,
            label: 'Collector endpoint',
            hint: 'OTLP collector URL (e.g. http://localhost:4318). Leave blank to set it later in /settings.',
            valueType: 'text',
            defaultValue: '',
            placeholder: 'http://localhost:4318',
          },
        ],
      },
      {
        flagId: 'output-schema-fingerprint',
        label: 'Output schema fingerprints',
        hint: 'Append schema fingerprints to find/analyze/inspect tool results for drift detection.',
      },
      {
        flagId: 'tool-contract-verification',
        label: 'Tool contract verification',
        hint: 'Registration-time contract checks for every tool (schema, timeout, permission mapping). Default on; invalid tools fail closed.',
      },
      {
        flagId: 'tool-result-reconciliation',
        label: 'Tool result reconciliation',
        hint: 'Inject synthetic error results for dangling tool calls at turn end to prevent silent conversation corruption. Default on.',
      },
    ],
  },
  {
    stepId: 'features-automation',
    title: 'Automation and initiative',
    shortLabel: 'Automation',
    description: 'Durable automation, watchers, delivery reliability, execution planning, and outbound reachability.',
    units: [
      {
        flagId: 'automation-domain',
        label: 'Automation domain',
        hint: 'Durable automation jobs/runs, schedule evaluation, and run history. Enabling this turns on automation.enabled.',
        impliedConfig: [{ key: 'automation.enabled' as ConfigKey, value: true }],
      },
      {
        flagId: 'watcher-framework',
        label: 'Watcher framework',
        hint: 'Managed watcher/listener services with checkpointing and recovery. Enabling this turns on watchers.enabled.',
        impliedConfig: [{ key: 'watchers.enabled' as ConfigKey, value: true }],
      },
      {
        flagId: 'watcher-triggers',
        label: 'Trigger family',
        hint: 'Three unattended watcher kinds over one supervision spine: stream watchers that regex-filter and batch a long-lived command\'s output, model-free condition checks running a probe/extract/rule pipeline with no LLM in the loop, and one-shot on-exit triggers that fire exactly one payload when a launched command terminates. A firing trigger runs an agent turn or a pre-registered digest-pinned action grant — never a command composed at fire time. Off by default because a trigger supervises real processes with nobody watching; with it on and no triggers defined the supervisor idles and consumes nothing.',
        note: 'Backoff ladder, strike breaker, retention bounds, batching and process caps are tuned through watchers.triggers.* in /settings.',
        impliedConfig: [{ key: 'watchers.triggers.enabled' as ConfigKey, value: true }],
      },
      {
        flagId: 'integration-delivery-slo',
        label: 'Integration delivery SLO',
        hint: 'Retry with backoff and a dead-letter queue for Slack/Discord/webhook delivery, with dead-letter events surfaced in diagnostics. On by default; exposes /notify dlq and /notify replay. Retry bounds are tuned in /settings.',
      },
      {
        flagId: 'adaptive-execution-planner',
        label: 'Adaptive execution planner',
        hint: 'Score single/cohort/background/remote strategies each turn and pick the best. Exposes /plan commands.',
      },
      {
        flagId: 'daemon-auto-update',
        label: 'Daemon auto-update',
        hint: 'The daemon checks for a new release hourly, checksum-verifies it, swaps binaries only at a no-active-work moment, and keeps the previous binary for one-command rollback. On by default; update.auto turns it off and update.intervalMinutes tunes the cadence in /settings.',
      },
      {
        flagId: 'relay-connect',
        label: 'Outbound zero-knowledge relay',
        hint: 'Let the daemon reach out to a self-hostable, end-to-end-encrypted relay so surfaces can reach it from outside the LAN. Enabling this turns on relay.enabled; set the relay URL below or later in /settings.',
        impliedConfig: [{ key: 'relay.enabled' as ConfigKey, value: true }],
        subOptions: [
          {
            key: 'url',
            configKey: 'relay.url' as ConfigKey,
            label: 'Relay URL',
            hint: 'Your self-hosted relay endpoint (e.g. wss://relay.example.com). Leave blank to set it later; the daemon stays LAN-only until a URL is set.',
            valueType: 'text',
            defaultValue: '',
            placeholder: 'wss://relay.example.com',
          },
        ],
      },
    ],
  },
  {
    stepId: 'features-devices',
    title: 'Paired devices and voice input',
    shortLabel: 'Devices',
    description: 'What a paired phone may be asked to do on your behalf, and whether GoodVibes listens for a spoken wake phrase. Every phone capability asks the person holding the phone before it runs; the wake word is off by default because holding a microphone open must be an explicit act, and turning it on does open one on this terminal.',
    units: [
      {
        flagId: 'paired-device-capabilities',
        label: 'Paired phone capabilities',
        hint: 'Turning this on grants access to nothing by itself — it lets the agent ASK to use a paired phone as a tool: either camera, its screen, its location, its clipboard, and a small set of device effects (notification, link, buzz). It rides the existing peer transport as a native contract, never an MCP server. Every capture and every effect asks the person holding the phone first, and answering one request grants nothing beyond it; choosing "always allow" is a separate, explicit choice you make later on that prompt, and it writes one durable, revocable grant for that one capability on that one phone, with an age limit and a count cap so nothing is granted forever.',
        note: 'Captures are kept 24 hours by default and then deleted, and every housekeeping sweep records exactly what it removed and why. Retention, grant limits, clipboard and location posture are tuned through device.* in /settings.',
        subOptions: [
          {
            key: 'mode',
            configKey: 'device.capabilities.mode' as ConfigKey,
            label: 'Consent posture',
            hint: 'honor-grants (stock) asks the first time and every time after unless you chose "always allow" for that capability on that phone; ask-every-time prompts on every single request and never consults a durable grant — use it when someone else is holding the phone; off stops any capability request reaching any paired device.',
            valueType: 'enum',
            options: ['off', 'ask-every-time', 'honor-grants'],
            defaultValue: 'honor-grants',
          },
        ],
      },
      {
        flagId: 'wake-word-detection',
        label: 'Wake-word detection',
        hint: 'Listen continuously on a capture device for the pinned "hey goodvibes" phrase and hand the utterance that follows to speech-to-text. Off by default because holding a microphone open must be an explicit act.',
        note: 'On this terminal, turning this on starts a recorder (pw-record, parecord, arecord, ffmpeg or sox — whichever is installed), scores every frame with the pinned classifier, plays a short chime the moment a wake confirms, and shows a persistent "listening" row in the footer for as long as it runs. What follows a wake goes to speech-to-text and lands in the composer, or is sent straight away if you turn voice.wake.autoSubmit on. One thing it will NOT do on its own: download the models — run /voice wake setup, and until then it says so instead of pretending to listen. That same setup fetches the speech gate, so voice.wake.vadThreshold above 0 screens frames once it has run and refuses to start before it has, rather than scoring frames it claims to be screening. voice.wake.noiseSuppression: speex runs here too — the filter travels with the platform, so there is nothing to install for it.',
      },
    ],
  },
  {
    stepId: 'features-provider',
    title: 'Provider and runtime behavior',
    shortLabel: 'Runtime',
    description: 'Provider routing optimization, tool-execution budgets, overflow handling, and notification suppression.',
    units: [
      {
        flagId: 'provider-optimizer',
        label: 'Provider optimizer',
        hint: 'Capability-contract-driven provider routing with explainable route decisions. Exposes /provider route and related commands.',
        subOptions: [
          {
            key: 'mode',
            configKey: 'provider.optimizerMode' as ConfigKey,
            label: 'Routing mode',
            hint: 'manual (default), auto (pick the best capable provider), or pinned (a fixed model; set it in /settings).',
            valueType: 'enum',
            options: ['manual', 'auto', 'pinned'],
            defaultValue: 'manual',
          },
        ],
      },
      {
        flagId: 'runtime-tools-budget-enforcement',
        label: 'Runtime budget enforcement',
        hint: 'Enforce per-phase wall-clock, token, and cost budgets on tool pipelines, terminating on hard breach. Limits are tuned in /settings.',
      },
      {
        flagId: 'overflow-spill-backends',
        label: 'Overflow spill backends',
        hint: 'Choose where overflow content spills when a tool result is too large.',
        subOptions: [
          {
            key: 'backend',
            configKey: 'tools.overflowSpillBackend' as ConfigKey,
            label: 'Spill backend',
            hint: 'ledger (default when this feature is on) or diagnostics; file is the baseline used while the feature is off.',
            valueType: 'enum',
            options: ['file', 'ledger', 'diagnostics'],
            defaultValue: 'ledger',
          },
        ],
      },
      {
        flagId: 'adaptive-notification-suppression',
        label: 'Adaptive notification suppression',
        hint: 'Suppress operational churn in quiet/minimal modes and collapse notification bursts. Burst timings are tuned in /settings.',
      },
    ],
  },
  {
    stepId: 'features-advanced',
    title: 'Advanced runtime toggles',
    shortLabel: 'Advanced',
    description: 'Internal/plumbing features with no tuning knobs. Most people can skip this step; the honest defaults are shown.',
    units: [
      { flagId: 'unified-runtime-task', label: 'Unified RuntimeTask', hint: 'Replace ad-hoc task tracking with the unified RuntimeTask interface. Startup-only.' },
      { flagId: 'plugin-lifecycle', label: 'Plugin lifecycle', hint: 'Structured plugin init/teardown phases with health integration. Startup-only.' },
      { flagId: 'mcp-lifecycle', label: 'MCP lifecycle', hint: 'Structured MCP connect/disconnect phases with health integration. Startup-only.' },
      { flagId: 'permissions-simulation', label: 'Permissions simulation mode', hint: 'Dual-evaluator simulation that tracks divergence without changing enforcement. Startup-only.' },
      { flagId: 'policy-signing', label: 'Policy bundle signing', hint: 'HMAC-SHA256 signature validation on policy bundle load. Startup-only.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wizard field id for a feature unit's enable toggle. */
export function featureEnableFieldId(flagId: string): string {
  return `feature.${flagId}`;
}

/** Wizard field id for a feature unit's sub-option. */
export function featureSubOptionFieldId(flagId: string, key: string): string {
  return `feature.${flagId}.${key}`;
}

/** Whether a feature defaults to enabled (drives the toggle's default-checked state). */
export function isFeatureDefaultOn(flagId: string): boolean {
  return isFeatureDefaultEnabled(flagId);
}

/** Every flag id reachable through the guided feature steps. */
export function getFeatureOnboardingFlagIds(): readonly string[] {
  return FEATURE_ONBOARDING_SECTIONS.flatMap((section) => section.units.map((unit) => unit.flagId));
}

function radioOptionsForSubOption(sub: FeatureSubOption): readonly OnboardingWizardRadioOption[] {
  if (sub.valueType === 'boolean') return YES_NO_OPTIONS;
  return (sub.options ?? []).map((id) => ({ id, label: id, hint: `Use ${id}.` }));
}

// ---------------------------------------------------------------------------
// Step builder
// ---------------------------------------------------------------------------

export function buildFeatureUnitStep(
  controller: OnboardingWizardControllerLike,
  section: FeatureSection,
): OnboardingWizardStepDefinition {
  const fields: OnboardingWizardFieldDefinition[] = [];
  let enabledCount = 0;

  for (const unit of section.units) {
    const defaultOn = isFeatureDefaultOn(unit.flagId);
    const enabled = controller.getBooleanFieldValue(featureEnableFieldId(unit.flagId), defaultOn);
    if (enabled) enabledCount += 1;

    fields.push({
      kind: 'checklist',
      id: featureEnableFieldId(unit.flagId),
      label: unit.label,
      hint: `${unit.hint}${defaultOn ? ' (on by default)' : ''} Full options: /settings.`,
      defaultValue: defaultOn,
    });

    if (unit.note) {
      fields.push({
        kind: 'status',
        id: `${featureEnableFieldId(unit.flagId)}.note`,
        label: unit.note,
        hint: unit.note,
        defaultValue: 'Info',
      });
    }

    for (const sub of unit.subOptions ?? []) {
      if (sub.valueType === 'text') {
        fields.push({
          kind: 'text',
          id: featureSubOptionFieldId(unit.flagId, sub.key),
          label: sub.label,
          hint: sub.hint,
          placeholder: sub.placeholder ?? '',
          defaultValue: sub.defaultValue,
        });
        continue;
      }
      fields.push({
        kind: 'radio',
        id: featureSubOptionFieldId(unit.flagId, sub.key),
        label: sub.label,
        hint: sub.hint,
        options: radioOptionsForSubOption(sub),
        defaultValue: sub.defaultValue,
      });
    }
  }

  return {
    id: section.stepId,
    title: section.title,
    shortLabel: section.shortLabel,
    description: section.description,
    summaryTitle: `${section.title} selections`,
    summaryLines: [
      `${enabledCount}/${section.units.length} feature(s) enabled in this step`,
      'Skippable — the honest defaults above apply if you make no change.',
      'Full sub-option depth for every feature lives in /settings.',
    ],
    fields,
  };
}

/** Build every guided feature step (order matches FEATURE_ONBOARDING_SECTIONS). */
export function buildFeatureUnitSteps(
  controller: OnboardingWizardControllerLike,
): readonly OnboardingWizardStepDefinition[] {
  return FEATURE_ONBOARDING_SECTIONS.map((section) => buildFeatureUnitStep(controller, section));
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Fold the guided feature selections into apply operations: for each unit, when
 * the user's choice differs from the feature's default, record the desired
 * state; when the feature is enabled, write its implied config, prerequisite
 * features, and chosen sub-options. Desired states are collected into
 * `overrides` (flushed by the caller as plain domain-settings writes on each
 * feature's enablement key, together with the surface capabilities); other
 * config writes go straight to setConfig.
 */
export function applyFeatureUnitOperations(
  controller: OnboardingWizardControllerLike,
  setConfig: (key: ConfigKey, value: unknown) => void,
  overrides: Map<string, 'enabled' | 'disabled'>,
): void {
  for (const section of FEATURE_ONBOARDING_SECTIONS) {
    for (const unit of section.units) {
      const defaultOn = isFeatureDefaultOn(unit.flagId);
      const enabled = controller.getBooleanFieldValue(featureEnableFieldId(unit.flagId), defaultOn);

      // Persist the flag only when the user's choice diverges from the default,
      // so a first run that accepts the defaults writes no flag override.
      if (enabled !== defaultOn) overrides.set(unit.flagId, enabled ? 'enabled' : 'disabled');
      if (!enabled) continue;

      for (const prerequisite of unit.requiresFlags ?? []) overrides.set(prerequisite, 'enabled');
      for (const implied of unit.impliedConfig ?? []) setConfig(implied.key, implied.value);

      const enablementKey = getFeatureSetting(unit.flagId)?.enablement.key;
      for (const sub of unit.subOptions ?? []) {
        const raw = controller.getStringFieldValue(featureSubOptionFieldId(unit.flagId, sub.key), sub.defaultValue);
        let wrote = true;
        if (sub.valueType === 'boolean') {
          setConfig(sub.configKey, raw === 'yes');
        } else if (sub.valueType === 'text') {
          wrote = raw.length > 0;
          if (wrote) setConfig(sub.configKey, raw);
        } else {
          setConfig(sub.configKey, raw);
        }
        // A sub-option that writes the unit's OWN enablement key (e.g. the
        // provider-optimizer routing mode) is the authoritative enablement
        // value — drop the pending override so the flush cannot clobber it.
        if (wrote && enablementKey !== undefined && sub.configKey === enablementKey) {
          overrides.delete(unit.flagId);
        }
      }
    }
  }
}
