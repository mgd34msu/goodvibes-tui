import type { Widget, WidgetInput } from './types.ts';

export function createWidget(input: WidgetInput): Widget {
    // Simple implementation: generate a random id and spread input
  return { id: crypto.randomUUID(), ...input };

  throw new Error('Not implemented');
}
