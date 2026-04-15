import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import {
  emitTransportConnected,
  emitTransportDisconnected,
  emitTransportInitializing,
  emitTransportTerminalFailure,
  type EmitterContext,
} from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';
import type { HookDispatcher } from '@pellux/goodvibes-sdk/platform/hooks/index';
import type { HookCategory, HookEventPath, HookPhase } from '@pellux/goodvibes-sdk/platform/hooks/types';
import type { ResolvedInboundTlsContext } from '@pellux/goodvibes-sdk/platform/runtime/network/index';

interface DaemonTransportEventsContext {
  readonly runtimeBus: RuntimeEventBus | null;
  readonly hookDispatcher: Pick<HookDispatcher, 'fire'> | null;
  readonly host: string;
  readonly port: number;
  readonly tlsState: () => ResolvedInboundTlsContext | null;
}

export class DaemonTransportEventsHelper {
  constructor(private readonly context: DaemonTransportEventsContext) {}

  transportId(): string {
    return `daemon:http:${this.context.host}:${this.context.port}`;
  }

  transportScheme(): 'http' | 'https' {
    return this.context.tlsState()?.scheme ?? 'http';
  }

  transportEndpoint(): string {
    return `${this.transportScheme()}://${this.context.host}:${this.context.port}`;
  }

  emitterContext(): EmitterContext {
    return {
      sessionId: 'daemon-server',
      traceId: `daemon-server:${this.context.host}:${this.context.port}`,
      source: 'daemon-server',
    };
  }

  emitTransportInitializing(): void {
    if (!this.context.runtimeBus) return;
    emitTransportInitializing(this.context.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      protocol: 'http-daemon',
    });
    void this.fireTransportHook('initializing', {
      transportId: this.transportId(),
      protocol: 'http-daemon',
    });
  }

  emitTransportConnected(): void {
    if (!this.context.runtimeBus) return;
    emitTransportConnected(this.context.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
    void this.fireTransportHook('connected', {
      transportId: this.transportId(),
      endpoint: this.transportEndpoint(),
    });
  }

  emitTransportDisconnected(reason: string, willRetry: boolean): void {
    if (!this.context.runtimeBus) return;
    emitTransportDisconnected(this.context.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
    void this.fireTransportHook('disconnected', {
      transportId: this.transportId(),
      reason,
      willRetry,
    });
  }

  emitTransportTerminalFailure(error: string): void {
    if (!this.context.runtimeBus) return;
    emitTransportTerminalFailure(this.context.runtimeBus, this.emitterContext(), {
      transportId: this.transportId(),
      error,
    });
    void this.fireTransportHook('failed', {
      transportId: this.transportId(),
      error,
    });
  }

  async fireTransportHook(specific: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.context.hookDispatcher) return;
    try {
      await this.context.hookDispatcher.fire({
        path: `Lifecycle:transport:${specific}` as HookEventPath,
        phase: 'Lifecycle' as HookPhase,
        category: 'transport' as HookCategory,
        specific,
        sessionId: 'daemon-server',
        timestamp: Date.now(),
        payload,
      });
    } catch {
      // Hook failures should not break the daemon transport lifecycle.
    }
  }
}
