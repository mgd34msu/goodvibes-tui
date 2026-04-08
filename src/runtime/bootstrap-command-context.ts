import { configManager, getConfigSnapshot } from '../config/index.ts';
import type { ConversationManager } from '../core/conversation.ts';
import { getPanelManager } from '../panels/panel-manager.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { MutableRuntimeState } from './context.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { PermissionRequestHandler } from '../permissions/prompt.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ForensicsRegistry } from './forensics/index.ts';
import type { PolicyRuntimeState } from './permissions/policy-runtime.ts';
import { FileUndoManager } from '../state/file-undo.ts';
import { logger } from '../utils/logger.ts';
import type { McpRegistry } from '../mcp/registry.ts';
import type { RuntimeStore } from '../runtime/store/index.ts';

export type CreateBootstrapCommandContextOptions = {
  providerRegistry: ProviderRegistry;
  conversation: ConversationManager;
  runtime: MutableRuntimeState;
  requestRender: () => void;
  requestPermission: PermissionRequestHandler;
  toolRegistry: ToolRegistry;
  mcpRegistry: McpRegistry;
  forensicsRegistry: ForensicsRegistry;
  policyRuntimeState: PolicyRuntimeState;
  runtimeStore: RuntimeStore;
  loadSystemPrompt: () => string;
  activatePlan: (planId: string, task: string) => void;
  completeModelSelectionSideEffect?: () => void;
};

function unwiredShellAction(name: string): never {
  const message = `commandContext.${name} was called before the shell bridge was attached in main.ts`;
  logger.error(message);
  throw new Error(message);
}

export function createBootstrapCommandContext(
  options: CreateBootstrapCommandContextOptions,
): CommandContext {
  const {
    providerRegistry,
    conversation,
    runtime,
    requestRender,
    requestPermission,
    toolRegistry,
    mcpRegistry,
    forensicsRegistry,
    policyRuntimeState,
    runtimeStore,
    loadSystemPrompt,
    activatePlan,
    completeModelSelectionSideEffect,
  } = options;

  const showPanel = (panelId: string, pane?: 'top' | 'bottom') => {
    const pm = getPanelManager();
    pm.open(panelId, pane);
    pm.show();
    requestRender();
  };

  const context: CommandContext = {
    providerRegistry,
    conversationManager: conversation,
    config: getConfigSnapshot(),
    configManager,
    runtime,
    renderRequest: requestRender,
    submitInput: () => {
      unwiredShellAction('submitInput');
    },
    executeCommand: async () => {
      return unwiredShellAction('executeCommand');
    },
    cancelGeneration: () => {
      unwiredShellAction('cancelGeneration');
    },
    clearScreen: () => {
      unwiredShellAction('clearScreen');
    },
    activatePlan,
    requestPermission: (request) => requestPermission(request),
    completeModelSelection: ({ model, effort, contextCap }) => {
      if (!model) return;
      const def = model;
      const key = def.registryKey ?? `${def.provider}:${def.id}`;
      try {
        if (contextCap != null && contextCap > 0) {
          providerRegistry.setModelContextCap(key, contextCap);
        }
        providerRegistry.setCurrentModel(key);
        runtime.model = key;
        runtime.provider = def.provider;
        runtime.reasoningEffort = effort as 'instant' | 'low' | 'medium' | 'high';
        configManager.set('provider.model', key);
        configManager.set('provider.provider', def.provider);
        configManager.set('provider.reasoningEffort', effort as 'instant' | 'low' | 'medium' | 'high');
        const ctxNote = contextCap != null && contextCap > 0
          ? `, context cap: ${contextCap.toLocaleString()}`
          : '';
        conversation.log(`Switched to model: ${def.displayName} (${def.provider}), effort: ${effort}${ctxNote}`, { fg: '135' });
      } catch (e) {
        conversation.log(`Error switching model: ${(e as Error).message}`, { fg: '#ef4444' });
      }
      completeModelSelectionSideEffect?.();
      requestRender();
    },
    jumpToBookmark: () => {
      unwiredShellAction('jumpToBookmark');
    },
    scrollToLine: () => {
      unwiredShellAction('scrollToLine');
    },
    print: (text: string) => {
      conversation.log(text, { fg: '252' });
      requestRender();
    },
    exit: () => {
      unwiredShellAction('exit');
    },
    reloadSystemPrompt: loadSystemPrompt,
    showPanel,
    toolRegistry,
    mcpRegistry,
    fileUndoManager: FileUndoManager.getInstance(),
    forensicsRegistry,
    policyRegistry: policyRuntimeState.getRegistry(),
    openForensicsPanel: () => {
      (context.showPanel ?? showPanel)('forensics');
    },
    openIncidentPanel: () => {
      (context.showPanel ?? showPanel)('incident');
    },
    openPolicyPanel: () => {
      (context.showPanel ?? showPanel)('policy');
    },
    openHooksPanel: () => {
      (context.showPanel ?? showPanel)('hooks');
    },
    openCommunicationPanel: () => {
      (context.showPanel ?? showPanel)('communication');
    },
    openOrchestrationPanel: () => {
      (context.showPanel ?? showPanel)('orchestration');
    },
    openCockpitPanel: () => {
      (context.showPanel ?? showPanel)('cockpit');
    },
    openMcpPanel: () => {
      (context.showPanel ?? showPanel)('mcp');
    },
    openSecurityPanel: () => {
      (context.showPanel ?? showPanel)('security');
    },
    openKnowledgePanel: () => {
      (context.showPanel ?? showPanel)('knowledge');
    },
    openRemotePanel: () => {
      (context.showPanel ?? showPanel)('remote');
    },
    openSubscriptionPanel: () => {
      (context.showPanel ?? showPanel)('subscription');
    },
    runtimeStore,
  };

  return context;
}
