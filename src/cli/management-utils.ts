/**
 * management-utils.ts — shared CLI utility functions.
 *
 * Extracted from management.ts to break the import cycle:
 *   management.ts ↔ management-commands.ts
 *   management.ts ↔ surface-command.ts
 *
 * Both management-commands.ts and surface-command.ts import from here;
 * management.ts also imports from here (no longer from the child modules
 * for these utilities).
 *
 * No imports from management-commands.ts or surface-command.ts are allowed
 * in this file — that would recreate the cycle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import type { ConfigManager, GoodVibesConfig } from '@pellux/goodvibes-sdk/platform/config';
import { bootstrapRuntime } from '../runtime/bootstrap.ts';
import { refreshMemoryRecallSnapshot } from '../runtime/orchestrator-core-services.ts';
import { createRuntimeServices } from '../runtime/services.ts';
import { createRuntimeStore } from '../runtime/store/index.ts';
import type { RuntimeServices } from '../runtime/services.ts';
import { RuntimeEventBus, type TurnEvent, createShellPathService, configureRuntimeEventBusDefaults, runtimeEventBusOptionsFrom } from '@/runtime/index.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { resolveRuntimeEndpointBinding } from '@pellux/goodvibes-terminal-shell';
import { applyRuntimeEndpointFlagOverrides } from '@pellux/goodvibes-terminal-shell';
import type { RuntimeEndpointId } from '@pellux/goodvibes-terminal-shell';
import type { CliCommandRuntime, GoodVibesCliParseResult } from '@pellux/goodvibes-terminal-shell';
import { openBrowser as _openBrowser } from '../utils/browser.ts';

type Formatter = (value: unknown, text: string) => string;

export function yesNo(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

export function formatJsonOrText(cli: GoodVibesCliParseResult): Formatter {
  return (value, text) => cli.flags.outputFormat === 'json'
    ? JSON.stringify(value, null, 2)
    : text;
}

export function exitCodeForText(output: string): number {
  if (output.startsWith('Usage:') || output.startsWith('Invalid ')) return 2;
  if (output.startsWith('Session not found:') || output.startsWith('Unknown task:') || output.startsWith('Task submit failed ')) return 1;
  if (output.startsWith('No stored ') || output.startsWith('No pending ') || output.startsWith('No model ') || output.startsWith('No provider ') || output.startsWith('No auth ')) return 1;
  if (output.startsWith('Unknown ')) return 1;
  if (output === 'Bundle has no config object to import.') return 1;
  return 0;
}

export function splitCommandOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return { name: token.slice(0, index), value: token.slice(index + 1) };
}

export function readOptionValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const split = splitCommandOption(token);
    if (split.name !== name) continue;
    if (split.value !== undefined) return split.value;
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) return undefined;
    return next;
  }
  return undefined;
}

export function readOptionValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const split = splitCommandOption(token);
    if (split.name !== name) continue;
    if (split.value !== undefined) {
      values.push(split.value);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) values.push(next);
  }
  return values;
}

export function hasCommandFlag(args: readonly string[], name: string): boolean {
  return args.some((arg) => splitCommandOption(arg).name === name);
}

export function commandValues(args: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) {
      values.push(token);
      continue;
    }
    if (!token.includes('=') && args[index + 1] && !args[index + 1]!.startsWith('--')) index += 1;
  }
  return values;
}

export function readPassword(args: readonly string[]): string | null {
  const explicit = readOptionValue(args, '--password');
  if (explicit !== undefined) return explicit;
  if (hasCommandFlag(args, '--password-stdin')) return readFileSync(0, 'utf-8').trimEnd();
  return process.env.GOODVIBES_AUTH_PASSWORD ?? null;
}

export function extractAuthorizationCode(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get('code') ?? input;
  } catch {
    return input;
  }
}

export function isPresentConfigValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null && value !== false;
}

export function getNestedValue(source: unknown, key: string): unknown {
  let cursor = source;
  for (const part of key.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function getLocalNetworkIp(): string {
  try {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const netInfo of nets[name] ?? []) {
        if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
      }
    }
  } catch {
    return '127.0.0.1';
  }
  return '127.0.0.1';
}

function connectHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host || '127.0.0.1';
}

export function urlHostForBindHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return getLocalNetworkIp();
  return host || '127.0.0.1';
}

export function enableServicePosture(config: ConfigManager): void {
  config.setDynamic('service.enabled', true);
  config.setDynamic('service.autostart', true);
  config.setDynamic('service.restartOnFailure', true);
}

export function enableEndpointLanDefault(config: ConfigManager, endpoint: RuntimeEndpointId): void {
  const binding = resolveRuntimeEndpointBinding(config, endpoint);
  if (binding.hostMode === 'custom') return;
  if (endpoint === 'controlPlane') {
    config.setDynamic('controlPlane.hostMode', 'network');
    config.setDynamic('controlPlane.host', '0.0.0.0');
    config.setDynamic('controlPlane.allowRemote', true);
    return;
  }
  if (endpoint === 'httpListener') {
    config.setDynamic('httpListener.hostMode', 'network');
    config.setDynamic('httpListener.host', '0.0.0.0');
    return;
  }
  config.setDynamic('web.hostMode', 'network');
  config.setDynamic('web.host', '0.0.0.0');
}

export function applyTargetEndpointFlagsOrDefault(
  runtime: CliCommandRuntime,
  endpoint: RuntimeEndpointId,
): string | null {
  const errors = applyRuntimeEndpointFlagOverrides(runtime.configManager, endpoint, runtime.cli.flags);
  if (errors.length > 0) return errors.join('\n');
  if (runtime.cli.flags.hostname === undefined) {
    enableEndpointLanDefault(runtime.configManager, endpoint);
  }
  if (endpoint === 'controlPlane') {
    const binding = resolveRuntimeEndpointBinding(runtime.configManager, endpoint);
    runtime.configManager.setDynamic('controlPlane.allowRemote', binding.hostMode !== 'local');
  }
  return null;
}

/**
 * Re-export openBrowser from utils/browser.ts for backward compatibility.
 * management.ts and management-commands.ts both used to export/import this;
 * now all callers should prefer importing from utils/browser.ts directly.
 */
export { openBrowser } from '../utils/browser.ts';

export async function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function withRuntimeServices<T>(
  runtime: CliCommandRuntime,
  fn: (services: RuntimeServices) => Promise<T> | T,
): Promise<T> {
  // Point the bus listener cap at runtime.eventBus.maxListeners before the
  // first bus exists, so every bus this process builds later uses it.
  configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) => runtime.configManager.get(key)));
  const runtimeBus = new RuntimeEventBus();
  const runtimeStore = createRuntimeStore();
  const services = createRuntimeServices({
    configManager: runtime.configManager,
    runtimeBus,
    runtimeStore,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  services.providerRegistry.initModelLimits();
  services.benchmarkStore.initBenchmarks();
  services.providerRegistry.initCatalog();
  try {
    await services.providerRegistry.ready();
    return await fn(services);
  } finally {
    services.providerRegistry.stopWatching();
    // A one-shot command still composes the whole graph, and that graph starts
    // pollers. Disposing lets the command finish instead of relying on process
    // exit to reclaim them.
    services.dispose();
  }
}

export function readAuthPaths(runtime: CliCommandRuntime) {
  const shellPaths = createShellPathService({
    workingDirectory: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });
  const userStorePath = shellPaths.resolveUserPath('tui', 'auth-users.json');
  const bootstrapCredentialPath = shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt');
  const operatorTokenPath = join(runtime.homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  return {
    userStorePath,
    userStorePresent: existsSync(userStorePath),
    bootstrapCredentialPath,
    bootstrapCredentialPresent: existsSync(bootstrapCredentialPath),
    operatorTokenPath,
    operatorTokenPresent: existsSync(operatorTokenPath),
  };
}

export async function runNonInteractiveAgent(runtime: CliCommandRuntime): Promise<number> {
  const prompt = runtime.cli.flags.prompt ?? runtime.cli.positionals.join(' ').trim();
  if (!prompt) {
    console.error('Usage: goodvibes run|exec [prompt]');
    return 2;
  }

  const outputFormat = runtime.cli.flags.outputFormat;
  const ctx = await bootstrapRuntime(process.stdout, {
    configManager: runtime.configManager,
    workingDir: runtime.workingDirectory,
    homeDirectory: runtime.homeDirectory,
  });

  const events: TurnEvent[] = [];
  let finalResponse = '';
  let finalError = '';
  let finalStopReason = '';
  let exitCode = 0;

  const done = new Promise<void>((resolve) => {
    const unsubs = [
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload }) => {
        events.push(payload);
        if (outputFormat === 'stream-json') {
          process.stdout.write(JSON.stringify({ type: payload.type, content: payload.content, accumulated: payload.accumulated }) + '\n');
        }
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => {
        events.push(payload);
        finalResponse = payload.response;
        finalStopReason = payload.stopReason;
        for (const unsub of unsubs) unsub();
        resolve();
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => {
        events.push(payload);
        finalError = payload.error;
        finalStopReason = payload.stopReason;
        exitCode = 1;
        for (const unsub of unsubs) unsub();
        resolve();
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => {
        events.push(payload);
        finalError = payload.reason ?? 'cancelled';
        finalStopReason = payload.stopReason;
        exitCode = 130;
        for (const unsub of unsubs) unsub();
        resolve();
      }),
    ];
  });

  try {
    // Async pre-turn refresh of the memory-spine recall snapshot (SDK 1.2.0
    // full-detach) — see the matching comment in main.ts's submitInput.
    await refreshMemoryRecallSnapshot(ctx.services);
    await ctx.orchestrator.handleUserInput(prompt);
    await done;
    if (outputFormat === 'json') {
      process.stdout.write(JSON.stringify({
        ok: exitCode === 0,
        response: finalResponse,
        error: finalError || undefined,
        stopReason: finalStopReason,
        sessionId: ctx.runtime.sessionId,
        model: ctx.runtime.model,
        provider: ctx.runtime.provider,
        events: events.length,
      }, null, 2) + '\n');
    } else if (outputFormat !== 'stream-json') {
      process.stdout.write((exitCode === 0 ? finalResponse : finalError) + '\n');
    } else {
      process.stdout.write(JSON.stringify({
        type: exitCode === 0 ? 'TURN_COMPLETED' : 'TURN_ERROR',
        ok: exitCode === 0,
        response: finalResponse,
        error: finalError || undefined,
        stopReason: finalStopReason,
      }) + '\n');
    }
  } finally {
    const snapshot = ctx.conversation.toJSON() as Parameters<typeof ctx.shutdown>[0];
    await ctx.shutdown(snapshot);
  }
  return exitCode;
}

/** @deprecated Use ConfigManager directly. Kept for backward compat with management.ts usages. */
export type { GoodVibesConfig };
