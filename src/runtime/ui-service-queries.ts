import type {
  ServiceConfig,
  ServiceConnectionTestResult,
  ServiceInspection,
} from '../config/service-registry.ts';
import type {
  PendingSubscriptionLogin,
  ProviderSubscription,
} from '@pellux/goodvibes-sdk/platform/config/subscriptions';
import type { LocalAuthSnapshot } from '@pellux/goodvibes-sdk/platform/security/user-auth';
import type { SessionInfo } from '@pellux/goodvibes-sdk/platform/sessions/manager';
import type { Tool } from '@pellux/goodvibes-sdk/platform/types/tools';
import type { ModelDefinition } from '@pellux/goodvibes-sdk/platform/providers/registry';
import type {
  ProviderApi,
  ProviderRuntimeSnapshot,
} from '@pellux/goodvibes-sdk/platform/providers/provider-api';
import type { ExecutionPlan } from '@pellux/goodvibes-sdk/platform/core/execution-plan';
import type { PlannerDecision, ExecutionStrategy } from '@pellux/goodvibes-sdk/platform/core/adaptive-planner';

export interface EnvironmentVariableQuery {
  hasEnvironmentVariable(name: string): boolean;
}

export interface ServiceInspectionQuery {
  getAll(): Record<string, ServiceConfig>;
  inspect(name: string): Promise<ServiceInspection | null>;
  testConnection(name: string): Promise<ServiceConnectionTestResult>;
}

export interface SubscriptionAccessQuery {
  list(): ProviderSubscription[];
  listPending(): PendingSubscriptionLogin[];
  get(provider: string): ProviderSubscription | null;
  getPending(provider: string): PendingSubscriptionLogin | null;
  getAccessToken(provider: string): string | null;
  logout(provider: string): void;
}

export interface LocalAuthInspectionQuery {
  inspect(): LocalAuthSnapshot;
}

export interface SessionBrowserQuery {
  list(): SessionInfo[];
  search(query: string): Array<{ session: SessionInfo; matchCount: number; snippets: string[] }>;
  delete(name: string): void;
}

export interface SessionMemoryQuery {
  list(): readonly unknown[];
}

export interface ToolCatalogQuery {
  list(): Tool[];
}

export interface ProviderModelCatalogQuery {
  listModels(): ModelDefinition[];
}

export interface ProviderAccountInspectionQuery {
  readonly providerModels: ProviderModelCatalogQuery;
  readonly services: Pick<ServiceInspectionQuery, 'getAll' | 'inspect'>;
  readonly subscriptions: Pick<SubscriptionAccessQuery, 'list' | 'listPending' | 'get' | 'getPending'>;
  readonly environment: EnvironmentVariableQuery;
}

export interface ProviderRuntimeInspectionQuery {
  listProviderIds(): readonly string[];
  inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]>;
  inspect(providerId: string): Promise<ProviderRuntimeSnapshot | null>;
}

export interface PlanDashboardQuery {
  getActive(): ExecutionPlan | null;
}

export interface OpsStrategyQuery {
  getLatest(): PlannerDecision | null;
  getMode(): ExecutionStrategy;
  getOverride(): ExecutionStrategy | null;
  getHistory(limit?: number): PlannerDecision[];
}

export function createEnvironmentVariableQuery(
  environment: Readonly<Record<string, string | undefined>>,
): EnvironmentVariableQuery {
  return {
    hasEnvironmentVariable(name: string): boolean {
      return Boolean(environment[name]);
    },
  };
}

export function createProviderRuntimeInspectionQuery(
  providers: Pick<ProviderApi, 'listProviderIds' | 'queryRuntimeMetadata'>,
): ProviderRuntimeInspectionQuery {
  return {
    listProviderIds(): readonly string[] {
      return providers.listProviderIds();
    },

    async inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]> {
      const result = await providers.queryRuntimeMetadata({ scope: 'all' });
      return result.scope === 'all' ? result.snapshots : [];
    },

    async inspect(providerId: string): Promise<ProviderRuntimeSnapshot | null> {
      const result = await providers.queryRuntimeMetadata({ scope: 'provider', providerId });
      return result.scope === 'provider' ? result.snapshot : null;
    },
  };
}
