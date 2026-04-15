import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import type { AgentManager } from '@pellux/goodvibes-sdk/platform/tools/agent/index';

export type AgentManagerLike = Pick<AgentManager, 'spawn' | 'getStatus' | 'list' | 'cancel' | 'listByCohort' | 'clear'>;
export type WrfcConfigLike = {
  scoreThreshold: number;
  maxFixAttempts: number;
  autoCommit: boolean;
  gates: Array<{ name: string; command: string; enabled: boolean }>;
};

export type WrfcConfigReader = Pick<ConfigManager, 'get' | 'getCategory'>;

export function readWrfcConfig(configManager: WrfcConfigReader): WrfcConfigLike {
  const wrfcConfig = configManager.getCategory('wrfc') as Partial<WrfcConfigLike> | undefined;
  return {
    scoreThreshold:
      typeof configManager.get('wrfc.scoreThreshold') === 'number'
        ? (configManager.get('wrfc.scoreThreshold') as number)
        : wrfcConfig?.scoreThreshold ?? 9.9,
    maxFixAttempts:
      typeof configManager.get('wrfc.maxFixAttempts') === 'number'
        ? (configManager.get('wrfc.maxFixAttempts') as number)
        : wrfcConfig?.maxFixAttempts ?? 3,
    autoCommit:
      typeof configManager.get('wrfc.autoCommit') === 'boolean'
        ? (configManager.get('wrfc.autoCommit') as boolean)
        : wrfcConfig?.autoCommit ?? false,
    gates: Array.isArray(wrfcConfig?.gates) ? wrfcConfig.gates : [],
  };
}

export function getWrfcScoreThreshold(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).scoreThreshold ?? 9.9;
}

export function getWrfcMaxFixAttempts(configManager: WrfcConfigReader): number {
  return readWrfcConfig(configManager).maxFixAttempts ?? 3;
}

export function getWrfcAutoCommit(configManager: WrfcConfigReader): boolean {
  return readWrfcConfig(configManager).autoCommit ?? false;
}

export function getEnabledWrfcGates(configManager: WrfcConfigReader): WrfcConfigLike['gates'] {
  return readWrfcConfig(configManager).gates.filter((gate) => gate.enabled);
}
