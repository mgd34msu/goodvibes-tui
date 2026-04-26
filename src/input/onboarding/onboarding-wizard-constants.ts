import type { OnboardingStep1CapabilityItem } from '../../runtime/onboarding/index.ts';
import type { OnboardingWizardRadioOption, OnboardingWizardStepId } from './onboarding-wizard-types.ts';

export const STEP_ORDER: readonly OnboardingWizardStepId[] = [
  'capabilities',
  'network',
  'access',
  'external-services',
  'cloudflare',
  'provider-access',
  'default-model',
  'experience',
  'review',
];

export const DEFAULT_CAPABILITIES: readonly OnboardingStep1CapabilityItem[] = [
  {
    id: 'local-tui-only',
    label: 'Local TUI Only (No Servers)',
    selected: true,
    detail: 'Use GoodVibes only in this terminal. No browser access, background service, HTTP listener, external app surface, or network setup.',
  },
  {
    id: 'browser-access',
    label: 'Open GoodVibes in a Browser',
    selected: false,
    detail: 'Run the background service and web UI. GoodVibes will use the local network by default; you can restrict or customize it next.',
  },
  {
    id: 'network-access',
    label: 'Let other devices use GoodVibes',
    selected: false,
    detail: 'Make enabled GoodVibes services reachable from other devices on your LAN. Local authentication is required.',
  },
  {
    id: 'webhook-events',
    label: 'Receive webhooks or events from other tools',
    selected: false,
    detail: 'Turn on the HTTP listener for incoming webhooks, callbacks, and automation events.',
  },
  {
    id: 'external-integrations',
    label: 'Connect GoodVibes to external apps and services',
    selected: false,
    detail: 'Enable setup screens for Slack, Discord, Telegram, Teams, Matrix, and other app surfaces you choose.',
  },
  {
    id: 'cloudflare-batch',
    label: 'Use Cloudflare for batch or remote daemon work',
    selected: false,
    detail: 'Optionally configure Cloudflare Workers and Queues for explicit or eligible background batch jobs. Immediate local daemon behavior stays the default unless enabled.',
  },
];

export const REASONING_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'instant', label: 'Instant', hint: 'Lowest-latency routing.' },
  { id: 'low', label: 'Low', hint: 'Compact reasoning for quick work.' },
  { id: 'medium', label: 'Medium', hint: 'Balanced latency and quality.' },
  { id: 'high', label: 'High', hint: 'Deeper reasoning for complex tasks.' },
];

export const NETWORK_MODE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'local-network-default', label: 'Local Network (Default)', hint: 'Use the default LAN-facing setup for enabled browser, service, and event features.' },
  { id: 'custom', label: 'Custom', hint: 'Choose IP addresses and ports for each enabled service.' },
];

export const HITL_MODE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'quiet', label: 'Quiet', hint: 'Only interrupt for important attention requests.' },
  { id: 'balanced', label: 'Balanced', hint: 'Show important activity without turning the TUI into a log stream.' },
  { id: 'operator', label: 'Operator', hint: 'Keep operational activity visible for hands-on supervision.' },
];

export const GUIDANCE_MODE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'minimal', label: 'Minimal', hint: 'Use compact guidance and repair suggestions.' },
  { id: 'guided', label: 'Guided', hint: 'Show more explanation while working.' },
  { id: 'off', label: 'Off', hint: 'Disable proactive guidance.' },
];

export const PERMISSION_MODE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'prompt', label: 'Ask before powerful actions', hint: 'Prompt before write, edit, network, and execution tools.' },
  { id: 'allow-all', label: 'Allow everything', hint: 'Allow tools without approval prompts.' },
  { id: 'custom', label: 'Custom advanced rules', hint: 'Use tool-specific permission rules.' },
];

export const SECRET_POLICY_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'preferred_secure', label: 'Use secure storage when available', hint: 'Prefer the secure secret backend and fall back only when needed.' },
  { id: 'require_secure', label: 'Require secure storage', hint: 'Refuse plaintext secret persistence.' },
  { id: 'plaintext_allowed', label: 'Allow plaintext storage', hint: 'Permit local plaintext secret storage.' },
];

export const TELEGRAM_MODE_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'webhook', label: 'Webhook', hint: 'Receive Telegram updates through a webhook.' },
  { id: 'polling', label: 'Polling', hint: 'Poll Telegram for updates from the background service.' },
];

export const WHATSAPP_PROVIDER_OPTIONS: readonly OnboardingWizardRadioOption[] = [
  { id: 'meta-cloud', label: 'Meta Cloud', hint: 'Use the Meta Cloud API.' },
  { id: 'bridge', label: 'Bridge', hint: 'Use a configured bridge service.' },
];

export const INBOUND_EXTERNAL_SURFACE_IDS = new Set<string>([
  'bluebubbles',
  'discord',
  'googleChat',
  'imessage',
  'mattermost',
  'matrix',
  'msteams',
  'ntfy',
  'signal',
  'slack',
  'telegram',
  'webhook',
  'whatsapp',
]);

export const REQUIRED_EXTERNAL_SETUP_FIELD_IDS = new Set<string>([
  'external-services.slack.bot-token',
  'external-services.slack.signing-secret',
  'external-services.discord.bot-token',
  'external-services.discord.application-id',
  'external-services.discord.public-key',
  'external-services.telegram.bot-token',
  'external-services.telegram.webhook-secret',
  'external-services.webhook.default-target',
  'external-services.google-chat.webhook-url',
  'external-services.google-chat.verification-token',
  'external-services.signal.bridge-url',
  'external-services.signal.account',
  'external-services.signal.token',
  'external-services.whatsapp.access-token',
  'external-services.whatsapp.verify-token',
  'external-services.whatsapp.phone-number-id',
  'external-services.imessage.bridge-url',
  'external-services.imessage.account',
  'external-services.imessage.token',
  'external-services.msteams.app-id',
  'external-services.msteams.app-password',
  'external-services.msteams.tenant-id',
  'external-services.bluebubbles.server-url',
  'external-services.bluebubbles.password',
  'external-services.mattermost.base-url',
  'external-services.mattermost.bot-token',
  'external-services.matrix.homeserver-url',
  'external-services.matrix.access-token',
  'external-services.matrix.user-id',
]);

export const NETWORK_HOST_FIELD_IDS = new Set<string>([
  'network.shared-ip-address',
  'network.service-ip',
  'network.browser-ip',
  'network.webhook-ip',
]);
