import type { OpenAICompatOptions } from './openai-compat.ts';
import { OpenAICompatProvider } from './openai-compat.ts';

export interface DiscoveredCompatOptions extends OpenAICompatOptions {}

class DiscoveredCompatProvider extends OpenAICompatProvider {
  constructor(opts: DiscoveredCompatOptions) {
    super(opts);
  }
}

export class VLLMProvider extends DiscoveredCompatProvider {}

export class LlamaCppProvider extends DiscoveredCompatProvider {}

export class TGIProvider extends DiscoveredCompatProvider {}

export class LocalAIProvider extends DiscoveredCompatProvider {}
