// ---------------------------------------------------------------------------
// operator-rpc.test.ts, getOperatorRpc honest-unavailable path + error rendering
//
// Only the "daemon disabled" branch is exercised against a real ConfigManager
// (default daemon.enabled is false, so no daemon/network mock is needed to
// reach it). The happy path (daemon.enabled=true, live HTTP round-trip) is
// exercised indirectly by the per-command tests via their own usage/guard
// branches, standing up a real daemon here would duplicate daemon/server
// tests rather than test this module's own logic.
// ---------------------------------------------------------------------------
import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { GoodVibesSdkError } from '@pellux/goodvibes-sdk';
import type { CommandContext } from '@/input/command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from '@/input/commands/operator-rpc.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeConfigManager(): ConfigManager {
  const workingDir = makeProjectTempDir('gv-operator-rpc');
  tempDirs.push(workingDir);
  const configDir = join(workingDir, '.goodvibes', 'tui');
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir });
}

function makeCtx(configManager: ConfigManager, homeDirectory?: string): CommandContext {
  return {
    platform: { configManager },
    workspace: { shellPaths: homeDirectory ? { homeDirectory } : undefined },
  } as unknown as CommandContext;
}

describe('getOperatorRpc', () => {
  test('is honestly unavailable when the daemon is disabled', () => {
    const configManager = makeConfigManager();
    configManager.setDynamic('daemon.enabled', false);
    const result = getOperatorRpc(makeCtx(configManager));
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain('daemon is disabled');
    }
  });

  test('resolves an operator SDK client when the daemon is enabled with a reachable base URL', () => {
    const configManager = makeConfigManager();
    const homeDirectory = makeProjectTempDir('gv-operator-rpc-home');
    tempDirs.push(homeDirectory);
    const result = getOperatorRpc(makeCtx(configManager, homeDirectory));
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.sdk.operator).toBeDefined();
    }
  });
});

describe('describeOperatorRpcError', () => {
  test('renders a 404 as an honest "not wired up" message', () => {
    const error = new GoodVibesSdkError('not found', { status: 404 });
    expect(describeOperatorRpcError(error)).toContain('404');
    expect(describeOperatorRpcError(error)).toContain('not wired up');
  });

  test('renders a 401/403 as a rejection', () => {
    const error = new GoodVibesSdkError('nope', { status: 401 });
    expect(describeOperatorRpcError(error)).toContain('rejected');
  });

  test('falls back to the plain error message for a non-SDK error', () => {
    expect(describeOperatorRpcError(new Error('boom'))).toBe('boom');
  });
});
