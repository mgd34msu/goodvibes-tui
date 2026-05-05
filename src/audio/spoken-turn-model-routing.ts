import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ModelDefinition, ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { ContentPart } from '@pellux/goodvibes-sdk/platform/providers';
import type { Orchestrator, OrchestratorUserInputOptions } from '../core/orchestrator.ts';

const SPOKEN_TURN_SOURCE = 'tts';

type RunTurn = (
  text: string,
  content?: ContentPart[],
  options?: OrchestratorUserInputOptions,
) => Promise<void>;

type PatchableOrchestrator = {
  runTurn?: RunTurn;
  setCoreServices: (services: { providerRegistry?: ProviderRegistry }) => void;
};

export interface SpokenTurnModelRoutingOptions {
  readonly orchestrator: Orchestrator;
  readonly providerRegistry: ProviderRegistry;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly notify?: (message: string) => void;
}

export function createSpokenTurnInputOptions(): OrchestratorUserInputOptions {
  return {
    origin: {
      source: SPOKEN_TURN_SOURCE,
      surface: 'tui',
      metadata: { spokenOutput: true },
    },
  };
}

export function attachSpokenTurnModelRouting(options: SpokenTurnModelRoutingOptions): () => void {
  const target = options.orchestrator as unknown as PatchableOrchestrator;
  const originalRunTurn = target.runTurn?.bind(options.orchestrator);
  if (!originalRunTurn) return () => {};

  target.runTurn = async (text, content, inputOptions) => {
    if (!isSpokenTurn(inputOptions)) {
      await originalRunTurn(text, content, inputOptions);
      return;
    }

    const override = resolveSpokenTurnModelOverride({
      providerRegistry: options.providerRegistry,
      configManager: options.configManager,
      notify: options.notify,
    });
    if (!override) {
      await originalRunTurn(text, content, inputOptions);
      return;
    }

    const routedRegistry = createRoutedProviderRegistry(options.providerRegistry, override);
    target.setCoreServices({ providerRegistry: routedRegistry });
    try {
      await originalRunTurn(text, content, inputOptions);
    } finally {
      target.setCoreServices({ providerRegistry: options.providerRegistry });
    }
  };

  return () => {
    target.runTurn = originalRunTurn;
    target.setCoreServices({ providerRegistry: options.providerRegistry });
  };
}

export function resolveSpokenTurnModelOverride(options: {
  readonly providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly notify?: (message: string) => void;
}): ModelDefinition | null {
  const modelRef = readConfigString(options.configManager, 'tts.llmModel');
  if (!modelRef) return null;

  const providerId = readConfigString(options.configManager, 'tts.llmProvider');
  const current = options.providerRegistry.getCurrentModel();
  const model = options.providerRegistry.listModels().find((candidate) => {
    const refMatches = candidate.registryKey === modelRef || candidate.id === modelRef;
    const providerMatches = !providerId || candidate.provider === providerId;
    return refMatches && providerMatches;
  });

  if (!model) {
    options.notify?.(`[TTS] Configured TTS LLM '${modelRef}' was not found; using current chat model.`);
    return null;
  }
  if (model.selectable === false) {
    options.notify?.(`[TTS] Configured TTS LLM '${modelRef}' is not selectable; using current chat model.`);
    return null;
  }
  if ((model.registryKey ?? model.id) === (current.registryKey ?? current.id)) return null;
  return model;
}

function isSpokenTurn(options: OrchestratorUserInputOptions | undefined): boolean {
  return options?.origin?.source === SPOKEN_TURN_SOURCE
    || options?.origin?.metadata?.['spokenOutput'] === true;
}

function createRoutedProviderRegistry(providerRegistry: ProviderRegistry, model: ModelDefinition): ProviderRegistry {
  return new Proxy(providerRegistry, {
    get(target, prop, receiver) {
      if (prop === 'getCurrentModel') return () => model;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function readConfigString(configManager: Pick<ConfigManager, 'get'>, key: 'tts.llmProvider' | 'tts.llmModel'): string {
  return String(configManager.get(key) ?? '').trim();
}
