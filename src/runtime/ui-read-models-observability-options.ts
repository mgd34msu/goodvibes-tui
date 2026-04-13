import type { ForensicsRegistry } from './forensics/index.ts';

export interface UiObservabilityReadModelOptions {
  readonly forensicsRegistry?: ForensicsRegistry;
}
