import { AsyncLocalStorage } from 'async_hooks';
import { existsSync, readFileSync } from 'fs';
import type { RuntimeEventBus } from '../events/index.ts';
import type { RuntimeStore } from '../store/index.ts';
import { summarizeError } from '../../utils/error-display.ts';

export interface OpsRuntimeContextConfig {
  runtimeBus: RuntimeEventBus;
  store: RuntimeStore;
  recoveryFilePath: string;
  lastSessionPointerPath: string;
  now?: () => number;
}

export interface OpsRuntimeContextState {
  runtimeBus: RuntimeEventBus;
  store: RuntimeStore;
  recoveryFilePath: string;
  lastSessionPointerPath: string;
  now: () => number;
  lastEventAt: number;
  sessionRecoveryFailedAt?: number;
  sessionRecoveryFailedCount: number;
  detach: () => void;
}

const OBSERVED_DOMAINS = [
  'session',
  'turn',
  'tools',
  'tasks',
  'agents',
  'workflows',
  'providers',
  'permissions',
  'planner',
  'plugins',
  'mcp',
  'transport',
  'ops',
] as const;

const scopedContext = new AsyncLocalStorage<OpsRuntimeContextState | null>();

function createOpsRuntimeContextState(config: OpsRuntimeContextConfig): OpsRuntimeContextState {
  const now = config.now ?? Date.now;
  const unsubs = OBSERVED_DOMAINS.map((domain) =>
    config.runtimeBus.onDomain(domain, (envelope) => {
      state.lastEventAt = envelope.ts;
      if (envelope.type === 'SESSION_RECOVERY_FAILED') {
        state.sessionRecoveryFailedAt = envelope.ts;
        state.sessionRecoveryFailedCount += 1;
      }
    }));

  const state: OpsRuntimeContextState = {
    runtimeBus: config.runtimeBus,
    store: config.store,
    recoveryFilePath: config.recoveryFilePath,
    lastSessionPointerPath: config.lastSessionPointerPath,
    now,
    lastEventAt: now(),
    sessionRecoveryFailedCount: 0,
    detach: () => {
      for (const unsub of unsubs) unsub();
    },
  };
  return state;
}

export async function withOpsRuntimeContext<T>(
  config: OpsRuntimeContextConfig,
  fn: () => Promise<T> | T,
): Promise<T> {
  const state = createOpsRuntimeContextState(config);
  try {
    return await scopedContext.run(state, fn);
  } finally {
    state.detach();
  }
}

export function readRecoveryFileMetadata(path: string): { ok: boolean; summary: string } {
  if (!existsSync(path)) {
    return { ok: false, summary: 'Recovery file does not exist.' };
  }
  try {
    const [firstLine] = readFileSync(path, 'utf-8').split('\n');
    if (!firstLine) {
      return { ok: false, summary: 'Recovery file exists but is empty.' };
    }
    JSON.parse(firstLine);
    return { ok: true, summary: 'Recovery file exists and has valid metadata.' };
  } catch (error) {
    return {
      ok: false,
      summary: `Recovery file is not parseable: ${summarizeError(error)}`,
    };
  }
}
