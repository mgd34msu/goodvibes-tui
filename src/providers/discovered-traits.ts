import type { ServerType } from '@pellux/goodvibes-sdk/platform/discovery/scanner';
import type { ProviderCapability } from './capabilities.ts';

export interface DiscoveredServerTraits {
  readonly adapter:
    | 'lm-studio'
    | 'ollama'
    | 'vllm'
    | 'llamacpp'
    | 'tgi'
    | 'localai'
    | 'compat';
  readonly reasoningFormat: 'llamacpp' | 'none';
  readonly providerCapabilities?: Partial<ProviderCapability>;
  readonly modelCapabilities: {
    toolCalling: boolean;
    codeEditing: boolean;
    reasoning: boolean;
    multimodal: boolean;
  };
  readonly reasoningEffort?: string[];
}

const DEFAULT_MODEL_CAPABILITIES = {
  toolCalling: true,
  codeEditing: true,
  reasoning: false,
  multimodal: false,
} as const;

const HIGH_TIMEOUT_MS = 300_000;

export function getDiscoveredTraits(serverType: ServerType): DiscoveredServerTraits {
  switch (serverType) {
    case 'lm-studio':
      return {
        adapter: 'lm-studio',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: true,
          jsonMode: false,
          reasoningControls: true,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          reasoning: true,
        },
        reasoningEffort: ['instant', 'low', 'medium', 'high'],
      };
    case 'ollama':
      return {
        adapter: 'ollama',
        reasoningFormat: 'llamacpp',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: true,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          reasoning: true,
        },
        reasoningEffort: ['instant', 'low', 'medium', 'high'],
      };
    case 'vllm':
      return {
        adapter: 'vllm',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: false,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
    case 'llamacpp':
      return {
        adapter: 'llamacpp',
        reasoningFormat: 'llamacpp',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: true,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: {
          ...DEFAULT_MODEL_CAPABILITIES,
          reasoning: true,
        },
        reasoningEffort: ['instant', 'low', 'medium', 'high'],
      };
    case 'tgi':
      return {
        adapter: 'tgi',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: false,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
    case 'localai':
      return {
        adapter: 'localai',
        reasoningFormat: 'none',
        providerCapabilities: {
          streaming: true,
          toolCalling: true,
          parallelTools: false,
          jsonMode: true,
          reasoningControls: false,
          timeoutMs: HIGH_TIMEOUT_MS,
        },
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
    default:
      return {
        adapter: 'compat',
        reasoningFormat: 'none',
        modelCapabilities: DEFAULT_MODEL_CAPABILITIES,
      };
  }
}
