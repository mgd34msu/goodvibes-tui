import type {
  ServiceConfig,
  ServiceConnectionTestResult,
  ServiceInspection,
} from '../config/service-registry.ts';
import type {
  PendingSubscriptionLogin,
  ProviderSubscription,
} from '../config/subscriptions.ts';
import type { LocalAuthSnapshot } from '../security/user-auth.ts';
import type { SessionInfo } from '../sessions/manager.ts';
import type { Tool } from '../types/tools.ts';
import type { ModelDefinition } from '../providers/registry.ts';
import type {
  ProviderApi,
  ProviderRuntimeSnapshot,
} from '../providers/provider-api.ts';
import type { ExecutionPlan } from '../core/execution-plan.ts';
import type { PlannerDecision, ExecutionStrategy } from '../core/adaptive-planner.ts';

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
