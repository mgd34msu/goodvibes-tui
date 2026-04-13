import type { RuntimeServices } from './services.ts';
import type { RuntimeTask } from './store/domains/tasks.ts';
import type { RuntimeAgent } from './store/domains/agents.ts';
import type { SessionDomainState } from './store/domains/session.ts';
import type { TurnState } from './store/domains/conversation.ts';
import { createStoreBackedReadModel, listProviderIds } from './ui-read-model-helpers.ts';
import type { UiReadModel } from './ui-read-models-base.ts';

export interface UiProvidersSnapshot {
  readonly providerIds: readonly string[];
}

export interface UiSessionSnapshot {
  readonly session: SessionDomainState;
  readonly totalTurns: number;
  readonly messageCount: number;
  readonly estimatedContextTokens: number;
  readonly contextWindow: number;
  readonly turnState: TurnState;
  readonly streamToolPreview?: string;
  readonly contextWarningActive: boolean;
  readonly pendingApproval: boolean;
  readonly denialCount: number;
}

export interface UiAgentsSnapshot {
  readonly active: readonly RuntimeAgent[];
  readonly totalSpawned: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
}

export interface UiTasksSnapshot {
  readonly tasks: readonly RuntimeTask[];
}

export interface UiCoreReadModels {
  readonly providers: UiReadModel<UiProvidersSnapshot>;
  readonly session: UiReadModel<UiSessionSnapshot>;
  readonly agents: UiReadModel<UiAgentsSnapshot>;
  readonly tasks: UiReadModel<UiTasksSnapshot>;
}

export function createCoreReadModels(runtimeServices: RuntimeServices): UiCoreReadModels {
  const { runtimeStore } = runtimeServices;

  return {
    providers: {
      getSnapshot() {
        return {
          providerIds: listProviderIds(runtimeServices),
        };
      },
      subscribe(listener) {
        return runtimeServices.runtimeBus.on('PROVIDERS_CHANGED', listener);
      },
    },
    session: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState();
      return {
        session: state.session,
        totalTurns: state.conversation.totalTurns,
        messageCount: state.conversation.messageCount,
        estimatedContextTokens: state.conversation.estimatedContextTokens,
        contextWindow: state.model.tokenLimits.contextWindow,
        turnState: state.conversation.turnState,
        streamToolPreview: state.conversation.stream.partialToolPreview,
        contextWarningActive: state.conversation.contextWarningActive,
        pendingApproval: state.permissions.awaitingDecision,
        denialCount: state.permissions.denialCount,
      };
    }),
    agents: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().agents;
      const active = state.activeAgentIds
        .map((id) => state.agents.get(id))
        .filter((agent): agent is RuntimeAgent => agent !== undefined);
      return {
        active,
        totalSpawned: state.totalSpawned,
        totalCompleted: state.totalCompleted,
        totalFailed: state.totalFailed,
      };
    }),
    tasks: createStoreBackedReadModel(runtimeServices, () => {
      const tasksState = runtimeStore.getState().tasks;
      const tasks = [...tasksState.tasks.values()].sort((a, b) => {
        const aTime = a.startedAt ?? a.queuedAt;
        const bTime = b.startedAt ?? b.queuedAt;
        return bTime - aTime || a.title.localeCompare(b.title);
      });
      return { tasks };
    }),
  };
}
